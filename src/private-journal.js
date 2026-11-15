import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localDateKey, requireValue, slug, timestamp } from './model.js';
import { openDatabase, transaction } from './database.js';
import {
  dailyJournalPath, journalFileHash, listJournalFiles, publishJournalFile,
  readJournalFile, removeJournalFile, stageJournalFile, migrateJournalStaging,
  privateJournalDatabasePath, removeEmptyJournalDirectories
} from './journal-files.js';

export const MAX_PRIVATE_CONTENT_LENGTH = 50_000;
const MAX_DAY_BYTES = 2 * 1024 * 1024;
const FORMAT_VERSION = 7;
const safeTime = value => {
  try { return timestamp(value, '私人记录时间'); }
  catch { return null; }
};

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db, table) {
  return tableExists(db, table) ? db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name) : [];
}

function safeDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function originalJournalDay(content, filename = '') {
  const filenameDay = /(?:^|[\\/])[^\\/]*?(\d{4}-\d{2}-\d{2})(?!\d)[^\\/]*\.(?:md|markdown|txt)$/i.exec(filename)?.[1];
  if (safeDay(filenameDay)) return filenameDay;
  const firstLine = content.trimStart().split(/\r?\n/, 1)[0];
  const provenance = /^【旧日记原件[:：].*?(\d{4}-\d{2}-\d{2})(?!\d)[^\\/]*\.md(?:.*)】$/.exec(firstLine)?.[1];
  if (safeDay(provenance)) return provenance;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.trimStart())?.[1];
  const field = frontmatter && /^(?:date|day):\s*["']?(\d{4}-\d{2}-\d{2})(?:["']?\s*)$/m.exec(frontmatter)?.[1];
  if (safeDay(field)) return field;
  const heading = /^#{1,6}\s+[^\r\n]*?(\d{4}-\d{2}-\d{2})(?!\d)/.exec(content.trimStart())?.[1];
  return safeDay(heading);
}

function archiveDay(createdAt) {
  const created = safeTime(createdAt);
  requireValue(created, 'JOURNAL_DATE_REQUIRED', '旧日记缺少可用的原日期和归档时间，原件已保留，请补充日期。', 409);
  return localDateKey(new Date(created));
}

function authorLabel(value) {
  return String(value || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 128);
}

function contributionBlock(entry) {
  const id = String(entry.id);
  const timestamp = safeTime(entry.created_at) || 'unknown time';
  const contentHash = journalFileHash(String(entry.content ?? ''));
  const dateNote = entry.archiveDateOnly ? ' · 原日期未知，按导入日期归档' : '';
  return `<!-- tidal-entry:${id} sha256:${contentHash} -->\n### ${timestamp} · ${authorLabel(entry.author)}${dateNote}\n\n${entry.content}\n<!-- /tidal-entry:${id} -->`;
}

function newDayDocument(day) {
  return `# ${day}\n\n## 待整理贡献\n\n`;
}

function appendContribution(existing, day, entry) {
  const block = `${contributionBlock(entry)}\n\n`;
  if (existing === null) return `${newDayDocument(day)}${block}`;
  const organizedAt = existing.indexOf('<!-- tidal-organized:start -->');
  if (organizedAt < 0) return `${existing.endsWith('\n') ? existing : `${existing}\n`}${block}`;
  return `${existing.slice(0, organizedAt)}${block}${existing.slice(organizedAt)}`;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      source_session TEXT,
      day_key TEXT,
      relative_path TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_created_at ON entries(created_at);
    CREATE INDEX IF NOT EXISTS entries_day_key ON entries(day_key);
    CREATE TABLE IF NOT EXISTS entry_aliases (
      alias_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS journal_pending (
      entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_days (
      day_key TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tombstones (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_transactions (
      operation_id TEXT PRIMARY KEY,
      entry_id TEXT,
      day_key TEXT,
      relative_path TEXT NOT NULL,
      temporary_path TEXT NOT NULL,
      old_hash TEXT,
      new_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_observations (
      day_key TEXT NOT NULL, content_hash TEXT NOT NULL, segment_index INTEGER NOT NULL,
      segment_count INTEGER NOT NULL, session_id TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY(day_key,content_hash,segment_index,session_id,provider,model)
    );
    CREATE TABLE IF NOT EXISTS journal_organized (
      day_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, output_hash TEXT NOT NULL,
      session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.exec(`PRAGMA user_version=${FORMAT_VERSION}`);
}

function upgradeJournalSchema(db) {
  const entryColumns = tableColumns(db, 'entries');
  if (!entryColumns.includes('source_session')) db.exec('ALTER TABLE entries ADD COLUMN source_session TEXT');
  if (!tableExists(db, 'journal_transactions')) return;
  const entryId = db.prepare('PRAGMA table_info(journal_transactions)').all().find(column => column.name === 'entry_id');
  if (entryId?.notnull) transaction(db, () => {
    db.exec(`
      ALTER TABLE journal_transactions RENAME TO journal_transactions_v4;
      CREATE TABLE journal_transactions (
        operation_id TEXT PRIMARY KEY, entry_id TEXT, day_key TEXT, relative_path TEXT NOT NULL,
        temporary_path TEXT NOT NULL, old_hash TEXT, new_hash TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO journal_transactions SELECT * FROM journal_transactions_v4;
      DROP TABLE journal_transactions_v4;
    `);
  });
  if (tableExists(db, 'journal_observations')) {
    const primaryKey = db.prepare('PRAGMA table_info(journal_observations)').all()
      .filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (!['day_key', 'content_hash', 'segment_index', 'session_id', 'provider', 'model']
      .every(column => primaryKey.includes(column))) transaction(db, () => {
      db.exec(`
        ALTER TABLE journal_observations RENAME TO journal_observations_v6;
        CREATE TABLE journal_observations (
          day_key TEXT NOT NULL, content_hash TEXT NOT NULL, segment_index INTEGER NOT NULL,
          segment_count INTEGER NOT NULL, session_id TEXT NOT NULL, provider TEXT NOT NULL,
          model TEXT NOT NULL, observed_at TEXT NOT NULL,
          PRIMARY KEY(day_key,content_hash,segment_index,session_id,provider,model)
        );
        INSERT OR IGNORE INTO journal_observations SELECT * FROM journal_observations_v6;
        DROP TABLE journal_observations_v6;
      `);
    });
  }
}

function markdownForLegacy(entries, day) {
  const ordered = [...entries].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  return `${newDayDocument(day)}${ordered.map(entry => `${contributionBlock(entry)}\n\n`).join('')}`;
}

function migrateLegacyJournal(db, root) {
  const rows = db.prepare('SELECT * FROM entries').all();
  const states = tableExists(db, 'entry_state')
    ? new Map(db.prepare('SELECT * FROM entry_state').all().map(row => [row.entry_id, row])) : new Map();
  const legacyAliases = tableExists(db, 'entry_aliases') ? db.prepare('SELECT * FROM entry_aliases').all() : [];
  const legacyPending = tableExists(db, 'journal_pending') ? db.prepare('SELECT * FROM journal_pending').all() : [];
  const legacyMetadata = tableExists(db, 'journal_metadata') ? db.prepare('SELECT * FROM journal_metadata').all() : [];
  const legacyTombstones = tableExists(db, 'private_tombstones') ? db.prepare('SELECT * FROM private_tombstones').all() : [];
  const groups = new Map();
  const migrated = rows.map(row => {
    const state = states.get(row.id);
    const originalDay = safeDay(state?.day_key) || (row.author === 'legacy-import' ? originalJournalDay(row.content) : null);
    const day = originalDay || archiveDay(row.created_at);
    const path = dailyJournalPath(day);
    const entry = {
      ...row,
      archiveDateOnly: row.author === 'legacy-import' && !originalDay,
      day_key: day,
      relative_path: path,
      revision: Math.max(1, Number(state?.revision) || 1),
      content_hash: journalFileHash(String(row.content ?? ''))
    };
    if (!groups.has(path)) groups.set(path, { day, entries: [] });
    groups.get(path).entries.push(entry);
    return entry;
  });

  const documents = [];
  for (const [path, group] of groups) {
    const content = group.day
      ? markdownForLegacy(group.entries, group.day)
      : `${group.entries.map(entry => `${contributionBlock(entry)}\n\n`).join('')}`;
    documents.push({ path, content, day: group.day, entries: group.entries });
  }
  for (const document of documents) {
    const existing = readJournalFile(root, document.path);
    if (existing !== null && existing !== document.content)
      requireValue(false, 'JOURNAL_MIGRATION_CONFLICT', '已有 Markdown 日记与旧记录冲突；迁移已停止，旧数据未删除。', 409);
    if (existing === null) {
      const staged = stageJournalFile(root, document.path, document.content);
      publishJournalFile(root, staged);
    }
  }

  db.exec('PRAGMA foreign_keys=OFF');
  const migrate = () => transaction(db, () => {
    db.exec(`
      DROP TABLE IF EXISTS journal_transactions;
      DROP TABLE IF EXISTS journal_operations;
      DROP TABLE IF EXISTS journal_pending;
      DROP TABLE IF EXISTS entry_aliases;
      DROP TABLE IF EXISTS entry_state;
      DROP TABLE IF EXISTS journal_days;
      DROP TABLE IF EXISTS journal_observations;
      DROP TABLE IF EXISTS journal_organized;
      DROP TABLE IF EXISTS journal_metadata;
      DROP TABLE IF EXISTS private_tombstones;
      DROP TABLE IF EXISTS entries;
    `);
    createSchema(db);
    const insertEntry = db.prepare(`INSERT INTO entries
      (id, author, created_at, source_ids, day_key, relative_path, revision, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of migrated) {
      insertEntry.run(row.id, row.author, row.created_at, row.source_ids || '[]',
        row.day_key, row.relative_path, row.revision, row.content_hash);
    }
    const insertAlias = db.prepare('INSERT OR IGNORE INTO entry_aliases(alias_id, entry_id) VALUES (?, ?)');
    for (const row of legacyAliases) insertAlias.run(row.alias_id, row.entry_id);
    const insertPending = db.prepare('INSERT OR IGNORE INTO journal_pending(entry_id, state, updated_at) VALUES (?, ?, ?)');
    for (const row of legacyPending)
      insertPending.run(row.entry_id, row.state ?? 'pending', row.updated_at || new Date().toISOString());
    const insertMetadata = db.prepare('INSERT OR REPLACE INTO journal_metadata(key, value) VALUES (?, ?)');
    for (const row of legacyMetadata) insertMetadata.run(row.key, row.value);
    const insertTombstone = db.prepare('INSERT OR IGNORE INTO private_tombstones(id, kind, created_at) VALUES (?, ?, ?)');
    for (const row of legacyTombstones)
      insertTombstone.run(row.id, row.kind ?? 'forgotten', row.created_at ?? new Date().toISOString());
    const insertDay = db.prepare(`INSERT INTO journal_days(day_key, relative_path, revision, updated_at, content_hash)
      VALUES (?, ?, ?, ?, ?)`);
    for (const document of documents) {
      if (!document.day) continue;
      const revision = Math.max(1, ...document.entries.map(entry => entry.revision));
      insertDay.run(document.day, document.path, revision, new Date().toISOString(), journalFileHash(document.content));
    }
    insertMetadata.run('format', 'markdown-v1');
  });
  try { migrate(); }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}

function assertJournalSchema(db) {
  const columns = tableColumns(db, 'entries');
  requireValue(!columns.includes('content'), 'JOURNAL_BODY_SCHEMA', '私人日记数据库仍包含正文列，拒绝继续写入。', 409);
}

function finalizeTransaction(db, row) {
  transaction(db, () => {
    if (row.day_key !== null) {
      db.prepare(`INSERT INTO journal_days(day_key, relative_path, revision, updated_at, content_hash)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(day_key) DO UPDATE SET relative_path=excluded.relative_path,
          revision=excluded.revision, updated_at=excluded.updated_at, content_hash=excluded.content_hash`)
        .run(row.day_key, row.relative_path, row.revision, row.created_at, row.new_hash);
      if (row.entry_id !== null) {
        db.prepare('DELETE FROM journal_observations WHERE day_key=? AND content_hash<>?').run(row.day_key, row.new_hash);
        db.prepare('DELETE FROM journal_organized WHERE day_key=? AND output_hash<>?').run(row.day_key, row.new_hash);
      }
    }
    db.prepare('DELETE FROM journal_transactions WHERE operation_id=?').run(row.operation_id);
  });
}

export function recoverJournalTransactions(db, root) {
  const pending = db.prepare('SELECT * FROM journal_transactions ORDER BY created_at, operation_id').all();
  for (const row of pending) {
    const current = readJournalFile(root, row.relative_path);
    const currentHash = current === null ? null : journalFileHash(current);
    const stagedContent = readJournalFile(root, row.temporary_path);
    if (currentHash === row.new_hash) {
      if (stagedContent !== null) removeJournalFile(root, row.temporary_path);
      finalizeTransaction(db, row);
      continue;
    }
    if (currentHash !== row.old_hash)
      requireValue(false, 'JOURNAL_RECOVERY_CONFLICT', 'Markdown 日记在待恢复期间被修改；保留文件和元数据以避免覆盖。', 409);
    requireValue(stagedContent !== null && journalFileHash(stagedContent) === row.new_hash,
      'JOURNAL_RECOVERY_STAGE_INVALID', '日记暂存文件缺失或校验失败；保留原文件并停止恢复。', 409);
    publishJournalFile(root, {
      temporary: row.temporary_path,
      relative: row.relative_path,
      hash: row.new_hash
    });
    finalizeTransaction(db, row);
  }
}

export function initializePrivateJournal(db, root) {
  migrateJournalStaging(root);
  const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  requireValue(version <= FORMAT_VERSION, 'JOURNAL_VERSION_UNSUPPORTED', '私人日记数据库版本较新，当前版本不能安全打开。', 409);
  if (tableExists(db, 'entries') && tableColumns(db, 'entries').includes('content')) {
    migrateLegacyJournal(db, root);
  } else {
    createSchema(db);
    upgradeJournalSchema(db);
    db.prepare("INSERT OR REPLACE INTO journal_metadata(key, value) VALUES ('format', 'markdown-v1')").run();
  }
  assertJournalSchema(db);
  recoverJournalTransactions(db, root);
  migratePrivateJournalLayout(db, root);
}

export function openPrivateJournal(directory) {
  mkdirSync(join(directory, 'private'), { recursive: true });
  const legacy = join(directory, 'private', 'journal.sqlite3');
  const target = privateJournalDatabasePath(directory);
  if (existsSync(legacy)) {
    requireValue(!existsSync(target), 'JOURNAL_INDEX_CONFLICT', '新旧私人日记索引同时存在，未覆盖；请先核对数据。', 409);
    const previous = openDatabase(legacy);
    try {
      const checkpoint = previous.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      requireValue(checkpoint.busy === 0, 'JOURNAL_INDEX_BUSY', '旧私人日记索引仍被占用，未移动。', 409);
    } finally { previous.close(); }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
  }
  for (const suffix of ['-wal', '-shm']) {
    const file = `${legacy}${suffix}`;
    if (!existsSync(file)) continue;
    requireValue(existsSync(target) && (suffix !== '-wal' || statSync(file).size === 0),
      'JOURNAL_INDEX_CONFLICT', '旧日记辅助文件仍含未归并的数据，未删除。', 409);
    rmSync(file);
  }
  const db = openDatabase(target);
  try {
    const hadBodies = tableColumns(db, 'entries').includes('content');
    db.exec('PRAGMA secure_delete=ON');
    initializePrivateJournal(db, join(directory, 'private'));
    if (hadBodies) db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    return db;
  } catch (error) { db.close(); throw error; }
}

function originalEntryContent(document, entry) {
  const start = `<!-- tidal-entry:${entry.id} sha256:${entry.content_hash} -->`;
  const end = `\n<!-- /tidal-entry:${entry.id} -->`;
  const position = document.indexOf(start);
  const bodyStart = position < 0 ? -1 : document.indexOf('\n\n', position + start.length);
  const bodyEnd = bodyStart < 0 ? -1 : document.indexOf(end, bodyStart + 2);
  requireValue(position >= 0 && bodyStart >= 0 && bodyEnd >= 0 && document.indexOf(start, position + start.length) < 0,
    'JOURNAL_MIGRATION_CONFLICT', '旧日记原件标记不完整或重复，未删除原件。', 409);
  const content = document.slice(bodyStart + 2, bodyEnd);
  requireValue(journalFileHash(content) === entry.content_hash, 'JOURNAL_MIGRATION_CONFLICT', '旧日记正文校验失败，未删除原件。', 409);
  return content;
}

function resumeJournalLayout(db, root, plan) {
  requireValue(['pending', 'cleanup'].includes(plan.phase), 'JOURNAL_MIGRATION_CONFLICT', '日记迁移状态无效，原件已保留。', 409);
  if (plan.phase === 'pending') {
    for (const source of plan.sources) {
      const text = readJournalFile(root, source.path);
      const published = plan.documents.find(item => item.relative === source.path);
      requireValue(text !== null && (journalFileHash(text) === source.hash ||
        (published && journalFileHash(text) === published.hash)),
      'JOURNAL_MIGRATION_CONFLICT', '旧日记在迁移期间被修改，未覆盖或删除。', 409);
    }
    for (const document of plan.documents) {
      const text = readJournalFile(root, document.relative);
      const current = text === null ? null : journalFileHash(text);
      if (current === document.hash) {
        removeJournalFile(root, document.temporary);
      } else {
        requireValue(current === document.oldHash, 'JOURNAL_MIGRATION_CONFLICT', '日期日记文件发生冲突，原件已保留。', 409);
        const staged = readJournalFile(root, document.temporary);
        requireValue(staged !== null && journalFileHash(staged) === document.hash,
          'JOURNAL_RECOVERY_STAGE_INVALID', '日期整理暂存文件缺失或损坏，原件已保留。', 409);
        publishJournalFile(root, document);
      }
    }
    transaction(db, () => {
      for (const entry of plan.entries)
        db.prepare('UPDATE entries SET day_key=?, relative_path=? WHERE id=?').run(entry.day, dailyJournalPath(entry.day), entry.id);
      for (const document of plan.documents) {
        db.prepare(`INSERT INTO journal_days(day_key,relative_path,revision,updated_at,content_hash) VALUES(?,?,?,?,?)
          ON CONFLICT(day_key) DO UPDATE SET relative_path=excluded.relative_path,revision=excluded.revision,
          updated_at=excluded.updated_at,content_hash=excluded.content_hash`)
          .run(document.day, document.relative, document.revision, document.updatedAt, document.hash);
        db.prepare('DELETE FROM journal_observations WHERE day_key=? AND content_hash<>?').run(document.day, document.hash);
        db.prepare('DELETE FROM journal_organized WHERE day_key=? AND output_hash<>?').run(document.day, document.hash);
      }
      plan.phase = 'cleanup';
      db.prepare("INSERT OR REPLACE INTO journal_metadata VALUES('layout-migration',?)").run(JSON.stringify(plan));
    });
  }
  for (const document of plan.documents) {
    const text = readJournalFile(root, document.relative);
    requireValue(text !== null && journalFileHash(text) === document.hash,
      'JOURNAL_MIGRATION_CONFLICT', '已迁移的日记被修改或丢失，旧原件未删除。', 409);
  }
  for (const source of plan.sources) {
    if (plan.documents.some(document => document.relative === source.path)) continue;
    const text = readJournalFile(root, source.path);
    requireValue(text === null || journalFileHash(text) === source.hash,
      'JOURNAL_MIGRATION_CONFLICT', '待清理旧日记已被修改，保留原件。', 409);
    if (text !== null) removeJournalFile(root, source.path);
  }
  removeEmptyJournalDirectories(root);
  db.prepare("DELETE FROM journal_metadata WHERE key='layout-migration'").run();
}

export function migratePrivateJournalLayout(db, root) {
  const pending = db.prepare("SELECT value FROM journal_metadata WHERE key='layout-migration'").get();
  if (pending) resumeJournalLayout(db, root, JSON.parse(pending.value));
  const entries = db.prepare('SELECT * FROM entries ORDER BY created_at,id').all();
  const changes = entries.filter(entry => !entry.day_key || entry.relative_path !== dailyJournalPath(entry.day_key));
  if (!changes.length) { removeEmptyJournalDirectories(root); return; }
  const plan = { phase: 'pending', entries: [], sources: [], documents: [] };
  const sources = new Map(), groups = new Map();
  const sourceText = path => {
    if (!sources.has(path)) {
      const content = readJournalFile(root, path);
      requireValue(content !== null, 'JOURNAL_FILE_MISSING', '旧日记原件缺失，日期整理已停止。', 409);
      sources.set(path, content);
      plan.sources.push({ path, hash: journalFileHash(content) });
    }
    return sources.get(path);
  };
  for (const entry of changes) {
    const content = entry.day_key ? null : originalEntryContent(sourceText(entry.relative_path), entry);
    const originalDay = entry.day_key || originalJournalDay(content);
    const day = originalDay || archiveDay(entry.created_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push({ ...entry, content, archiveDateOnly: !originalDay });
    plan.entries.push({ id: entry.id, day });
  }
  let saved = false;
  try {
    for (const [day, additions] of groups) {
      const state = db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(day);
      let content = state ? sourceText(state.relative_path) : null;
      requireValue(!state || journalFileHash(content) === state.content_hash,
        'JOURNAL_EXTERNAL_CHANGE', '旧日期日记已被修改，未覆盖。', 409);
      for (const entry of additions) {
        if (entry.day_key) {
          requireValue(state && state.relative_path === entry.relative_path,
            'JOURNAL_MIGRATION_CONFLICT', '旧日期日记索引不一致，原件已保留。', 409);
        } else content = appendContribution(content, day, entry);
      }
      const path = dailyJournalPath(day), existing = readJournalFile(root, path);
      requireValue(existing === null || (state?.relative_path === path && state.content_hash === journalFileHash(existing)) ||
        existing === content, 'JOURNAL_MIGRATION_CONFLICT', '目标日期文件已存在且不一致，未覆盖。', 409);
      requireValue(Buffer.byteLength(content) <= MAX_DAY_BYTES, 'JOURNAL_DAY_TOO_LARGE', '合并后的日记超过单日大小限制，原件已保留。', 413);
      const staged = stageJournalFile(root, path, content);
      plan.documents.push({ ...staged, day, oldHash: existing === null ? null : journalFileHash(existing),
        revision: (state?.revision || 0) + (additions.some(entry => !entry.day_key) || !state ? 1 : 0),
        updatedAt: [state?.updated_at, ...additions.map(entry => entry.created_at)].filter(Boolean).sort().at(-1) });
    }
    db.prepare("INSERT OR REPLACE INTO journal_metadata VALUES('layout-migration',?)").run(JSON.stringify(plan));
    saved = true;
    resumeJournalLayout(db, root, plan);
  } catch (error) {
    if (!saved) for (const document of plan.documents) removeJournalFile(root, document.temporary);
    throw error;
  }
}

export function appendPrivateEntry(db, root, { author, content, sourceIds = [], sourceSession = null,
  now = new Date().toISOString(), operationId = randomUUID() }) {
  const writer = slug(author, 'author');
  requireValue(typeof content === 'string' && content.trim().length > 0 && content.length <= MAX_PRIVATE_CONTENT_LENGTH,
    'INVALID_PRIVATE_CONTENT', '私人记录内容无效或过长。');
  requireValue(Array.isArray(sourceIds) && sourceIds.length <= 40 &&
    sourceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256),
  'INVALID_PRIVATE_SOURCES', '私人记录来源无效。');
  requireValue(sourceSession === null || (typeof sourceSession === 'string' && sourceSession.length > 0 &&
    sourceSession.length <= 256), 'INVALID_PRIVATE_SOURCE_SESSION', '私人记录会话来源无效。');
  requireValue(typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 256,
    'INVALID_OPERATION_ID', '私人记录操作 ID 无效。');
  const timestamp = safeTime(now);
  requireValue(timestamp, 'INVALID_PRIVATE_DATE', '私人日记写入时间无效，未写入。');
  recoverJournalTransactions(db, root);
  const day = localDateKey(new Date(timestamp));
  const relativePath = dailyJournalPath(day);
  const entryId = randomUUID();
  const payloadHash = journalFileHash(JSON.stringify({ writer, content, sourceIds, timestamp }));
  const previousOperation = db.prepare('SELECT * FROM journal_operations WHERE operation_id=?').get(operationId);
  if (previousOperation) {
    requireValue(previousOperation.payload_hash === payloadHash, 'OPERATION_ID_REUSED', '操作 ID 已用于不同的私人记录内容。', 409);
    return db.prepare('SELECT * FROM entries WHERE id=?').get(previousOperation.entry_id);
  }
  const existing = readJournalFile(root, relativePath);
  const dayState = db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(day);
  if (existing !== null) {
    requireValue(dayState && dayState.content_hash === journalFileHash(existing),
      'JOURNAL_EXTERNAL_CHANGE', '日记文件已被外部修改，拒绝覆盖；请先完成同步或恢复。', 409);
  } else {
    requireValue(!dayState, 'JOURNAL_FILE_MISSING', '日记文件缺失但数据库仍有对应元数据，拒绝覆盖。', 409);
  }
  const nextContent = appendContribution(existing, day, { id: entryId, author: writer, created_at: timestamp, content });
  requireValue(Buffer.byteLength(nextContent, 'utf8') <= MAX_DAY_BYTES,
    'JOURNAL_DAY_TOO_LARGE', '当日日记超过安全大小限制，未写入。', 413);
  const transactionId = randomUUID();
  const staged = stageJournalFile(root, relativePath, nextContent, transactionId);
  const revision = (dayState?.revision || 0) + 1;
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO entries(id, author, created_at, source_ids, source_session, day_key, relative_path, revision, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(entryId, writer, timestamp, JSON.stringify(sourceIds), sourceSession, day, relativePath, journalFileHash(content));
      db.prepare('INSERT INTO journal_pending(entry_id, state, updated_at) VALUES (?, ?, ?)')
        .run(entryId, 'pending', timestamp);
      db.prepare(`INSERT INTO journal_operations(operation_id, payload_hash, entry_id, created_at)
        VALUES (?, ?, ?, ?)`).run(operationId, payloadHash, entryId, timestamp);
      db.prepare(`INSERT INTO journal_transactions
        (operation_id, entry_id, day_key, relative_path, temporary_path, old_hash, new_hash, revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(transactionId, entryId, day, relativePath, staged.temporary,
          existing === null ? null : journalFileHash(existing), staged.hash, revision, timestamp);
    });
  } catch (error) {
    removeJournalFile(root, staged.temporary);
    throw error;
  }
  recoverJournalTransactions(db, root);
  return db.prepare('SELECT * FROM entries WHERE id=?').get(entryId);
}

export function importPrivateEntry(db, root, { id, content, createdAt = new Date().toISOString(), sourceIds = [], filename = '' }) {
  requireValue(typeof id === 'string' && id.length > 0 && id.length <= 256, 'INVALID_ID', '私人导入 ID 无效。');
  requireValue(typeof content === 'string' && content.length > 0 &&
    Buffer.byteLength(content, 'utf8') <= MAX_DAY_BYTES, 'INVALID_PRIVATE_CONTENT', '私人导入文件超过大小限制。', 413);
  const timestampValue = safeTime(createdAt);
  requireValue(timestampValue, 'INVALID_PRIVATE_DATE', '私人日记导入时间无效，未写入。');
  recoverJournalTransactions(db, root);
  const contentHash = journalFileHash(content);
  const existing = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  if (existing) {
    requireValue(existing.content_hash === contentHash, 'OPERATION_ID_REUSED', '私人导入 ID 已用于不同内容。', 409);
    return existing;
  }
  const originalDay = originalJournalDay(content, filename);
  const day = originalDay || archiveDay(timestampValue);
  const path = dailyJournalPath(day);
  const previous = readJournalFile(root, path);
  const state = db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(day);
  requireValue(previous === null ? !state : state?.content_hash === journalFileHash(previous),
    'JOURNAL_EXTERNAL_CHANGE', '私人导入目标文件与索引不一致，未覆盖。', 409);
  const entry = { id, author: 'legacy-import', created_at: timestampValue, content, archiveDateOnly: !originalDay };
  const document = appendContribution(previous, day, entry);
  requireValue(Buffer.byteLength(document) <= MAX_DAY_BYTES, 'JOURNAL_DAY_TOO_LARGE', '合并后的日记超过单日大小限制，未导入。', 413);
  const staged = stageJournalFile(root, path, document);
  const operationId = `import-${randomUUID()}`;
  const payloadHash = journalFileHash(JSON.stringify({ id, contentHash }));
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO entries(id,author,created_at,source_ids,day_key,relative_path,revision,content_hash)
        VALUES(?,?,?,?,?,?,1,?)`).run(id, 'legacy-import', timestampValue, JSON.stringify(sourceIds), day, path, contentHash);
      db.prepare('INSERT INTO journal_pending(entry_id,state,updated_at) VALUES(?,?,?)')
        .run(id, 'pending', timestampValue);
      db.prepare('INSERT INTO journal_operations(operation_id,payload_hash,entry_id,created_at) VALUES(?,?,?,?)')
        .run(operationId, payloadHash, id, timestampValue);
      db.prepare(`INSERT INTO journal_transactions
        (operation_id,entry_id,day_key,relative_path,temporary_path,old_hash,new_hash,revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(operationId, id, day, path, staged.temporary,
          previous === null ? null : journalFileHash(previous), staged.hash, (state?.revision || 0) + 1, timestampValue);
    });
  } catch (error) {
    removeJournalFile(root, staged.temporary);
    throw error;
  }
  recoverJournalTransactions(db, root);
  return db.prepare('SELECT * FROM entries WHERE id=?').get(id);
}

export function removePrivateEntries(db, root, ids) {
  const uniqueIds = [...new Set(ids)].filter(id => typeof id === 'string');
  if (!uniqueIds.length) return 0;
  const placeholders = uniqueIds.map(() => '?').join(',');
  const entries = db.prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`).all(...uniqueIds);
  const byPath = new Map();
  for (const entry of entries) {
    if (!byPath.has(entry.relative_path)) byPath.set(entry.relative_path, []);
    byPath.get(entry.relative_path).push(entry);
  }
  for (const [relative, removed] of byPath) {
    const content = readJournalFile(root, relative);
    requireValue(content !== null, 'JOURNAL_FILE_MISSING', '删除私人记录时日记文件缺失，数据库未修改。', 409);
    const day = removed[0].day_key;
    const state = day ? db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(day) : null;
    requireValue(!state || state.content_hash === journalFileHash(content),
      'JOURNAL_EXTERNAL_CHANGE', '日记文件已被外部修改，拒绝删除记录。', 409);
    let updated = content;
    for (const entry of removed) {
      const escaped = String(entry.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updated = updated.replace(new RegExp(`<!-- tidal-entry:${escaped}(?: sha256:[a-f0-9]{64})? -->[\\s\\S]*?<!-- /tidal-entry:${escaped} -->\\n*`, 'g'), '');
    }
    const remaining = db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE relative_path=? AND id NOT IN (${placeholders})`)
      .get(relative, ...uniqueIds).count;
    if (remaining === 0) {
      removeJournalFile(root, relative);
      if (day) {
        db.prepare('DELETE FROM journal_days WHERE day_key=?').run(day);
        db.prepare('DELETE FROM journal_observations WHERE day_key=?').run(day);
        db.prepare('DELETE FROM journal_organized WHERE day_key=?').run(day);
      }
    } else {
      const staged = stageJournalFile(root, relative, updated);
      publishJournalFile(root, staged);
      if (day) db.prepare('UPDATE journal_days SET revision=revision+1, updated_at=?, content_hash=? WHERE day_key=?')
        .run(new Date().toISOString(), journalFileHash(updated), day);
      db.prepare('DELETE FROM journal_observations WHERE day_key=?').run(day);
      db.prepare('DELETE FROM journal_organized WHERE day_key=?').run(day);
    }
  }
  const deleteRows = () => transaction(db, () => {
    db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...uniqueIds);
  });
  deleteRows();
  return entries.length;
}

function markdownSegments(content, maxBytes) {
  const segments = [];
  let segment = '';
  const flush = () => {
    if (segment) segments.push(segment);
    segment = '';
  };
  for (const line of content.match(/.*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') <= maxBytes) {
      if (segment && Buffer.byteLength(segment + line, 'utf8') > maxBytes) flush();
      segment += line;
      continue;
    }
    flush();
    for (const character of line) {
      if (Buffer.byteLength(segment + character, 'utf8') > maxBytes) flush();
      segment += character;
    }
    flush();
  }
  flush();
  return segments;
}

export function privateJournalContext(db, root, { sessionId, provider, model, now = new Date(), maxBytes = 8000 }) {
  requireValue(typeof sessionId === 'string' && sessionId.length > 0 &&
    typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0,
  'PRIVATE_ROUTE_REQUIRED', '私人日记回顾需要已校验的会话和模型路由。', 403);
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 32000,
    'INVALID_PRIVATE_BUDGET', '私人日记上下文预算无效。');
  const today = new Date(now);
  today.setDate(today.getDate() - 1);
  const cutoff = localDateKey(today);
  const days = db.prepare('SELECT * FROM journal_days WHERE day_key<=? ORDER BY day_key DESC').all(cutoff);
  for (const day of days) {
    const content = readJournalFile(root, day.relative_path);
    requireValue(content !== null && journalFileHash(content) === day.content_hash,
      'JOURNAL_EXTERNAL_CHANGE', '私人日记文件缺失或校验不符；主会话回顾已停止。', 409);
    const organized = db.prepare('SELECT output_hash FROM journal_organized WHERE day_key=?').get(day.day_key);
    if (organized?.output_hash === day.content_hash) continue;
    const segments = markdownSegments(content, maxBytes - 256);
    const rows = db.prepare(`SELECT segment_index FROM journal_observations
      WHERE day_key=? AND content_hash=? AND session_id=? AND provider=? AND model=?`).all(
      day.day_key, day.content_hash, sessionId, provider, model);
    const observed = new Set(rows.map(row => row.segment_index));
    const segmentIndex = segments.findIndex((_, index) => !observed.has(index));
    if (segmentIndex < 0) continue;
    const segmentCount = segments.length;
    const prefix = `私人日记回顾（仅授权主会话）\n日期：${day.day_key}；分段：${segmentIndex + 1}/${segmentCount}\n\n`;
    const text = `${prefix}${segments[segmentIndex]}`;
    requireValue(Buffer.byteLength(text, 'utf8') <= maxBytes,
      'PRIVATE_CONTEXT_TOO_LARGE', '私人日记分段超过上下文预算，未注入。', 413);
    return {
      text,
      receipt: { day: day.day_key, contentHash: day.content_hash, segmentIndex, segmentCount,
        sessionId, provider, model },
    };
  }
  return null;
}

export function recordPrivateObservation(db, root, receipt, now = new Date().toISOString()) {
  requireValue(receipt && safeDay(receipt.day) && /^[a-f0-9]{64}$/.test(receipt.contentHash) &&
    Number.isSafeInteger(receipt.segmentIndex) && receipt.segmentIndex >= 0 &&
    Number.isSafeInteger(receipt.segmentCount) && receipt.segmentCount > receipt.segmentIndex &&
    typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0 && receipt.sessionId.length <= 256 &&
    typeof receipt.provider === 'string' && receipt.provider.length > 0 &&
    typeof receipt.model === 'string' && receipt.model.length > 0,
  'INVALID_PRIVATE_OBSERVATION', '私人日记回执无效。');
  const day = db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(receipt.day);
  if (!day || day.content_hash !== receipt.contentHash) return false;
  const content = readJournalFile(root, day.relative_path);
  if (content === null || journalFileHash(content) !== receipt.contentHash) return false;
  db.prepare(`INSERT OR IGNORE INTO journal_observations
    (day_key,content_hash,segment_index,segment_count,session_id,provider,model,observed_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(receipt.day, receipt.contentHash, receipt.segmentIndex,
    receipt.segmentCount, receipt.sessionId, receipt.provider, receipt.model, now);
  return true;
}

export function organizePrivateDay(db, root, { day: dayKey, expectedHash, markdown, sessionId, provider, model,
  maxBytes = 8000, now = new Date() }) {
  requireValue(safeDay(dayKey) && typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash),
    'INVALID_JOURNAL_VERSION', '日记日期或读取版本无效。');
  requireValue(typeof markdown === 'string' && markdown.trim().length > 0 && markdown.length <= 50000,
    'INVALID_ORGANIZATION', '主会话整理内容无效或过长。');
  const today = new Date(now);
  today.setDate(today.getDate() - 1);
  requireValue(dayKey <= localDateKey(today), 'JOURNAL_NOT_DUE', '当天日记会在次日进入主会话回顾。', 409);
  const day = db.prepare('SELECT * FROM journal_days WHERE day_key=?').get(dayKey);
  requireValue(day && day.content_hash === expectedHash, 'JOURNAL_VERSION_CONFLICT',
    '日记内容已变化，请重新回顾最新版本。', 409);
  const content = readJournalFile(root, day.relative_path);
  requireValue(content !== null && journalFileHash(content) === expectedHash,
    'JOURNAL_EXTERNAL_CHANGE', '日记文件缺失或校验不符，未提交整理。', 409);
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 32000,
    'INVALID_PRIVATE_BUDGET', '私人日记上下文预算无效。');
  const segments = markdownSegments(content, maxBytes - 256);
  const observed = db.prepare(`SELECT COUNT(*) AS count FROM journal_observations
    WHERE day_key=? AND content_hash=? AND session_id=? AND provider=? AND model=? AND segment_count=?`)
    .get(dayKey, expectedHash, sessionId, provider, model, segments.length).count;
  requireValue(observed === segments.length, 'JOURNAL_NOT_FULLY_OBSERVED',
    '当前版本尚未由授权主会话完整回顾，不能提交整理。', 409);
  const safeMarkdown = markdown.replace(/<!--\s*\/?tidal-(?:organized|entry):?[^>]*-->/gi, '').trim();
  requireValue(safeMarkdown.length > 0, 'INVALID_ORGANIZATION', '整理内容无效。');
  const section = `## 主会话整理\n\n<!-- tidal-organized:start -->\n${safeMarkdown}\n<!-- tidal-organized:end -->`;
  const marker = /<!-- tidal-organized:start -->[\s\S]*?<!-- tidal-organized:end -->/;
  const start = content.indexOf('<!-- tidal-organized:start -->');
  const end = content.indexOf('<!-- tidal-organized:end -->');
  requireValue((start < 0 && end < 0) || (start >= 0 && end > start),
    'JOURNAL_MARKER_INVALID', '日记整理标记不完整，未覆盖现有内容。', 409);
  const updated = start < 0 ? `${content.endsWith('\n') ? content : `${content}\n`}${section}\n`
    : content.replace(marker, section);
  requireValue(Buffer.byteLength(updated, 'utf8') <= MAX_DAY_BYTES,
    'JOURNAL_DAY_TOO_LARGE', '整理结果超过单日日记大小限制，未写入。', 413);
  const transactionId = randomUUID();
  const staged = stageJournalFile(root, day.relative_path, updated, transactionId);
  const revision = day.revision + 1;
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO journal_transactions
        (operation_id,entry_id,day_key,relative_path,temporary_path,old_hash,new_hash,revision,created_at)
        VALUES(?,NULL,?,?,?,?,?,?,?)`).run(transactionId, dayKey, day.relative_path, staged.temporary,
        expectedHash, staged.hash, revision, now.toISOString());
    });
  } catch (error) {
    removeJournalFile(root, staged.temporary);
    throw error;
  }
  recoverJournalTransactions(db, root);
  db.prepare(`INSERT INTO journal_organized(day_key,source_hash,output_hash,session_id,provider,model,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(day_key) DO UPDATE SET source_hash=excluded.source_hash,
    output_hash=excluded.output_hash,session_id=excluded.session_id,provider=excluded.provider,
    model=excluded.model,updated_at=excluded.updated_at`)
    .run(dayKey, expectedHash, staged.hash, sessionId, provider, model, now.toISOString());
  return { saved: true, day: dayKey, revision, contentHash: staged.hash };
}

export function privateJournalStatus(db, root, now = new Date()) {
  const summary = db.prepare(`SELECT COUNT(*) AS count, MAX(created_at) AS lastWritten,
    MIN(day_key) AS firstDay, MAX(day_key) AS lastDay,
    COUNT(CASE WHEN author='legacy-import' THEN 1 END) AS importedCount,
    MAX(CASE WHEN author='legacy-import' THEN created_at END) AS lastImportedAt,
    MAX(CASE WHEN author<>'legacy-import' THEN created_at END) AS lastContributionAt FROM entries`).get();
  const pending = db.prepare('SELECT COUNT(*) AS count FROM journal_pending').get().count;
  const files = listJournalFiles(root);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const dueDays = db.prepare('SELECT day_key,content_hash FROM journal_days WHERE day_key<=?').all(localDateKey(yesterday));
  const reviewPendingDays = dueDays.filter(day =>
    db.prepare('SELECT output_hash FROM journal_organized WHERE day_key=?').get(day.day_key)?.output_hash !== day.content_hash).length;
  const observedDays = dueDays.filter(day => db.prepare(`SELECT 1 FROM journal_observations
    WHERE day_key=? AND content_hash=? LIMIT 1`).get(day.day_key, day.content_hash)).length;
  const organizationRow = db.prepare("SELECT value FROM journal_metadata WHERE key='last-organization'").get();
  const failureRow = db.prepare("SELECT value FROM journal_metadata WHERE key='last-failure'").get();
  let organization = null;
  if (organizationRow) {
    try {
      const value = JSON.parse(organizationRow.value);
      organization = {
        state: ['completed', 'partial', 'failed'].includes(value.state) ? value.state : null,
        from: safeTime(value.from),
        until: safeTime(value.until),
        normalized: Number.isSafeInteger(value.normalized) ? value.normalized : 0,
        count: Number.isSafeInteger(value.count) ? value.count : 0
      };
    } catch { organization = null; }
  }
  return {
    format: 'markdown',
    count: summary.count,
    fileCount: files.length,
    dailyCount: files.filter(file => /^(?:\d{4}\/)?\d{4}-\d{2}-\d{2}\.md$/.test(file.path)).length,
    legacyCount: db.prepare('SELECT COUNT(*) AS count FROM entries WHERE day_key IS NULL').get().count,
    bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0),
    lastWritten: safeTime(summary.lastWritten),
    importedCount: summary.importedCount,
    lastImportedAt: safeTime(summary.lastImportedAt),
    lastContributionAt: safeTime(summary.lastContributionAt),
    firstDay: safeDay(summary.firstDay),
    lastDay: safeDay(summary.lastDay),
    pending,
    reviewPendingDays,
    observedDays,
    files: files.map(file => file.path),
    organization,
    failure: failureRow ? { code: 'PRIVATE_ORGANIZATION_FAILED', at: failureRow.value } : null
  };
}

export function organizePrivateWindow(db, root, options = {}) {
  const { from, to } = options;
  const fromTime = from ? safeTime(from) : '0000-01-01T00:00:00.000Z';
  const toTime = to ? safeTime(to) : new Date().toISOString();
  requireValue(fromTime <= toTime, 'INVALID_WINDOW', '私人日记整理时间范围无效。');
  const fromDay = safeDay(fromTime.slice(0, 10)) ? fromTime.slice(0, 10) : '0000-01-01';
  const toDay = safeDay(toTime.slice(0, 10)) ? toTime.slice(0, 10) : '9999-12-31';
  const days = db.prepare(`SELECT * FROM journal_days WHERE day_key BETWEEN ? AND ? ORDER BY day_key`)
    .all(fromDay, toDay);
  let normalized = 0;
  for (const day of days) {
    const content = readJournalFile(root, day.relative_path);
    requireValue(content !== null && journalFileHash(content) === day.content_hash,
      'JOURNAL_EXTERNAL_CHANGE', '日记文件缺失或已被外部修改；整理已停止。', 409);
    const updated = content.replace(/\r\n/g, '\n');
    if (updated === content) continue;
    const staged = stageJournalFile(root, day.relative_path, updated);
    publishJournalFile(root, staged);
    db.prepare('UPDATE journal_days SET revision=revision+1, updated_at=?, content_hash=? WHERE day_key=?')
      .run(new Date().toISOString(), journalFileHash(updated), day.day_key);
    db.prepare('DELETE FROM journal_observations WHERE day_key=?').run(day.day_key);
    db.prepare('DELETE FROM journal_organized WHERE day_key=?').run(day.day_key);
    normalized += 1;
  }
  const count = db.prepare(`SELECT COUNT(*) AS count FROM journal_pending p
    JOIN entries e ON e.id=p.entry_id WHERE e.created_at BETWEEN ? AND ?`).get(fromTime, toTime).count;
  const result = {
    state: 'completed',
    mode: 'markdown-normalization',
    observed: false,
    normalized,
    count,
    message: '已校验并规范 Markdown 日记换行；正文保留在私人日记文件中，未进行模型整理。'
  };
  db.prepare("INSERT OR REPLACE INTO journal_metadata(key,value) VALUES('last-organization',?)")
    .run(JSON.stringify({ state: result.state, from: fromTime, until: toTime, ...result }));
  return result;
}

export function clearPrivateJournal(db, root, options = {}) {
  const { before } = options;
  const cutoff = before ? safeTime(before) : null;
  const rows = cutoff
    ? db.prepare('SELECT id FROM entries WHERE created_at < ?').all(cutoff)
    : db.prepare('SELECT id FROM entries').all();
  removePrivateEntries(db, root, rows.map(row => row.id));
  if (!cutoff) {
    db.exec(`DELETE FROM entry_aliases; DELETE FROM journal_pending; DELETE FROM journal_days;
      DELETE FROM journal_transactions; DELETE FROM journal_operations;
      DELETE FROM journal_observations; DELETE FROM journal_organized;`);
  } else {
    db.prepare('DELETE FROM journal_pending WHERE entry_id IN (SELECT id FROM entries WHERE created_at < ?)').run(cutoff);
    db.prepare('DELETE FROM journal_days WHERE day_key < ?').run(cutoff.slice(0, 10));
    db.prepare('DELETE FROM journal_observations WHERE day_key < ?').run(cutoff.slice(0, 10));
    db.prepare('DELETE FROM journal_organized WHERE day_key < ?').run(cutoff.slice(0, 10));
  }
  db.prepare("INSERT INTO journal_metadata(key, value) VALUES ('lastClearedAt', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(new Date().toISOString());
  return rows.length;
}

export function privateJournalFiles(root) {
  return listJournalFiles(root);
}

export function legacyPrivateDocument(entry) {
  return contributionBlock(entry);
}

export function privatePayloadHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
