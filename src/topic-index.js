import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, transaction } from './database.js';
import { hash, requireValue } from './model.js';

const kinds = ['topic', 'fact', 'task', 'alias', 'scene'];
const normalize = value => value.toWellFormed().normalize('NFKC').trim().toLowerCase();

export function topicReferences(record) {
  if (record.layer === 'L0') return [];
  const values = [];
  const add = (kind, value, label = value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) return;
    const key = kind === 'topic' || kind === 'alias' ? normalize(value) : value.toWellFormed();
    if (!key) return;
    values.push({ id: `${kind}:${hash(key)}`, kind,
      label: kind === 'scene' ? '同一情景' : kind === 'topic' || kind === 'alias' ? normalize(label) : label });
  };
  for (const topic of record.topics ?? []) add('topic', topic);
  add('fact', record.factKey);
  add('task', record.taskKey);
  for (const alias of record.aliases ?? []) add('alias', alias);
  for (const source of record.sources ?? []) add('scene', source.sceneId);
  return [...new Map(values.map(value => [value.id, value])).values()]
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.id.localeCompare(b.id));
}

export function clearTopicFiles(directory) {
  for (const file of ['topics.sqlite3', 'topics.sqlite3-wal', 'topics.sqlite3-shm'])
    rmSync(join(directory, 'indexes', file), { force: true });
}

export class TopicIndex {
  constructor(store) {
    this.store = store;
    this.db = openDatabase(join(store.directory, 'indexes', 'topics.sqlite3'));
    try {
      requireValue(this.db.prepare('PRAGMA user_version').get().user_version <= 1,
        'TOPIC_INDEX_VERSION', '主题索引格式较新，请使用对应版本或明确重建。');
      this.db.exec(`
        PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, refs_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (topic TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY(topic,id), FOREIGN KEY(id) REFERENCES documents(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS members_by_id ON members(id,topic);
        PRAGMA user_version=1;
      `);
      this.reconcile();
    } catch (error) { this.db.close(); throw error; }
  }
  replace(record, refs = topicReferences(record)) {
    const fingerprint = hash(JSON.stringify(refs));
    if (this.db.prepare('SELECT refs_hash FROM documents WHERE id=?').get(record.id)?.refs_hash === fingerprint) return;
    this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
    this.db.prepare('INSERT INTO documents VALUES(?,?)').run(record.id, fingerprint);
    const insert = this.db.prepare('INSERT INTO members VALUES(?,?)');
    for (const ref of refs) insert.run(ref.id, record.id);
  }
  reconcile() {
    const records = this.store.all().filter(record => record.layer !== 'L0');
    const ids = new Set(records.map(record => record.id));
    transaction(this.db, () => {
      const remove = this.db.prepare('DELETE FROM documents WHERE id=?');
      for (const row of this.db.prepare('SELECT id FROM documents').all()) if (!ids.has(row.id)) remove.run(row.id);
      for (const record of records) this.replace(record);
    });
  }
  invalidate(record) {
    if (record.layer === 'L0') return;
    transaction(this.db, () => this.replace(record));
  }
  forget(ids) {
    transaction(this.db, () => {
      const remove = this.db.prepare('DELETE FROM documents WHERE id=?');
      for (const id of ids) remove.run(id);
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  members(topic) {
    requireValue(typeof topic === 'string' && /^(?:topic|fact|task|alias|scene):[a-f0-9]{64}$/.test(topic),
      'INVALID_TOPIC', '主题入口无效。');
    return this.db.prepare('SELECT id FROM members WHERE topic=? ORDER BY id').all(topic).map(row => row.id);
  }
  close() { this.db.close(); }
}
