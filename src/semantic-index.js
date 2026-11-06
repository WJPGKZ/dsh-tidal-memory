import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, transaction } from './database.js';
import { memoryContentHash, memorySearchText, requireValue } from './model.js';

const indexable = record => record.layer !== 'L0' &&
  ['active', 'archived', 'superseded', 'completed', 'cancelled'].includes(record.status);
export function semanticChunks(text, size) {
  const characters = [...text], chunks = [];
  const overlap = Math.min(48, Math.floor(size / 8));
  for (let offset = 0; offset < characters.length; offset += size - overlap) {
    chunks.push(characters.slice(offset, offset + size).join(''));
    if (offset + size >= characters.length) break;
  }
  return chunks.length ? chunks : [''];
}

export function clearSemanticFiles(directory) {
  for (const file of ['semantic.sqlite3', 'semantic.sqlite3-wal', 'semantic.sqlite3-shm'])
    rmSync(join(directory, 'indexes', file), { force: true });
}

export class SemanticIndex {
  constructor(store) {
    this.store = store;
    this.db = openDatabase(join(store.directory, 'indexes', 'semantic.sqlite3'));
    try {
      requireValue(this.db.prepare('PRAGMA user_version').get().user_version <= 1,
        'INDEX_VERSION_UNSUPPORTED', '语义索引格式较新，请使用对应版本或明确重建。');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,chunks INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors (id TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,
        PRIMARY KEY(id,part), FOREIGN KEY(id) REFERENCES documents(id) ON DELETE CASCADE);
      PRAGMA user_version=1;
    `); } catch (error) { this.db.close(); throw error; }
    this.queue = Promise.resolve();
    this.state = 'idle';
    this.closed = false;
    this.initialized = false;
    this.dirty = new Set();
  }
  invalidate(record) {
    if (record.layer === 'L0' || this.closed) return;
    const alreadyDirty = this.dirty.has(record.id);
    this.dirty.add(record.id);
    const previous = this.db.prepare('SELECT content_hash FROM documents WHERE id=?').get(record.id);
    if (!indexable(record)) {
      if (previous) this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
      this.dirty.delete(record.id);
    } else if (!previous || previous.content_hash !== memoryContentHash(record)) {
      if (previous)
        this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
    } else if (!alreadyDirty) this.dirty.delete(record.id);
  }
  forget(ids) {
    for (const id of ids) this.dirty.delete(id);
    transaction(this.db, () => { for (const id of ids) this.db.prepare('DELETE FROM documents WHERE id=?').run(id); });
  }
  reconcile(pack) {
    const records = this.store.all().filter(indexable);
    const byId = new Map(records.map(record => [record.id, record]));
    const existing = this.db.prepare(`SELECT id,content_hash,chunks,
      (SELECT count(*) FROM vectors v WHERE v.id=d.id AND length(v.vector)=?) AS present
      FROM documents d`).all(pack.dimension * 4);
    const seen = new Set(), remove = [];
    for (const row of existing) {
      const record = byId.get(row.id);
      if (!record || row.content_hash !== memoryContentHash(record) || row.present !== row.chunks) {
        remove.push(row.id);
        if (record) this.dirty.add(record.id);
      } else {
        seen.add(row.id);
      }
    }
    for (const record of records) if (!seen.has(record.id)) this.dirty.add(record.id);
    if (remove.length) transaction(this.db, () => {
      const removeDocument = this.db.prepare('DELETE FROM documents WHERE id=?');
      for (const id of remove) removeDocument.run(id);
    });
    this.initialized = true;
  }
  sync(embedder, { signal } = {}) {
    const run = async () => {
      requireValue(!this.closed, 'CLOSED', '语义索引已关闭。', 503);
      const modelKey = embedder.key;
      const check = () => {
        requireValue(!signal?.aborted, 'SEMANTIC_CANCELLED', '本地语义准备已取消。', 409);
        requireValue(!this.closed && embedder.key === modelKey, 'MODEL_CHANGED', '索引已关闭或模型已切换。', 409);
      };
      check();
      this.state = 'indexing';
      try {
        const pack = await embedder.ready();
        check();
        if (this.db.prepare("SELECT value FROM metadata WHERE key='model'").get()?.value !== pack.fingerprint) {
          transaction(this.db, () => {
            this.db.exec('DELETE FROM documents');
            this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('model',?)").run(pack.fingerprint);
          });
          this.initialized = false;
          this.dirty.clear();
        }
        if (!this.initialized || (!this.dirty.size && this.status().pending)) this.reconcile(pack);
        let indexed = 0;
        const prepared = [];
        const flush = () => {
          if (!prepared.length) return;
          check();
          const committed = [];
          transaction(this.db, () => {
            const remove = this.db.prepare('DELETE FROM documents WHERE id=?');
            const insertDocument = this.db.prepare('INSERT INTO documents VALUES(?,?,?,?)');
            const insertVector = this.db.prepare('INSERT INTO vectors VALUES(?,?,?)');
            for (const item of prepared) {
              const current = this.store.raw(item.id);
              if (!current || !indexable(current) || memoryContentHash(current) !== item.contentHash) continue;
              remove.run(item.id);
              insertDocument.run(item.id, item.contentHash, current.revision, item.vectors.length);
              item.vectors.forEach((vector, part) => insertVector.run(item.id, part,
                Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)));
              committed.push(item.id);
            }
          });
          for (const id of committed) this.dirty.delete(id);
          indexed += committed.length;
          prepared.length = 0;
        };
        for (const id of [...this.dirty]) {
          check();
          const record = this.store.raw(id);
          if (!record || !indexable(record)) {
            this.db.prepare('DELETE FROM documents WHERE id=?').run(id);
            this.dirty.delete(id);
            continue;
          }
          const contentHash = memoryContentHash(record);
          const chunks = semanticChunks(memorySearchText(record), pack.chunkSize), vectors = [];
          for (let offset = 0; offset < chunks.length; offset += 16) {
            vectors.push(...await embedder.embed(chunks.slice(offset, offset + 16), 'document'));
            check();
          }
          prepared.push({ id, contentHash, vectors });
          if (prepared.length >= 16) flush();
        }
        flush();
        this.state = this.status().pending || this.dirty.size ? 'partial' : 'ready';
        this.error = null;
        return { indexed, fingerprint: pack.fingerprint };
      } catch (error) {
        this.state = error.code === 'SEMANTIC_CANCELLED' ? 'partial' : 'error';
        this.error = error.code === 'SEMANTIC_CANCELLED' ? null :
          { code: error.code ?? 'INDEX_FAILED', message: error.message };
        throw error;
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job;
    return job;
  }
  search(queries, pack, { accept = () => true, limit = 120 } = {}) {
    requireValue(!this.closed && this.db.prepare("SELECT value FROM metadata WHERE key='model'").get()?.value === pack.fingerprint,
      'INDEX_MODEL_MISMATCH', '语义索引与当前模型版本不同，请重建。', 409);
    const scores = new Map(), documents = new Map();
    for (const row of this.db.prepare('SELECT * FROM documents').all()) {
      const record = this.store.raw(row.id);
      if (record && indexable(record) && accept(record) && row.content_hash === memoryContentHash(record))
        documents.set(row.id, { ...row, currentRevision: record.revision });
    }
    for (const row of this.db.prepare('SELECT id,vector FROM vectors').all()) {
      if (!documents.has(row.id)) continue;
      requireValue(row.vector.byteLength === pack.dimension * 4, 'INDEX_INVALID', '本地向量索引损坏，请重建。');
      const vector = new Float32Array(Uint8Array.from(row.vector).buffer);
      requireValue(vector.every(Number.isFinite), 'INDEX_INVALID', '本地向量含非数值，请重建。');
      let score = scores.get(row.id) ?? 0;
      for (const query of queries) {
        let dot = 0;
        for (let i = 0; i < vector.length; i++) dot += vector[i] * query.vector[i];
        score = Math.max(score, Math.min(1, dot) * Math.max(0.8, 1 - query.contextIndex * 0.03));
      }
      scores.set(row.id, score);
    }
    let best = 0;
    for (const score of scores.values()) best = Math.max(best, score);
    const threshold = Math.max(pack.minScore, best * pack.relativeFloor);
    return [...scores].filter(([, score]) => score >= threshold).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit).map(([id, score]) => ({ id, score, contentHash: documents.get(id).content_hash,
        revision: documents.get(id).currentRevision }));
  }
  status() {
    const indexed = this.db.prepare(`SELECT count(*) AS n FROM documents d
      WHERE chunks=(SELECT count(*) FROM vectors v WHERE v.id=d.id)`).get().n;
    let total = 0;
    for (const [layer, db] of this.store.dbs) if (layer !== 'L0') total += db.prepare(
      "SELECT count(*) AS n FROM memories WHERE status IN ('active','archived','superseded','completed','cancelled')").get().n;
    return { state: this.state, indexed, total, pending: Math.max(0, total - indexed),
      fingerprint: this.db.prepare("SELECT value FROM metadata WHERE key='model'").get()?.value ?? null,
      error: this.error ?? null };
  }
  clear() {
    this.db.exec('DELETE FROM documents; DELETE FROM metadata');
    this.dirty.clear();
    this.initialized = false;
    this.state = 'idle';
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
