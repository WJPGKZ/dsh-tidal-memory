import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { atomicFile } from './database.js';
import { MemorySpace, openSpaceFor } from './store.js';
import { expandForgotten, ForgetLedger } from './forget-ledger.js';
import { importPrivateEntry, migratePrivateJournalLayout, MAX_PRIVATE_CONTENT_LENGTH } from './private-journal.js';
import { dailyJournalPath, journalFileHash, undatedJournalPath, writeJournalFile } from './journal-files.js';
import { readAutomaticKey } from './backup-key.js';
import { hash, localDateKey, MemoryError, normalizeRecord, requireValue, slug, string, timestamp } from './model.js';

export const MAX_BACKUP_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_RESTORE_BODY_BYTES = MAX_BACKUP_FILE_BYTES * 2 + 8192;
function checkBackupSize(text) {
  requireValue(typeof text === 'string' && text.length > 0, 'INVALID_BACKUP', '备份文件必须是非空文本。');
  requireValue(Buffer.byteLength(text, 'utf8') <= MAX_BACKUP_FILE_BYTES,
    'BACKUP_TOO_LARGE', '备份文件超过 128 MiB（UTF-8 字节）；未生成或恢复。', 413);
  return text;
}
export function packBackup(space, password = '', { includePrivate = Boolean(password) } = {}) {
  requireValue(!includePrivate || Boolean(password), 'PRIVATE_PLAINTEXT', '私人记录只能放入加密备份。');
  return packSnapshot(space.snapshot({ includePrivate }), password);
}
function packSnapshot(snapshot, password = '') {
  if (password) string(password, '备份口令', 256);
  requireValue(!password || password.length >= 12, 'WEAK_PASSWORD', '加密备份口令至少 12 个字符。');
  requireValue([1, 2, 3].includes(snapshot.version), 'BACKUP_VERSION', '不支持此备份版本。');
  const version = snapshot.version;
  const payload = JSON.stringify(snapshot);
  if (!password) return checkBackupSize(JSON.stringify({ format: 'tidal-backup', version, sha256: hash(payload), payload }));
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`tidal-backup-v${version}`));
    const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return checkBackupSize(JSON.stringify({ format: 'tidal-encrypted-backup', version, salt: salt.toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  } finally { key.fill(0); }
}
export function unpackBackup(text, password = '') {
  checkBackupSize(text);
  const envelope = JSON.parse(text);
  requireValue([1, 2, 3].includes(envelope.version), 'BACKUP_VERSION', '不支持此备份版本。');
  let payload;
  if (envelope.format === 'tidal-encrypted-backup') {
    requireValue(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'PASSWORD_REQUIRED', '请提供正确的备份口令。');
    for (const [field, size] of [['salt', 16], ['iv', 12], ['tag', 16]]) {
      requireValue(typeof envelope[field] === 'string' && Buffer.from(envelope[field], 'base64').length === size, 'INVALID_BACKUP', '加密备份格式无效。');
    }
    requireValue(typeof envelope.data === 'string', 'INVALID_BACKUP', '加密载荷无效。');
    const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32);
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from(`tidal-backup-v${envelope.version}`));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      payload = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
    } catch {
      throw new MemoryError('BACKUP_AUTH_FAILED', '备份口令错误或加密文件已损坏，未恢复数据。');
    } finally { key.fill(0); }
  } else {
    requireValue(envelope.format === 'tidal-backup' && typeof envelope.payload === 'string' &&
      typeof envelope.sha256 === 'string' && /^[a-f0-9]{64}$/.test(envelope.sha256), 'INVALID_BACKUP', '备份格式无效。');
    requireValue(timingSafeEqual(Buffer.from(hash(envelope.payload)), Buffer.from(envelope.sha256)), 'BACKUP_INTEGRITY', '备份校验失败。');
    payload = envelope.payload;
  }
  const document = JSON.parse(payload);
  requireValue(document.schema === 'tidal-memory' && document.version === envelope.version &&
    Array.isArray(document.records) && Array.isArray(document.revisions) && Array.isArray(document.tombstones) &&
    (document.version === 1 ? document.graphRelations === undefined : Array.isArray(document.graphRelations)) &&
    (document.forgottenKeys === undefined || Array.isArray(document.forgottenKeys)) &&
    (document.reinforcements === undefined || Array.isArray(document.reinforcements)) &&
    (document.retrievalEvents === undefined || Array.isArray(document.retrievalEvents)) &&
    (document.scenes === undefined || Array.isArray(document.scenes)) &&
    (document.sceneMembers === undefined || Array.isArray(document.sceneMembers)) &&
    (document.sceneOperations === undefined || Array.isArray(document.sceneOperations)),
  'INVALID_BACKUP', '记忆快照结构无效。');
  requireValue(envelope.format === 'tidal-encrypted-backup' ||
    (!document.privateEntries && !document.privateAliases && !document.privatePending && !document.privateForgottenIds &&
      !document.privateFiles && !document.privateDays && !document.privateMetadata && !document.privateOperations &&
      !document.privateObservations && !document.privateOrganized),
  'PRIVATE_PLAINTEXT', '拒绝包含私人日记的明文备份。');
  return document;
}
export function restoreBackup(root, name, text, password, config) {
  slug(name);
  requireValue(!/^restore-[a-f0-9-]{36}$/.test(name), 'INVALID_SPACE', '该名称保留给临时恢复空间，请使用其他名称。');
  const target = join(root, 'spaces', name);
  requireValue(!existsSync(target), 'SPACE_EXISTS', '恢复必须使用一个尚不存在的新空间。', 409);
  const document = unpackBackup(text, password);
  requireValue(document.lineageId === undefined || typeof document.lineageId === 'string' &&
    /^[a-f0-9-]{36}$/.test(document.lineageId), 'INVALID_BACKUP', '恢复谱系无效。');
  if (document.space !== undefined) slug(document.space);
  const ledger = new ForgetLedger(root);
  let lineageId = document.lineageId ?? (document.space ? ledger.lineageFor(document.space) : null);
  let coverage = lineageId && ledger.hasLineage(lineageId) ?
    (document.lineageId ? 'local-ledger' : 'legacy-name-match') : 'backup-only';
  try {
    const sourceFile = document.space && join(root, 'spaces', document.space, 'system', 'operations.sqlite3');
    if ((!lineageId || coverage === 'backup-only') && sourceFile && existsSync(sourceFile)) {
      const current = openSpaceFor(root, document.space);
      const source = current ?? new MemorySpace(root, document.space, { config });
      try {
        source.recover();
        if (!lineageId || source.lineageId === lineageId) {
          lineageId = source.lineageId;
          coverage = document.lineageId ? 'local-ledger' : 'legacy-name-match';
        }
      } finally { if (!current) source.close(); }
    }
    lineageId ??= randomUUID();
    const state = ledger.state(lineageId);
    const blockedIds = new Set(state.tombstones.map(row => row.id));
    const blockedKeys = new Set([...state.tombstones.map(row => row.dedupe_key), ...state.forgottenKeys]);
    requireValue(document.privateForgottenIds === undefined || Array.isArray(document.privateForgottenIds),
      'INVALID_BACKUP', '私人遗忘标记无效。');
    const blockedPrivateIds = new Set(state.privateIds);
    for (const id of document.privateForgottenIds ?? []) {
      string(id, '私人遗忘标记 ID', 64);
      blockedPrivateIds.add(id);
    }
    for (const row of document.tombstones) {
      requireValue(row && typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) &&
        typeof row.dedupe_key === 'string' && /^[a-f0-9]{64}$/.test(row.dedupe_key),
      'INVALID_BACKUP', '遗忘标记无效。');
      blockedIds.add(row.id);
      blockedKeys.add(row.dedupe_key);
    }
    for (const key of document.forgottenKeys ?? []) {
      requireValue(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key), 'INVALID_BACKUP', '遗忘标记无效。');
      blockedKeys.add(key);
    }
    return restoreDocument(root, name, document, config, { lineageId, coverage, blockedIds, blockedKeys, blockedPrivateIds, ledger });
  } finally { ledger.close(); }
}

function restorePrivateJournal(store, document, blockedPrivateIds) {
  const entries = document.privateEntries ?? [];
  const aliases = document.privateAliases ?? [];
  const pending = document.privatePending ?? [];
  const tombstones = document.privateForgottenIds ?? [];
  const files = document.privateFiles ?? [];
  const days = document.privateDays ?? [];
  const metadata = document.privateMetadata ?? [];
  const operations = document.privateOperations ?? [];
  const observations = document.privateObservations ?? [];
  const organized = document.privateOrganized ?? [];
  requireValue([entries, aliases, pending, tombstones, files, days, metadata, operations, observations, organized].every(Array.isArray),
    'INVALID_BACKUP', '私人日记备份结构无效。');

  const ids = new Set();
  for (const entry of entries) {
    string(entry.id, '私人记录 ID', 256);
    requireValue(!ids.has(entry.id), 'INVALID_BACKUP', '私人记录 ID 重复。');
    ids.add(entry.id);
  }
  const skipped = new Set(entries.filter(entry => blockedPrivateIds.has(entry.id)).map(entry => entry.id));
  for (const alias of aliases) {
    requireValue(alias && typeof alias.alias_id === 'string' && typeof alias.entry_id === 'string' &&
      ids.has(alias.entry_id), 'INVALID_BACKUP', '私人记录别名无效。');
    if (blockedPrivateIds.has(alias.alias_id) || blockedPrivateIds.has(alias.entry_id)) skipped.add(alias.entry_id);
  }
  const included = entries.filter(entry => !skipped.has(entry.id));
  const byPath = new Map();
  const rows = [];
  const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  const matchesDayPath = (path, day) => path === dailyJournalPath(day) || path === `${day.slice(0, 4)}/${day}.md`;
  const normalizedSources = entry => {
    let sources;
    try { sources = typeof entry.source_ids === 'string' ? JSON.parse(entry.source_ids) : entry.source_ids; }
    catch { throw new MemoryError('INVALID_BACKUP', '私人记录来源元数据无效。'); }
    requireValue(Array.isArray(sources) && sources.length <= 10000 &&
      sources.every(id => typeof id === 'string' && id.length <= 256),
    'INVALID_BACKUP', '私人记录来源元数据无效。');
    return sources;
  };
  const addEntry = (entry, path, day, contentHash) => {
    const author = slug(entry.author);
    const created = timestamp(entry.created_at, '私人记录时间');
    const revision = entry.revision ?? 1;
    requireValue(created && Number.isSafeInteger(revision) && revision > 0 &&
      (day === null || validDay(day)), 'INVALID_BACKUP', '私人记录元数据无效。');
    const sources = normalizedSources(entry);
    const sourceSession = entry.source_session ?? null;
    requireValue(sourceSession === null || (typeof sourceSession === 'string' &&
      sourceSession.length > 0 && sourceSession.length <= 256),
    'INVALID_BACKUP', '私人记录会话来源无效。');
    rows.push({ id: entry.id, author, created_at: created, source_ids: JSON.stringify(sources),
      source_session: sourceSession, day_key: day, relative_path: path, revision, content_hash: contentHash });
  };

  if (document.version >= 3) {
    const fileMap = new Map();
    for (const file of files) {
      requireValue(file && typeof file.path === 'string' && typeof file.content === 'string' &&
        typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256) &&
        journalFileHash(file.content) === file.sha256, 'INVALID_BACKUP', '私人 Markdown 文件校验失败。');
      const daily = /^(?:(\d{4})\/)?(\d{4}-\d{2}-\d{2})\.md$/.exec(file.path);
      const undated = /^undated\/[a-f0-9]{64}\.md$/.test(file.path);
      requireValue((daily && (!daily[1] || daily[1] === daily[2].slice(0, 4)) && validDay(daily[2])) || undated,
        'INVALID_BACKUP', '私人 Markdown 文件路径无效。');
      requireValue(!fileMap.has(file.path), 'INVALID_BACKUP', '私人 Markdown 文件路径重复。');
      fileMap.set(file.path, file.content);
    }
    for (const entry of entries) {
      const day = entry.day_key ?? null;
      const path = entry.relative_path;
      requireValue(typeof path === 'string' && fileMap.has(path) &&
        (day === null ? /^undated\/[a-f0-9]{64}\.md$/.test(path) : validDay(day) && matchesDayPath(path, day)),
      'INVALID_BACKUP', '私人记录与 Markdown 文件路径不匹配。');
      requireValue(typeof entry.content_hash === 'string' && /^[a-f0-9]{64}$/.test(entry.content_hash),
        'INVALID_BACKUP', '私人记录正文校验元数据无效。');
      const marker = `<!-- tidal-entry:${entry.id} sha256:${entry.content_hash} -->`;
      requireValue(fileMap.get(path).includes(marker), 'INVALID_BACKUP', '私人记录在 Markdown 文件中缺少对应标记。');
      if (!skipped.has(entry.id)) addEntry(entry, path, day, entry.content_hash);
    }
    const retainedPaths = new Set(rows.map(row => row.relative_path));
    for (const path of retainedPaths) {
      let content = fileMap.get(path);
      for (const id of skipped) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        content = content.replace(new RegExp(`<!-- tidal-entry:${escaped}(?: sha256:[a-f0-9]{64})? -->[\\s\\S]*?<!-- /tidal-entry:${escaped} -->\\n*`, 'g'), '');
      }
      writeJournalFile(store.privateDirectory, path, content);
    }
    const rowByPath = new Map(rows.map(row => [row.relative_path, row]));
    for (const day of days) {
      requireValue(day && validDay(day.day_key) && matchesDayPath(day.relative_path, day.day_key) &&
        Number.isSafeInteger(day.revision) && day.revision > 0 && typeof day.content_hash === 'string' &&
        /^[a-f0-9]{64}$/.test(day.content_hash), 'INVALID_BACKUP', '私人日记日期元数据无效。');
      const original = fileMap.get(day.relative_path);
      requireValue(original !== undefined && journalFileHash(original) === day.content_hash,
        'INVALID_BACKUP', '私人日记日期元数据与正文不匹配。');
      if (rowByPath.has(day.relative_path)) {
        const restoredContent = readFileSync(join(store.privateDirectory, ...day.relative_path.split('/')), 'utf8');
        store.privateDb.prepare(`INSERT INTO journal_days(day_key,relative_path,revision,updated_at,content_hash)
          VALUES(?,?,?,?,?)`).run(day.day_key, day.relative_path, day.revision, day.updated_at, journalFileHash(restoredContent));
      }
    }
  } else {
    const contentByPath = new Map();
    for (const entry of included) {
      string(entry.content, '私人正文', MAX_PRIVATE_CONTENT_LENGTH);
      requireValue(entry.content.length <= MAX_PRIVATE_CONTENT_LENGTH, 'INVALID_BACKUP', '私人正文过长。');
      const created = timestamp(entry.created_at, '私人记录时间');
      requireValue(created, 'INVALID_BACKUP', '私人记录时间无效。');
      const day = entry.day_key && validDay(entry.day_key) ? entry.day_key :
        entry.author === 'legacy-import' ? null : localDateKey(new Date(created));
      const path = day ? dailyJournalPath(day) : undatedJournalPath(entry.id);
      if (!contentByPath.has(path)) contentByPath.set(path, day
        ? `# ${day}\n\n## 历史贡献\n\n` : '');
      const block = `<!-- tidal-entry:${entry.id} sha256:${journalFileHash(entry.content)} -->\n### ${created} · ${slug(entry.author)}\n\n${entry.content}\n<!-- /tidal-entry:${entry.id} -->\n\n`;
      contentByPath.set(path, `${contentByPath.get(path)}${block}`);
      addEntry(entry, path, day, journalFileHash(entry.content));
    }
    for (const [path, content] of contentByPath) writeJournalFile(store.privateDirectory, path, content);
    const byDay = new Map(rows.filter(row => row.day_key).map(row => [row.day_key, row]));
    for (const [day, row] of byDay) {
      const content = contentByPath.get(row.relative_path);
      store.privateDb.prepare(`INSERT INTO journal_days(day_key,relative_path,revision,updated_at,content_hash)
        VALUES(?,?,?,?,?)`).run(day, row.relative_path,
        Math.max(1, ...rows.filter(item => item.day_key === day).map(item => item.revision)),
        row.created_at, journalFileHash(content));
    }
  }
  for (const row of rows) {
    store.privateDb.prepare(`INSERT INTO entries
      (id,author,created_at,source_ids,source_session,day_key,relative_path,revision,content_hash)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, row.author, row.created_at, row.source_ids,
      row.source_session, row.day_key, row.relative_path, row.revision, row.content_hash);
  }
  for (const alias of aliases) if (!skipped.has(alias.entry_id))
    store.privateDb.prepare('INSERT INTO entry_aliases(alias_id,entry_id) VALUES(?,?)').run(alias.alias_id, alias.entry_id);
  for (const item of pending) {
    requireValue(item && ids.has(item.entry_id), 'INVALID_BACKUP', '私人整理待处理项无效。');
    if (!skipped.has(item.entry_id)) store.privateDb.prepare(`INSERT INTO journal_pending(entry_id,state,updated_at)
      VALUES(?,?,?)`).run(item.entry_id, item.state ?? 'pending', item.updated_at ?? new Date().toISOString());
  }
  for (const item of metadata) {
    requireValue(item && typeof item.key === 'string' && typeof item.value === 'string',
      'INVALID_BACKUP', '私人日记设置元数据无效。');
    if (!['last-failure', 'layout-migration'].includes(item.key)) store.privateDb.prepare('INSERT OR REPLACE INTO journal_metadata(key,value) VALUES(?,?)')
      .run(item.key, item.value);
  }
  for (const id of tombstones) {
    string(id, '私人遗忘标记 ID', 256);
    store.privateDb.prepare(`INSERT OR IGNORE INTO private_tombstones(id,kind,created_at)
      VALUES(?,'forgotten',?)`).run(id, new Date().toISOString());
  }
  for (const operation of operations) {
    requireValue(operation && typeof operation.operation_id === 'string' &&
      operation.operation_id.length > 0 && operation.operation_id.length <= 256 &&
      /^[a-f0-9]{64}$/.test(operation.payload_hash) &&
      ids.has(operation.entry_id) && timestamp(operation.created_at, '私人操作时间'),
    'INVALID_BACKUP', '私人写入操作元数据无效。');
    if (!skipped.has(operation.entry_id))
      store.privateDb.prepare(`INSERT INTO journal_operations(operation_id,payload_hash,entry_id,created_at)
        VALUES(?,?,?,?)`).run(operation.operation_id, operation.payload_hash, operation.entry_id, operation.created_at);
  }
  for (const item of observations) {
    requireValue(item && validDay(item.day_key) && /^[a-f0-9]{64}$/.test(item.content_hash) &&
        Number.isSafeInteger(item.segment_index) && item.segment_index >= 0 &&
        Number.isSafeInteger(item.segment_count) && item.segment_count > item.segment_index &&
        typeof item.session_id === 'string' && item.session_id.length > 0 && item.session_id.length <= 256 &&
        typeof item.provider === 'string' && typeof item.model === 'string' &&
        timestamp(item.observed_at, '日记观察时间'), 'INVALID_BACKUP', '私人日记观察回执无效。');
    const day = store.privateDb.prepare('SELECT content_hash FROM journal_days WHERE day_key=?').get(item.day_key);
        const organizedVersion = organized.some(record => record?.day_key === item.day_key &&
          record.source_hash === item.content_hash && record.output_hash === day?.content_hash);
        if (day?.content_hash === item.content_hash || organizedVersion)
        store.privateDb.prepare(`INSERT OR IGNORE INTO journal_observations
          (day_key,content_hash,segment_index,segment_count,session_id,provider,model,observed_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(item.day_key, item.content_hash, item.segment_index, item.segment_count,
          item.session_id, item.provider, item.model, item.observed_at);
  }
  for (const item of organized) {
    requireValue(item && validDay(item.day_key) && /^[a-f0-9]{64}$/.test(item.source_hash) &&
        /^[a-f0-9]{64}$/.test(item.output_hash) && typeof item.session_id === 'string' &&
        item.session_id.length > 0 && item.session_id.length <= 256 &&
        typeof item.provider === 'string' && typeof item.model === 'string' &&
        timestamp(item.updated_at, '日记整理时间'), 'INVALID_BACKUP', '私人日记整理回执无效。');
    const day = store.privateDb.prepare('SELECT content_hash FROM journal_days WHERE day_key=?').get(item.day_key);
    if (day?.content_hash === item.output_hash)
        store.privateDb.prepare(`INSERT OR REPLACE INTO journal_organized
          (day_key,source_hash,output_hash,session_id,provider,model,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(item.day_key, item.source_hash, item.output_hash,
          item.session_id, item.provider, item.model, item.updated_at);
  }
  migratePrivateJournalLayout(store.privateDb, store.privateDirectory);
  return { restored: rows.length, skipped: entries.length - rows.length };
}

function restoreDocument(root, name, document, config, { lineageId, coverage, blockedIds, blockedKeys, blockedPrivateIds, ledger }) {
  const target = join(root, 'spaces', name);
  const validate = record => {
    requireValue(typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id), 'INVALID_BACKUP', '记忆 ID 无效。');
    requireValue(timestamp(record.createdAt, '创建时间') && timestamp(record.updatedAt, '更新时间'),
      'INVALID_BACKUP', '备份缺少创建或更新时间。');
    timestamp(record.reinforcedAt, '确认时间');
    const result = normalizeRecord(record, record.updatedAt, record);
    result.revision = record.revision;
    requireValue(Number.isInteger(result.revision) && result.revision > 0 && typeof result.pinned === 'boolean' &&
      Number.isFinite(result.stability) && result.stability >= 1 && result.stability <= 8, 'INVALID_BACKUP', '记忆版本或稳定性无效。');
    return result;
  };
  const normalized = document.records.map(validate);
  const records = new Map(normalized.map(record => [record.id, record]));
  requireValue(records.size === normalized.length, 'INVALID_BACKUP', '备份包含重复 ID。');
  const revisions = document.revisions.map(revision => {
    requireValue(revision && revision.record && records.has(revision.record.id) &&
      revision.layer === revision.record.layer, 'INVALID_BACKUP', '版本历史引用无效。');
    const record = validate(revision.record);
    const current = records.get(record.id);
    requireValue(current.layer === revision.layer && record.revision <= current.revision,
      'INVALID_BACKUP', '版本历史层级或编号无效。');
    return { layer: revision.layer, record };
  });
  const seeds = [...blockedIds,
    ...normalized.filter(record => blockedKeys.has(record.dedupeKey)).map(record => record.id),
    ...revisions.filter(({ record }) => blockedKeys.has(record.dedupeKey)).map(({ record }) => record.id)];
  const blocked = expandForgotten([...normalized, ...revisions.map(item => item.record)], seeds);
  const skipped = new Set(normalized.filter(record => blocked.has(record.id)).map(record => record.id));
  const staging = `restore-${randomUUID()}`;
  let store;
  let completed = false, published = false;
  try {
    store = new MemorySpace(root, staging, { config, lineageId, registerName: false, deferLedgerWrites: true });
    for (const record of normalized) if (!skipped.has(record.id)) store.persist(record);
    for (const revision of revisions) {
      const validated = revision.record;
      if (!skipped.has(validated.id)) store.db(revision.layer).prepare('INSERT OR REPLACE INTO revisions VALUES(?,?,?)')
        .run(validated.id, validated.revision, JSON.stringify(validated));
      else store.system.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?)').run(validated.dedupeKey);
    }
    for (const row of document.tombstones) {
      store.system.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?)').run(row.id, row.dedupe_key);
      store.system.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?)').run(row.dedupe_key);
    }
    for (const key of document.forgottenKeys ?? []) {
      store.system.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?)').run(key);
    }
    for (const id of skipped) {
      const record = records.get(id);
      store.system.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?)').run(record.id, record.dedupeKey);
      store.system.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?)').run(record.dedupeKey);
    }
    for (const row of document.reinforcements ?? []) {
      requireValue(row && typeof row === 'object' && records.has(row.id), 'INVALID_BACKUP', '强化依据引用无效。');
      string(row.evidence, '强化依据', 256);
      if (!skipped.has(row.id)) store.system.prepare('INSERT INTO reinforcements VALUES(?,?)').run(row.id, row.evidence);
    }
    for (const row of document.retrievalEvents ?? []) {
      requireValue(row && typeof row === 'object' && records.get(row.id)?.layer === row.layer &&
        row.layer !== 'L0' && typeof row.evidence === 'string' && /^recall:[a-f0-9]{64}$/.test(row.evidence),
      'INVALID_BACKUP', '召回依据引用无效。');
      if (!skipped.has(row.id)) store.db(row.layer).prepare('INSERT INTO retrieval_events VALUES(?,?)').run(row.id, row.evidence);
    }
    requireValue((document.eventOperations === undefined || Array.isArray(document.eventOperations)) &&
      (document.sessionFocus === undefined || Array.isArray(document.sessionFocus)),
    'INVALID_BACKUP', '跨会话操作元数据无效。');
    const operationIds = new Set();
    for (const row of document.eventOperations ?? []) {
      const record = records.get(row?.record_id);
      requireValue(row && /^[a-f0-9-]{36}$/.test(row.operation_id) &&
        /^[a-f0-9]{64}$/.test(row.payload_hash) && record?.layer === 'L2' &&
        timestamp(row.created_at, '事件操作时间') && !operationIds.has(row.operation_id),
      'INVALID_BACKUP', '经历操作元数据无效。');
      operationIds.add(row.operation_id);
      if (!skipped.has(row.record_id)) store.system.prepare('INSERT INTO event_operations VALUES(?,?,?,?)')
        .run(row.operation_id, row.payload_hash, row.record_id, row.created_at);
    }
    const focusSessions = new Set();
    for (const row of document.sessionFocus ?? []) {
      const task = row?.task_ref ? records.get(row.task_ref) : null;
      requireValue(row && typeof row.session_id === 'string' && row.session_id.length > 0 &&
        row.session_id.length <= 256 && !focusSessions.has(row.session_id) &&
        (row.task_ref === null || row.task_ref === undefined || task?.layer === 'L1') &&
        (row.scene_ref === null || row.scene_ref === undefined || /^[a-f0-9-]{36}$/.test(row.scene_ref)) &&
        timestamp(row.updated_at, '会话焦点更新时间'),
      'INVALID_BACKUP', '会话焦点元数据无效。');
      focusSessions.add(row.session_id);
      if ((!row.task_ref || !skipped.has(row.task_ref)) && (row.scene_ref || row.task_ref))
        store.system.prepare('INSERT INTO session_focus(session_id,task_ref,scene_ref,updated_at) VALUES(?,?,?,?)')
          .run(row.session_id, row.task_ref ?? null, row.scene_ref ?? null, row.updated_at);
    }
    const scenes = new Set();
    for (const row of document.scenes ?? []) {
      requireValue(row && /^[a-f0-9-]{36}$/.test(row.id) &&
        typeof row.title === 'string' && row.title.length > 0 && row.title.length <= 160 &&
        timestamp(row.created_at, '场景创建时间') && !scenes.has(row.id),
      'INVALID_BACKUP', '场景定义无效。');
      scenes.add(row.id);
      store.system.prepare('INSERT INTO scenes VALUES(?,?,?)').run(row.id, row.title, row.created_at);
    }
    const members = new Set();
    for (const row of document.sceneMembers ?? []) {
      requireValue(row && scenes.has(row.scene_id) && typeof row.session_id === 'string' &&
        row.session_id.length > 0 && row.session_id.length <= 256 &&
        timestamp(row.joined_at, '场景成员加入时间') &&
        !members.has(`${row.scene_id}:${row.session_id}`),
      'INVALID_BACKUP', '场景成员引用无效。');
      members.add(`${row.scene_id}:${row.session_id}`);
      store.system.prepare('INSERT INTO scene_members VALUES(?,?,?)')
        .run(row.scene_id, row.session_id, row.joined_at);
    }
    for (const record of normalized) {
      const sceneRef = record.source?.kind === 'session-event' ? record.source.sceneRef : null;
      if (!skipped.has(record.id) && scenes.has(sceneRef) &&
          store.system.prepare('SELECT 1 FROM scene_members WHERE scene_id=? AND session_id=?')
            .get(sceneRef, record.sessionId))
        store.system.prepare('INSERT INTO scene_records VALUES(?,?,?)')
          .run(sceneRef, record.id, record.sessionId);
    }
    const sceneOperations = new Set();
    for (const row of document.sceneOperations ?? []) {
      requireValue(row && /^[a-f0-9-]{36}$/.test(row.operation_id) &&
        /^[a-f0-9]{64}$/.test(row.payload_hash) && scenes.has(row.scene_id) &&
        timestamp(row.created_at, '场景操作时间') && !sceneOperations.has(row.operation_id),
      'INVALID_BACKUP', '场景操作元数据无效。');
      sceneOperations.add(row.operation_id);
      store.system.prepare('INSERT INTO scene_operations VALUES(?,?,?,?)')
        .run(row.operation_id, row.payload_hash, row.scene_id, row.created_at);
    }
    const graphPairs = new Set();
    for (const row of document.graphRelations ?? []) {
      const left = records.get(row?.leftId), right = records.get(row?.rightId);
      requireValue(left && right && left.layer !== 'L0' && right.layer !== 'L0' && row.leftId < row.rightId &&
        ['confirmed', 'excluded'].includes(row.state) &&
        typeof row.leftHash === 'string' && /^[a-f0-9]{64}$/.test(row.leftHash) &&
        typeof row.rightHash === 'string' && /^[a-f0-9]{64}$/.test(row.rightHash) &&
        timestamp(row.updatedAt, '图谱修正时间'), 'INVALID_BACKUP', '图谱修正引用或格式无效。');
      const key = `${row.leftId}:${row.rightId}`;
      requireValue(!graphPairs.has(key), 'INVALID_BACKUP', '备份包含重复图谱修正。');
      graphPairs.add(key);
      if (!skipped.has(row.leftId) && !skipped.has(row.rightId)) {
        store.system.prepare('INSERT INTO graph_relations VALUES(?,?,?,?,?,?)')
          .run(row.leftId, row.rightId, row.state, row.leftHash, row.rightHash, row.updatedAt);
      }
    }
    const privateRestore = restorePrivateJournal(store, document, blockedPrivateIds);
    store.reconciledForgetVersion = null;
    store.recover();
    const restoredCount = store.all().filter(record => record.layer !== 'L0').length;
    const restoredPrivateCount = store.privateDb.prepare('SELECT count(*) AS n FROM entries').get().n;
    store.rebuildViews();
    const expectedVersion = store.reconciledForgetVersion;
    const markers = store.system.prepare('SELECT * FROM tombstones').all();
    const keys = store.system.prepare('SELECT dedupe_key FROM forgotten_keys').all().map(row => row.dedupe_key);
    const privateMarkers = store.privateDb.prepare('SELECT id FROM private_tombstones').all().map(row => row.id);
    store.close();
    store = undefined;
    requireValue(!existsSync(target), 'SPACE_EXISTS', '恢复目标已被创建，请使用其他名称。', 409);
    ledger.publishRestore(name, lineageId, expectedVersion, markers, keys, privateMarkers, () => {
      renameSync(join(root, 'spaces', staging), target);
      published = true;
    });
    completed = true;
    return { space: name, records: restoredCount, skippedForgotten: normalized.length - restoredCount,
      forgetCoverage: coverage, privateCount: restoredPrivateCount,
      skippedPrivate: privateRestore.skipped };
  } catch (error) {
    if (published && !completed) {
      try { renameSync(target, join(root, 'spaces', staging)); }
      catch {
        throw new MemoryError('RESTORE_PUBLICATION_FAILED', `恢复未确认完成，目标目录可能存在，请检查：${target}`, 500);
      }
    }
    throw error;
  } finally {
    store?.close();
    if (!completed) rmSync(join(root, 'spaces', staging), { recursive: true, force: true });
  }
}
export function automaticBackup(space, root, { force = false } = {}) {
  const day = localDateKey(new Date(space.clock()));
  const mode = space.config.autoBackupMode;
  const key = mode === 'plain' ? null : readAutomaticKey(root);
  const lastRow = space.system.prepare("SELECT value FROM metadata WHERE key='backup'").get();
  const last = lastRow ? JSON.parse(lastRow.value) : null;
  const samePolicy = (last?.mode ?? 'plain') === mode && (last?.keyId ?? null) === (key?.id ?? null);
  if (!force && samePolicy && last?.day === day) return;
  const directory = join(root, 'backups', space.name);
  const snapshot = space.snapshot({ includePrivate: mode === 'encrypted-private' });
  const { createdAt, ...content } = snapshot;
  const serialized = JSON.stringify(content);
  const snapshotHash = key ? createHmac('sha256', key.password).update(serialized).digest('hex') : hash(serialized);
  if (!force && samePolicy && last?.hash === snapshotHash) return;
  mkdirSync(directory, { recursive: true });
  const filename = `backup-${day}-${randomUUID()}${key ? '.encrypted' : ''}.json`;
  atomicFile(join(directory, filename), packSnapshot(snapshot, key?.password ?? ''));
  space.system.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
    .run('backup', JSON.stringify({ day, hash: snapshotHash, filename, mode, keyId: key?.id ?? null }));
  const pattern = key ? /^backup-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.encrypted\.json$/ :
    /^backup-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.json$/;
  const files = readdirSync(directory).filter(name => pattern.test(name))
    .map(name => ({ name, time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => Number(b.name === filename) - Number(a.name === filename) || b.time - a.time)
    .map(file => file.name);
  for (const file of files.slice(space.config.backupKeep)) rmSync(join(directory, file));
  return filename;
}

const PRIVATE_NAME = /(^|[\\/._ -])(private|私密|私人)([\\/._ -]|$)/i;
const FORBIDDEN_NAME = /(^|[\\/])(\.env[^\\/]*|\.credentials[^\\/]*|credentials\.[^\\/]*|id_rsa[^\\/]*|[^\\/]*\.pem)$/i;
function headingCategory(heading) {
  if (/身份|个人资料|称呼|identity/i.test(heading)) return 'identity';
  if (/偏好|喜好|preference/i.test(heading)) return 'preference';
  if (/约定|规则|agreement/i.test(heading)) return 'agreement';
  if (/知识|经验|工具|knowledge/i.test(heading)) return 'knowledge';
  return 'event';
}
function markdownSections(content) {
  const sections = [];
  let heading = '', lines = [], fence = null;
  const flush = () => {
    const body = lines.join('\n').trim();
    lines = [];
    if (!body) return;
    let chunk = '', size = 0;
    const emit = () => {
      if (chunk.trim()) sections.push({ text: chunk.trim(), heading, at: null, oldId: String(sections.length) });
      chunk = ''; size = 0;
    };
    for (const paragraph of body.split(/\n\s*\n/)) {
      const part = `${chunk ? '\n\n' : ''}${paragraph}`;
      if (size >= 2000 && size + Buffer.byteLength(part) > 4000) emit();
      const value = `${chunk ? '\n\n' : ''}${paragraph}`;
      for (const char of value) {
        const bytes = Buffer.byteLength(char);
        if (size + bytes > 4000) emit();
        chunk += char; size += bytes;
      }
    }
    emit();
  };
  for (const line of content.replaceAll('\r\n', '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      lines.push(line); continue;
    }
    const title = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (title) { flush(); heading = title[1]; }
    else lines.push(line);
  }
  flush();
  return sections;
}
export function importPreview(files) {
  requireValue(Array.isArray(files) && files.length > 0 && files.length <= 100, 'INVALID_IMPORT', '每次导入 1–100 个文本文件。');
  let total = 0;
  const candidates = [], privateFiles = [];
  for (const file of files) {
    const name = string(file.name, '文件名', 500);
    requireValue(!FORBIDDEN_NAME.test(name), 'CREDENTIAL_FILE', '凭据文件不能导入记忆。');
    const content = string(file.text, '文件内容', 2 * 1024 * 1024);
    total += Buffer.byteLength(content);
    requireValue(total <= 10 * 1024 * 1024, 'IMPORT_TOO_LARGE', '每批最多 10 MiB。');
    const fingerprint = hash(content);
    if (file.private === true || PRIVATE_NAME.test(name)) {
      privateFiles.push({ fingerprint, content, filename: name });
      continue;
    }
    requireValue(/\.(md|markdown|txt|json)$/i.test(name), 'IMPORT_FORMAT', '支持 Markdown、文本和 fish-memory JSON。');
    let sections;
    if (/\.json$/i.test(name)) {
      const parsed = JSON.parse(content);
      requireValue(Array.isArray(parsed.memories), 'IMPORT_FORMAT', 'JSON 必须是包含 memories 数组的 fish-memory 数据。');
      sections = parsed.memories.map((m, i) => ({ text: string(m.text, '旧记忆正文'), at: m.at ?? null,
        oldId: String(m.id ?? i), heading: '', category: m.category, importance: m.importance }));
    } else {
      sections = markdownSections(content);
    }
    for (const section of sections) {
      const category = ['identity', 'preference', 'agreement', 'knowledge', 'event', 'task', 'self', 'observation']
        .includes(section.category) ? section.category : headingCategory(section.category ?? section.heading);
      const stable = ['identity', 'preference', 'agreement', 'knowledge'].includes(category);
      candidates.push({
        importId: hash(`${fingerprint}:${section.oldId}`), layer: stable ? 'L3' : 'L2',
        category, importance: section.importance, kind: 'historical', status: 'candidate',
        text: section.text, scope: 'space', sessionId: '',
        occurredAt: section.at && Number.isFinite(Date.parse(section.at)) ? new Date(section.at).toISOString() : null,
        source: { kind: 'import', file: basename(name.replaceAll('\\', '/')), fingerprint,
          section: section.oldId, heading: section.heading },
      });
    }
  }
  requireValue(candidates.length <= 3000, 'IMPORT_TOO_LARGE', '候选超过 3000 条，请拆分导入。');
  return { candidates, privateFiles };
}
export function applyImport(space, plan, selected) {
  requireValue(Array.isArray(selected) && selected.length <= plan.candidates.length, 'INVALID_SELECTION', '导入选择无效。');
  const ids = new Set(selected);
  requireValue(ids.size === selected.length && selected.every(id => plan.candidates.some(c => c.importId === id)), 'INVALID_SELECTION', '候选已变化，请重新预览。');
  let imported = 0;
  let privateCount = 0;
  const candidates = plan.candidates.filter(c => ids.has(c.importId));
  for (const candidate of candidates) normalizeRecord(candidate, space.now());
  try {
    for (const candidate of candidates) {
      space.create(candidate, { admin: true });
      imported++;
    }
    for (const file of plan.privateFiles) {
      const h = file.fingerprint;
      const id = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
      importPrivateEntry(space.privateDb, space.privateDirectory, {
        id, content: file.content, createdAt: space.now(), sourceIds: [], filename: file.filename
      });
      privateCount++;
    }
  } catch (error) {
    throw new MemoryError('IMPORT_PARTIAL',
      `导入未全部完成：已处理 ${imported} 条普通候选和 ${privateCount} 个私人文件。已写入部分保留，重试会去重。` +
      (error instanceof MemoryError ? error.message : '请检查数据目录后重试。'), error.status ?? 500);
  }
  return { imported, privateCount: plan.privateFiles.length, status: '候选已保存，历史内容尚未当作当前事实。' };
}
