import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { openDatabase, transaction } from './database.js';
import { hash, MemoryError, requireValue } from './model.js';
import { topicReferences } from './topic-index.js';

const REFERENCE_LIMIT = 128;
const PARENT_LIMIT = 128;
const BATCH_SIZE = 100;
const ordinaryLayers = ['L1', 'L2', 'L3'];
const normalize = value => value.toWellFormed().normalize('NFKC').trim().toLowerCase();

export function graphReferences(record) {
  if (record.layer === 'L0') return [];
  const refs = topicReferences(record);
  for (const tag of record.tags ?? []) {
    const label = normalize(tag);
    if (label) refs.push({ id: `tag:${hash(label)}`, kind: 'tag', label });
  }
  const order = ['topic', 'tag', 'fact', 'task', 'alias', 'scene'];
  return [...new Map(refs.map(ref => [ref.id, ref])).values()]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id))
    .slice(0, REFERENCE_LIMIT);
}

export function graphDecisionHash(record) {
  return hash(JSON.stringify([record.layer, record.text, record.claim, record.factKey, record.taskKey,
    record.validFrom, record.validUntil]));
}

export function graphPair(left, right) {
  return left < right ? [left, right] : [right, left];
}

export function clearGraphFiles(directory) {
  for (const file of ['graph.sqlite3', 'graph.sqlite3-wal', 'graph.sqlite3-shm'])
    rmSync(join(directory, 'indexes', file), { force: true });
}

export class GraphIndex {
  constructor(store) {
    this.store = store;
    this.db = openDatabase(join(store.directory, 'indexes', 'graph.sqlite3'));
    try {
      requireValue(this.db.prepare('PRAGMA user_version').get().user_version <= 1,
        'GRAPH_INDEX_VERSION', '图谱索引格式较新，请使用对应版本或明确重建。');
      this.db.exec(`
        PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (ref TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY(ref,id), FOREIGN KEY(id) REFERENCES documents(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS graph_members_by_id ON members(id,ref);
        CREATE TABLE IF NOT EXISTS parents (child TEXT NOT NULL, parent TEXT NOT NULL,
          PRIMARY KEY(child,parent), FOREIGN KEY(child) REFERENCES documents(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS graph_parents_by_parent ON parents(parent,child);
        PRAGMA user_version=1;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.state = 'unprepared';
    this.progress = { phase: 'waiting', scanned: 0 };
    this.resume = null;
    this.error = null;
    this.closed = false;
  }

  replace(record) {
    if (record.layer === 'L0') return;
    const refs = graphReferences(record);
    const parents = [...new Set(record.parents ?? [])].sort().slice(0, PARENT_LIMIT);
    const fingerprint = hash(JSON.stringify([record.layer, refs.map(ref => ref.id), parents]));
    if (this.db.prepare('SELECT fingerprint FROM documents WHERE id=?').get(record.id)?.fingerprint === fingerprint) return;
    this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
    this.db.prepare('INSERT INTO documents VALUES(?,?)').run(record.id, fingerprint);
    const member = this.db.prepare('INSERT INTO members VALUES(?,?)');
    const parent = this.db.prepare('INSERT INTO parents VALUES(?,?)');
    for (const ref of refs) member.run(ref.id, record.id);
    for (const id of parents) parent.run(record.id, id);
  }

  invalidate(record) {
    if (record.layer === 'L0' || this.closed) return;
    transaction(this.db, () => this.replace(record));
  }

  fail(error) {
    this.state = 'error';
    this.error = { code: error.code ?? 'GRAPH_INDEX_FAILED',
      message: '图谱索引不可用，请在记忆图谱中重建；原始记忆和普通召回不受影响。' };
  }

  forget(ids) {
    transaction(this.db, () => {
      const document = this.db.prepare('DELETE FROM documents WHERE id=?');
      const parent = this.db.prepare('DELETE FROM parents WHERE parent=?');
      for (const id of ids) { document.run(id); parent.run(id); }
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  async sync({ signal, shouldPause = () => false } = {}) {
    requireValue(!this.closed && this.state !== 'building', 'GRAPH_BUSY', '图谱正在建立或已关闭。', 409);
    requireValue(this.state !== 'error', 'GRAPH_INDEX_FAILED', '图谱索引更新失败，请重建。', 503);
    this.state = 'building';
    this.error = null;
    if (!this.resume) {
      this.resume = { phase: 'records', layer: 0, cursor: '' };
      this.progress = { phase: 'records', scanned: 0 };
    } else this.progress.phase = this.resume.phase;
    const check = () => {
      if (this.closed || signal?.aborted || shouldPause())
        throw new MemoryError('GRAPH_PAUSED', '图谱建立已让出，将在空闲时继续。', 409);
      requireValue(this.state !== 'error', 'GRAPH_INDEX_FAILED', '图谱索引更新失败，请重建。', 503);
      this.store.reconcileForgetLedger();
    };
    try {
      await yieldTurn();
      while (this.resume.phase === 'records') {
        check();
        const layer = ordinaryLayers[this.resume.layer];
        const rows = this.store.db(layer).prepare('SELECT id FROM memories WHERE id>? ORDER BY id LIMIT ?')
          .all(this.resume.cursor, BATCH_SIZE);
        if (!rows.length) {
          this.resume.layer++;
          this.resume.cursor = '';
          if (this.resume.layer === ordinaryLayers.length) {
            this.resume.phase = 'cleanup';
            this.progress.phase = 'cleanup';
          }
          continue;
        }
        transaction(this.db, () => {
          for (const row of rows) {
            const record = this.store.rawOrdinary(row.id);
            if (record && !this.store.isForgotten(record)) this.replace(record);
          }
        });
        this.resume.cursor = rows.at(-1).id;
        this.progress.scanned += rows.length;
        await yieldTurn();
      }
      for (;;) {
        check();
        const rows = this.db.prepare('SELECT id FROM documents WHERE id>? ORDER BY id LIMIT ?')
          .all(this.resume.cursor, BATCH_SIZE);
        if (!rows.length) break;
        transaction(this.db, () => {
          const remove = this.db.prepare('DELETE FROM documents WHERE id=?');
          const removeParent = this.db.prepare('DELETE FROM parents WHERE parent=?');
          for (const row of rows) {
            const record = this.store.rawOrdinary(row.id);
            if (!record || this.store.isForgotten(record)) { remove.run(row.id); removeParent.run(row.id); }
          }
        });
        this.resume.cursor = rows.at(-1).id;
        await yieldTurn();
      }
      check();
      this.state = 'ready';
      this.progress.phase = 'ready';
      this.resume = null;
      return this.status();
    } catch (error) {
      if (error.code === 'GRAPH_PAUSED') {
        this.state = 'partial';
        this.progress.phase = 'paused';
      } else this.fail(error);
      throw error;
    }
  }

  candidates(record, { cursor = '', limit = 100 } = {}) {
    requireValue(!this.closed && this.state !== 'error', 'GRAPH_INDEX_FAILED',
      '图谱索引不可用，请重建。', 503);
    const candidates = new Map();
    const add = (id, reason) => {
      if (id === record.id) return;
      if (!candidates.has(id)) candidates.set(id, []);
      candidates.get(id).push(reason);
    };
    const count = limit + 1;
    for (const row of this.db.prepare('SELECT parent AS id FROM parents WHERE child=? AND parent>? ORDER BY parent LIMIT ?')
      .all(record.id, cursor, count)) add(row.id, { kind: 'source', id: null, label: '来源关联' });
    for (const row of this.db.prepare('SELECT child AS id FROM parents WHERE parent=? AND child>? ORDER BY child LIMIT ?')
      .all(record.id, cursor, count)) add(row.id, { kind: 'source', id: null, label: '来源关联' });
    const members = this.db.prepare('SELECT id FROM members WHERE ref=? AND id>? ORDER BY id LIMIT ?');
    for (const ref of graphReferences(record)) {
      for (const row of members.all(ref.id, cursor, count)) add(row.id, ref);
    }
    const decisions = this.store.system.prepare('SELECT right_id AS id FROM graph_relations WHERE left_id=? AND right_id>? ORDER BY right_id LIMIT ?');
    const reverse = this.store.system.prepare('SELECT left_id AS id FROM graph_relations WHERE right_id=? AND left_id>? ORDER BY left_id LIMIT ?');
    for (const row of decisions.all(record.id, cursor, count)) add(row.id, { kind: 'manual', id: null, label: '人工修正' });
    for (const row of reverse.all(record.id, cursor, count)) add(row.id, { kind: 'manual', id: null, label: '人工修正' });
    const ids = [...candidates.keys()].sort();
    const page = ids.slice(0, limit);
    return { items: page.map(id => ({ id, reasons: candidates.get(id) })),
      nextCursor: ids.length > limit ? page.at(-1) : null };
  }

  status() {
    return { state: this.state, progress: { ...this.progress },
      indexed: this.db.prepare('SELECT count(*) AS n FROM documents').get().n,
      referenceLimit: REFERENCE_LIMIT, parentLimit: PARENT_LIMIT, error: this.error };
  }

  close() {
    if (!this.closed) { this.closed = true; this.db.close(); }
  }
}
