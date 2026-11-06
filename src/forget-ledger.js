import { join } from 'node:path';
import { openDatabase, transaction } from './database.js';
import { requireValue } from './model.js';

export function expandForgotten(records, seeds) {
  const children = new Map();
  for (const record of records) for (const parent of record.parents) {
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(record.id);
  }
  const result = new Set(seeds), queue = [...result];
  for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]) ?? []) {
    if (result.has(child)) continue;
    result.add(child);
    queue.push(child);
  }
  return result;
}

export class ForgetLedger {
  constructor(root) {
    this.db = openDatabase(join(root, 'system', 'forget-ledger.sqlite3'));
    try {
      requireValue(this.db.prepare('PRAGMA user_version').get().user_version <= 1,
        'FORGET_LEDGER_VERSION', '遗忘标记格式较新，请使用对应版本打开。');
      this.db.exec(`
        PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS lineages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS spaces (name TEXT PRIMARY KEY, lineage TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tombstones (lineage TEXT NOT NULL, id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
          PRIMARY KEY(lineage,id,dedupe_key));
        CREATE INDEX IF NOT EXISTS tombstones_by_key ON tombstones(lineage,dedupe_key);
        CREATE TABLE IF NOT EXISTS forgotten_keys (lineage TEXT NOT NULL, dedupe_key TEXT NOT NULL,
          PRIMARY KEY(lineage,dedupe_key));
        CREATE TABLE IF NOT EXISTS private_ids (lineage TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(lineage,id));
        PRAGMA user_version=1;
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  lineageFor(name) { return this.db.prepare('SELECT lineage FROM spaces WHERE name=?').get(name)?.lineage ?? null; }
  hasLineage(lineage) { return Boolean(this.db.prepare('SELECT 1 FROM lineages WHERE id=?').get(lineage)); }
  register(name, lineage) {
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO lineages(id) VALUES(?)').run(lineage);
      this.db.prepare('INSERT OR REPLACE INTO spaces(name,lineage) VALUES(?,?)').run(name, lineage);
    });
  }
  merge(lineage, markers = [], keys = [], privateIds = []) {
    this.db.prepare('INSERT OR IGNORE INTO lineages(id) VALUES(?)').run(lineage);
    const marker = this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?)');
    const key = this.db.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?,?)');
    const privateId = this.db.prepare('INSERT OR IGNORE INTO private_ids VALUES(?,?)');
    let changed = 0;
    for (const row of markers) changed += marker.run(lineage, row.id, row.dedupe_key).changes;
    for (const value of keys) changed += key.run(lineage, value).changes;
    for (const id of privateIds) changed += privateId.run(lineage, id).changes;
    if (changed) this.db.prepare('UPDATE lineages SET revision=revision+1 WHERE id=?').run(lineage);
  }
  add(lineage, markers, keys) {
    transaction(this.db, () => this.merge(lineage, markers, keys));
  }
  state(lineage) {
    return {
      tombstones: this.db.prepare('SELECT id,dedupe_key FROM tombstones WHERE lineage=?').all(lineage),
      forgottenKeys: this.db.prepare('SELECT dedupe_key FROM forgotten_keys WHERE lineage=?').all(lineage)
        .map(row => row.dedupe_key),
      privateIds: this.db.prepare('SELECT id FROM private_ids WHERE lineage=?').all(lineage).map(row => row.id),
    };
  }
  addPrivate(lineage, ids) {
    transaction(this.db, () => this.merge(lineage, [], [], ids));
  }
  publishRestore(name, lineage, expectedVersion, markers, keys, privateIds, publish) {
    transaction(this.db, () => {
      requireValue(this.version(lineage) === expectedVersion, 'FORGET_CONFLICT',
        '恢复期间遗忘标记发生变化，请重试；未发布恢复空间。', 409);
      this.merge(lineage, markers, keys, privateIds);
      this.db.prepare('INSERT OR REPLACE INTO spaces(name,lineage) VALUES(?,?)').run(name, lineage);
      publish();
    });
  }
  version(lineage) { return this.db.prepare('SELECT revision FROM lineages WHERE id=?').get(lineage)?.revision ?? 0; }
  has(lineage, record) {
    return Boolean(this.db.prepare(`SELECT 1 FROM tombstones WHERE lineage=? AND (id=? OR dedupe_key=?)
      UNION ALL SELECT 1 FROM forgotten_keys WHERE lineage=? AND dedupe_key=? LIMIT 1`)
      .get(lineage, record.id, record.dedupeKey, lineage, record.dedupeKey));
  }
  close() { this.db.close(); }
}
