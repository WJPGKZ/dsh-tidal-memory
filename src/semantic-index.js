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
  }
  invalidate(record) {
    if (record.layer === 'L0' || this.closed) return;
    const previous = this.db.prepare('SELECT content_hash FROM documents WHERE id=?').get(record.id);
    if (!previous) return;
    if (!indexable(record) || previous.content_hash !== memoryContentHash(record))
      this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
    else this.db.prepare('UPDATE documents SET revision=? WHERE id=?').run(record.revision, record.id);
  }
  forget(ids) {
    transaction(this.db, () => { for (const id of ids) this.db.prepare('DELETE FROM documents WHERE id=?').run(id); });
  }
  sync(embedder) {
    const run = async () => {
      requireValue(!this.closed, 'CLOSED', '语义索引已关闭。', 503);
      this.state = 'indexing';
      try {
        const modelKey = embedder.key;
        const pack = await embedder.ready();
        requireValue(embedder.key === modelKey, 'MODEL_CHANGED', '索引模型已切换，请重试。', 409);
        if (this.db.prepare("SELECT value FROM metadata WHERE key='model'").get()?.value !== pack.fingerprint) {
          transaction(this.db, () => {
            this.db.exec('DELETE FROM documents');
            this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('model',?)").run(pack.fingerprint);
          });
        }
        const records = this.store.all().filter(indexable);
        this.db.prepare('DELETE FROM documents WHERE id NOT IN (SELECT value FROM json_each(?))')
          .run(JSON.stringify(records.map(record => record.id)));
        let indexed = 0;
        for (const record of records) {
          requireValue(!this.closed && embedder.key === modelKey, 'MODEL_CHANGED', '索引已关闭或模型已切换。', 409);
          const contentHash = memoryContentHash(record);
          const previous = this.db.prepare(`SELECT content_hash,chunks,
            (SELECT count(*) FROM vectors v WHERE v.id=d.id AND length(v.vector)=?) AS present
            FROM documents d WHERE id=?`).get(pack.dimension * 4, record.id);
          if (previous?.content_hash === contentHash && previous.present === previous.chunks) { this.invalidate(record); continue; }
          const chunks = semanticChunks(memorySearchText(record), pack.chunkSize), vectors = [];
          for (let offset = 0; offset < chunks.length; offset += 16)
            vectors.push(...await embedder.embed(chunks.slice(offset, offset + 16), 'document'));
          requireValue(!this.closed && embedder.key === modelKey, 'MODEL_CHANGED', '索引已关闭或模型已切换。', 409);
          const current = this.store.raw(record.id);
          if (!current || !indexable(current) || memoryContentHash(current) !== contentHash) continue;
          transaction(this.db, () => {
            this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
            this.db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(record.id, contentHash, current.revision, chunks.length);
            const insert = this.db.prepare('INSERT INTO vectors VALUES(?,?,?)');
            vectors.forEach((vector, part) => insert.run(record.id, part,
              Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)));
          });
          indexed++;
        }
        this.state = this.status().pending ? 'partial' : 'ready';
        this.error = null;
        return { indexed, fingerprint: pack.fingerprint };
      } catch (error) {
        this.state = 'error';
        this.error = { code: error.code ?? 'INDEX_FAILED', message: error.message };
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
      if (record && indexable(record) && accept(record) && row.content_hash === memoryContentHash(record) &&
        row.revision === record.revision) documents.set(row.id, row);
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
        revision: documents.get(id).revision }));
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
  clear() { this.db.exec('DELETE FROM documents; DELETE FROM metadata'); this.state = 'idle'; }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
