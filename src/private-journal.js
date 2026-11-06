import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { hash, localDateKey, requireValue, slug, string, timestamp } from './model.js';

export const MAX_PRIVATE_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_PRIVATE_SOURCES = 10000;
const safeTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const safeDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;

function dayBounds(day) {
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(day), 'INVALID_DATE', '私人记录日期无效。');
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year, month - 1, date);
  requireValue(localDateKey(start) === day, 'INVALID_DATE', '私人记录日期无效。');
  return [start.toISOString(), new Date(year, month - 1, date + 1).toISOString()];
}

export function initializePrivateJournal(db) {
  requireValue(db.prepare('PRAGMA user_version').get().user_version <= 2,
    'PRIVATE_VERSION_UNSUPPORTED', '私人记录格式较新，请使用对应版本。');
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, source_ids TEXT NOT NULL
    );`);
    db.exec(`CREATE INDEX IF NOT EXISTS private_author_created ON entries(author,created_at);
      CREATE TABLE IF NOT EXISTS entry_state (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        author TEXT NOT NULL, day_key TEXT NOT NULL, revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(author,day_key)
      );
      CREATE TABLE IF NOT EXISTS entry_aliases (
        alias_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS journal_pending (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS journal_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=2;`);
    db.exec(`DELETE FROM entry_aliases WHERE entry_id NOT IN (SELECT id FROM entries);
      DELETE FROM journal_pending WHERE entry_id NOT IN (SELECT id FROM entries);
      DELETE FROM entry_state WHERE entry_id NOT IN (SELECT id FROM entries);`);
  });
}

function sourcesOf(row) {
  let sources;
  try { sources = JSON.parse(row.source_ids); }
  catch { requireValue(false, 'PRIVATE_METADATA_INVALID', '私人记录来源元数据无效，原文未修改。', 409); }
  requireValue(Array.isArray(sources) && sources.every(id => typeof id === 'string'),
    'PRIVATE_METADATA_INVALID', '私人记录来源元数据无效，原文未修改。', 409);
  return sources;
}

// Called only inside the private database transaction.
function mergeDay(db, author, day, at, { cutoff, windowStart, addition } = {}) {
  const [start, end] = dayBounds(day);
  const select = `SELECT e.rowid AS ordinal,e.*,s.day_key,COALESCE(s.revision,1) AS revision,
    s.updated_at,s.content_hash FROM entries e LEFT JOIN entry_state s ON s.entry_id=e.id`;
  const current = db.prepare(`${select} WHERE s.author=? AND s.day_key=?`).get(author, day);
  const legacy = author === 'legacy-import' ? [] : db.prepare(`${select}
    WHERE e.author=? AND s.entry_id IS NULL AND e.created_at>=? AND e.created_at<?
    AND (? IS NULL OR e.created_at<=?)
    AND (? IS NULL OR e.created_at>=? OR e.id IN (SELECT entry_id FROM journal_pending))
    ORDER BY e.created_at,ordinal`)
    .all(author, start, end, cutoff ?? null, cutoff ?? null, windowStart ?? null, windowStart ?? null);
  if (cutoff && current && (current.updated_at ?? current.created_at) > cutoff) {
    for (const row of legacy) db.prepare('INSERT OR IGNORE INTO journal_pending VALUES(?)').run(row.id);
    return { deferred: legacy.length };
  }
  const rows = [...legacy, ...(current ? [current] : [])]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ordinal - b.ordinal);
  if (!rows.length && !addition) return { deferred: 0 };
  const primary = current ?? rows[0];
  const contents = rows.map(row => row.content);
  if (addition) contents.push(addition.content);
  const content = contents.join('\n\n');
  string(content, '单日私人正文', MAX_PRIVATE_CONTENT_LENGTH);
  requireValue(content.length <= MAX_PRIVATE_CONTENT_LENGTH, 'PRIVATE_CONTENT_LIMIT', '单日日记过长，未追加或修改。', 409);
  const sources = [...new Set([...rows.flatMap(sourcesOf), ...(addition?.sourceIds ?? [])])];
  requireValue(sources.length <= MAX_PRIVATE_SOURCES, 'PRIVATE_SOURCE_LIMIT', '单日日记来源过多，未追加或修改。', 409);
  if (!primary) {
    const id = randomUUID();
    db.prepare('INSERT INTO entries(id,author,content,created_at,source_ids) VALUES(?,?,?,?,?)')
      .run(id, author, content, at, JSON.stringify(sources));
    db.prepare('INSERT INTO entry_state VALUES(?,?,?,?,?,?)').run(id, author, day, 1, at, hash(content));
    return { id, revision: 1, merged: 0, migrated: 0, deferred: 0 };
  }
  if (rows.length === 1 && current && !addition) return { id: current.id, revision: current.revision, merged: 0, migrated: 0, deferred: 0 };
  const revision = primary.revision + 1;
  const removed = rows.filter(row => row.id !== primary.id);
  for (const row of removed) {
    db.prepare('UPDATE entry_aliases SET entry_id=? WHERE entry_id=?').run(primary.id, row.id);
    db.prepare('INSERT OR REPLACE INTO entry_aliases VALUES(?,?)').run(row.id, primary.id);
    db.prepare('DELETE FROM journal_pending WHERE entry_id=?').run(row.id);
    db.prepare('DELETE FROM entries WHERE id=?').run(row.id);
  }
  db.prepare('UPDATE entries SET content=?,source_ids=? WHERE id=?').run(content, JSON.stringify(sources), primary.id);
  db.prepare(`INSERT INTO entry_state VALUES(?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET
    author=excluded.author,day_key=excluded.day_key,revision=excluded.revision,
    updated_at=excluded.updated_at,content_hash=excluded.content_hash`)
    .run(primary.id, author, day, revision, at, hash(content));
  return { id: primary.id, revision, merged: removed.length, migrated: legacy.length, deferred: 0 };
}

export function appendPrivateEntry(db, author, content, sourceIds, now) {
  slug(author);
  string(content, '私人正文', 50000);
  requireValue(content.length <= 50000, 'INVALID_INPUT', '私人正文不能超过 50000 字符。');
  requireValue(Array.isArray(sourceIds) && sourceIds.length <= 40, 'INVALID_SOURCE', '私人记录来源无效。');
  const at = now.toISOString(), day = localDateKey(now);
  return transaction(db, () => {
    const result = mergeDay(db, author, day, at, { addition: { content: content.toWellFormed(), sourceIds } });
    db.prepare('INSERT OR IGNORE INTO journal_pending VALUES(?)').run(result.id);
    return { id: result.id, saved: true, day, revision: result.revision };
  });
}

export function privateJournalStatus(db) {
  const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entry_state'").get();
  if (!hasState) {
    const row = db.prepare('SELECT count(*) AS count,max(created_at) AS lastWritten FROM entries').get();
    return { ...row, lastWritten: safeTime(row.lastWritten), dailyCount: 0, legacyCount: row.count,
      firstDay: null, lastDay: null, organization: null, failure: null };
  }
  const row = db.prepare(`SELECT count(*) AS count,max(COALESCE(s.updated_at,e.created_at)) AS lastWritten,
    count(s.entry_id) AS dailyCount,count(*)-count(s.entry_id) AS legacyCount,min(s.day_key) AS firstDay,max(s.day_key) AS lastDay
    FROM entries e LEFT JOIN entry_state s ON s.entry_id=e.id`).get();
  const metadata = db.prepare("SELECT value FROM journal_metadata WHERE key='last-organization'").get();
  const saved = metadata ? JSON.parse(metadata.value) : null;
  const organization = saved && ['completed', 'partial'].includes(saved.state) &&
    safeTime(saved.from) && safeTime(saved.until) && saved.from <= saved.until &&
    ['inspected', 'updated', 'merged', 'migrated', 'deferred', 'conflicts'].every(key =>
      Number.isSafeInteger(saved[key]) && saved[key] >= 0)
    ? Object.fromEntries(['from', 'until', 'inspected', 'updated', 'merged', 'migrated', 'deferred', 'conflicts', 'state']
      .map(key => [key, saved[key]])) : null;
  const failed = db.prepare("SELECT value FROM journal_metadata WHERE key='last-failure'").get();
  const failureAt = failed && safeTime(failed.value);
  return { ...row, lastWritten: safeTime(row.lastWritten), firstDay: safeDay(row.firstDay),
    lastDay: safeDay(row.lastDay), organization,
    failure: failureAt ? { state: 'failed', at: failureAt, code: 'PRIVATE_ORGANIZATION_FAILED' } : null };
}

export function organizePrivateWindow(db, { from, until, now, beforeCommit } = {}) {
  const start = timestamp(from, '私人整理起点'), end = timestamp(until, '私人整理截止点');
  requireValue(start && end && start <= end, 'INVALID_TIME', '私人整理时间范围无效。');
  const at = (now ?? new Date()).toISOString();
  const groups = new Map();
  const candidates = db.prepare(`SELECT e.id,e.author,e.created_at FROM entries e
    LEFT JOIN entry_state s ON s.entry_id=e.id WHERE s.entry_id IS NULL AND e.author<>'legacy-import'
    AND ((e.created_at>=? AND e.created_at<=?) OR e.id IN (SELECT entry_id FROM journal_pending))
    ORDER BY e.created_at,e.id`).all(start, end);
  for (const item of candidates) {
    if (item.created_at > end) continue;
    const day = localDateKey(new Date(item.created_at));
    groups.set(JSON.stringify([item.author, day]), { author: item.author, day });
  }
  let merged = 0, migrated = 0, deferred = 0;
  const migratedIds = new Set();
  for (const { author, day } of groups.values()) {
    const result = transaction(db, () => mergeDay(db, author, day, at, { cutoff: end, windowStart: start }));
    merged += result.merged ?? 0;
    migrated += result.migrated ?? 0;
    deferred += result.deferred ?? 0;
    if (result.id) migratedIds.add(result.id);
  }
  const rows = db.prepare(`SELECT e.id,e.content,s.revision FROM entries e JOIN entry_state s ON s.entry_id=e.id
    WHERE s.updated_at<=? AND (s.updated_at>=? OR e.id IN (SELECT entry_id FROM journal_pending))
    ORDER BY e.created_at,e.id`).all(end, start);
  for (const id of migratedIds) {
    if (!rows.some(row => row.id === id)) {
      const row = db.prepare('SELECT e.id,e.content,s.revision FROM entries e JOIN entry_state s ON s.entry_id=e.id WHERE e.id=?').get(id);
      if (row) rows.push(row);
    }
  }
  let updated = 0, conflicts = 0;
  for (const row of rows) {
    const organized = row.content.replaceAll('\r\n', '\n');
    if (organized === row.content) {
      db.prepare('DELETE FROM journal_pending WHERE entry_id=?').run(row.id);
      continue;
    }
    beforeCommit?.({ id: row.id, revision: row.revision });
    const changed = transaction(db, () => {
      const result = db.prepare(`UPDATE entry_state SET revision=revision+1,updated_at=?,content_hash=?
        WHERE entry_id=? AND revision=?`).run(at, hash(organized), row.id, row.revision);
      if (result.changes) {
        db.prepare('UPDATE entries SET content=? WHERE id=?').run(organized, row.id);
        db.prepare('DELETE FROM journal_pending WHERE entry_id=?').run(row.id);
      }
      else if (db.prepare('SELECT 1 FROM entries WHERE id=?').get(row.id))
        db.prepare('INSERT OR IGNORE INTO journal_pending VALUES(?)').run(row.id);
      return result.changes;
    });
    if (changed) updated++;
    else conflicts++;
  }
  const summary = { from: start, until: end, inspected: rows.length, updated, merged, migrated, deferred, conflicts,
    state: conflicts || deferred ? 'partial' : 'completed' };
  db.prepare("INSERT OR REPLACE INTO journal_metadata VALUES('last-organization',?)").run(JSON.stringify(summary));
  return summary;
}
