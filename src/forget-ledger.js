import { join } from 'node:path';
import { openDatabase, transaction } from './database.js';
import { requireValue } from './model.js';

const safeSessionId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:@-]{1,256}$/.test(value);
const eventNumber = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d{1,16}$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
};

export function sourceEventAnchors(record) {
  const anchors = new Map(), stack = [record?.source, ...(record?.sources ?? [])], seen = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (['session', 'host-tool-receipt'].includes(value.kind) && safeSessionId(value.sessionId)) {
      for (const raw of [value.eventId, ...(value.kind === 'host-tool-receipt' ? [value.callSeq] : [])]) {
        const eventSeq = raw === undefined || raw === null ? null : eventNumber(raw);
        if (eventSeq !== null) anchors.set(JSON.stringify([value.sessionId, eventSeq]),
          { sessionId: value.sessionId, eventSeq });
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  return [...anchors.values()];
}

export function forgottenSourceCoverage(records) {
  const anchors = new Map();
  let unknown = false;
  for (const record of records) {
    const sources = record.sources?.length ? record.sources : [record.source];
    for (const source of sources) {
      const found = sourceEventAnchors({ source });
      if (!found.length) unknown = true;
      for (const anchor of found) anchors.set(JSON.stringify([anchor.sessionId, anchor.eventSeq]), anchor);
    }
  }
  return { events: [...anchors.values()], unknown };
}

export function provenanceReferences(record) {
  const sessions = new Set([record.sessionId]), parents = new Set(record.parents ?? []), scenes = new Set();
  const stack = [record.source, ...(record.sources ?? [])];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (['sessionId', 'sourceSession', 'session_id'].includes(key) && typeof child === 'string') sessions.add(child);
      if (['parentId', 'contextSourceId', 'sourceId', 'taskRef'].includes(key) && typeof child === 'string') parents.add(child);
      if (key === 'sourceIds' && Array.isArray(child)) for (const id of child) if (typeof id === 'string') parents.add(id);
      if (key === 'sceneRef' && typeof child === 'string') scenes.add(child);
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return { sessions, parents, scenes };
}

export function expandForgotten(records, seeds) {
  const children = new Map();
  for (const record of records) for (const parent of provenanceReferences(record).parents) {
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
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      requireValue(version <= 2,
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
        CREATE TABLE IF NOT EXISTS source_events (lineage TEXT NOT NULL, session_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL, PRIMARY KEY(lineage,session_id,event_seq));
        CREATE TABLE IF NOT EXISTS unknown_source_coverage (lineage TEXT PRIMARY KEY);
      `);
      if (version < 2) transaction(this.db, () => {
        this.db.exec(`INSERT OR IGNORE INTO unknown_source_coverage(lineage)
          SELECT lineage FROM tombstones UNION SELECT lineage FROM forgotten_keys;
          PRAGMA user_version=2;`);
      });
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
  merge(lineage, markers = [], keys = [], privateIds = [], { events = [], unknown = false, known = false } = {}) {
    this.db.prepare('INSERT OR IGNORE INTO lineages(id) VALUES(?)').run(lineage);
    const marker = this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?)');
    const key = this.db.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?,?)');
    const privateId = this.db.prepare('INSERT OR IGNORE INTO private_ids VALUES(?,?)');
    const event = this.db.prepare('INSERT OR IGNORE INTO source_events VALUES(?,?,?)');
    let changed = 0, ordinaryChanged = 0;
    for (const row of markers) ordinaryChanged += marker.run(lineage, row.id, row.dedupe_key).changes;
    for (const value of keys) ordinaryChanged += key.run(lineage, value).changes;
    changed += ordinaryChanged;
    for (const id of privateIds) changed += privateId.run(lineage, id).changes;
    for (const anchor of events) {
      requireValue(safeSessionId(anchor?.sessionId) && Number.isSafeInteger(anchor.eventSeq) && anchor.eventSeq >= 0,
        'INVALID_FORGET_SOURCE', '遗忘来源事件标记无效。');
      changed += event.run(lineage, anchor.sessionId, anchor.eventSeq).changes;
    }
    if (unknown || !known && ordinaryChanged)
      changed += this.db.prepare('INSERT OR IGNORE INTO unknown_source_coverage VALUES(?)').run(lineage).changes;
    if (changed) this.db.prepare('UPDATE lineages SET revision=revision+1 WHERE id=?').run(lineage);
  }
  add(lineage, markers, keys, coverage = {}) {
    transaction(this.db, () => this.merge(lineage, markers, keys, [], coverage));
  }
  state(lineage) {
    return {
      tombstones: this.db.prepare('SELECT id,dedupe_key FROM tombstones WHERE lineage=?').all(lineage),
      forgottenKeys: this.db.prepare('SELECT dedupe_key FROM forgotten_keys WHERE lineage=?').all(lineage)
        .map(row => row.dedupe_key),
      privateIds: this.db.prepare('SELECT id FROM private_ids WHERE lineage=?').all(lineage).map(row => row.id),
      eventAnchors: this.db.prepare(`SELECT session_id AS sessionId,event_seq AS eventSeq FROM source_events
        WHERE lineage=? ORDER BY session_id,event_seq`).all(lineage),
      unknownEventCoverage: Boolean(this.db.prepare('SELECT 1 FROM unknown_source_coverage WHERE lineage=?').get(lineage)),
    };
  }
  addPrivate(lineage, ids) {
    transaction(this.db, () => this.merge(lineage, [], [], ids));
  }
  publishRestore(name, lineage, expectedVersion, markers, keys, privateIds, publish, coverage = {}) {
    transaction(this.db, () => {
      requireValue(this.version(lineage) === expectedVersion, 'FORGET_CONFLICT',
        '恢复期间遗忘标记发生变化，请重试；未发布恢复空间。', 409);
      this.merge(lineage, markers, keys, privateIds, coverage);
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
  hasEvent(lineage, sessionId, eventSeq) {
    return Boolean(this.db.prepare('SELECT 1 FROM source_events WHERE lineage=? AND session_id=? AND event_seq=?')
      .get(lineage, sessionId, eventSeq));
  }
  hasUnknownEventCoverage(lineage) {
    return Boolean(this.db.prepare('SELECT 1 FROM unknown_source_coverage WHERE lineage=?').get(lineage));
  }
  close() { this.db.close(); }
}
