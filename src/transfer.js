import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { atomicFile } from './database.js';
import { MemorySpace } from './store.js';
import { MAX_PRIVATE_CONTENT_LENGTH } from './private-journal.js';
import { hash, MemoryError, normalizeRecord, requireValue, slug, string, timestamp } from './model.js';

export function packBackup(space, password = '') {
  return packSnapshot(space.snapshot({ includePrivate: Boolean(password) }), password);
}
function packSnapshot(snapshot, password = '') {
  if (password) string(password, '备份口令', 256);
  requireValue(!password || password.length >= 12, 'WEAK_PASSWORD', '包含私人记录的备份口令至少 12 个字符。');
  const payload = JSON.stringify(snapshot);
  if (!password) return JSON.stringify({ format: 'tidal-backup', version: 1, sha256: hash(payload), payload });
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('tidal-backup-v1'));
  const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  key.fill(0);
  return JSON.stringify({ format: 'tidal-encrypted-backup', version: 1, salt: salt.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
export function unpackBackup(text, password = '') {
  string(text, '备份文件', 50 * 1024 * 1024);
  const envelope = JSON.parse(text);
  requireValue(envelope.version === 1, 'BACKUP_VERSION', '不支持此备份版本。');
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
      cipher.setAAD(Buffer.from('tidal-backup-v1'));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      payload = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
    } finally { key.fill(0); }
  } else {
    requireValue(envelope.format === 'tidal-backup' && typeof envelope.payload === 'string' &&
      typeof envelope.sha256 === 'string' && /^[a-f0-9]{64}$/.test(envelope.sha256), 'INVALID_BACKUP', '备份格式无效。');
    requireValue(timingSafeEqual(Buffer.from(hash(envelope.payload)), Buffer.from(envelope.sha256)), 'BACKUP_INTEGRITY', '备份校验失败。');
    payload = envelope.payload;
  }
  const document = JSON.parse(payload);
  requireValue(document.schema === 'tidal-memory' && document.version === 1 &&
    Array.isArray(document.records) && Array.isArray(document.revisions) && Array.isArray(document.tombstones) &&
    (document.reinforcements === undefined || Array.isArray(document.reinforcements)) &&
    (document.retrievalEvents === undefined || Array.isArray(document.retrievalEvents)),
  'INVALID_BACKUP', '记忆快照结构无效。');
  requireValue(envelope.format === 'tidal-encrypted-backup' ||
    (!document.privateEntries && !document.privateAliases && !document.privatePending),
  'PRIVATE_PLAINTEXT', '拒绝包含私人日记的明文备份。');
  return document;
}
export function restoreBackup(root, name, text, password, config) {
  slug(name);
  const target = join(root, 'spaces', name);
  requireValue(!existsSync(target), 'SPACE_EXISTS', '恢复必须使用一个尚不存在的新空间。', 409);
  const document = unpackBackup(text, password);
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
  const staging = `restore-${randomUUID()}`;
  let store;
  let completed = false;
  try {
    store = new MemorySpace(root, staging, { config });
    for (const record of normalized) store.persist(record);
    for (const revision of document.revisions) {
      requireValue(records.has(revision.record.id) && revision.layer === revision.record.layer, 'INVALID_BACKUP', '版本历史引用无效。');
      const validated = validate(revision.record);
      const current = records.get(validated.id);
      requireValue(current.layer === revision.layer && validated.revision <= current.revision,
        'INVALID_BACKUP', '版本历史层级或编号无效。');
      store.db(revision.layer).prepare('INSERT OR REPLACE INTO revisions VALUES(?,?,?)')
        .run(validated.id, validated.revision, JSON.stringify(validated));
    }
    for (const row of document.tombstones) {
      string(row.id, '删除 ID', 64);
      string(row.dedupe_key, '删除摘要', 64);
      store.system.prepare('INSERT INTO tombstones VALUES(?,?)').run(row.id, row.dedupe_key);
    }
    for (const key of document.forgottenKeys ?? []) {
      requireValue(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key), 'INVALID_BACKUP', '遗忘标记无效。');
      store.system.prepare('INSERT OR IGNORE INTO forgotten_keys VALUES(?)').run(key);
    }
    for (const row of document.reinforcements ?? []) {
      requireValue(row && typeof row === 'object' && records.has(row.id), 'INVALID_BACKUP', '强化依据引用无效。');
      string(row.evidence, '强化依据', 256);
      store.system.prepare('INSERT INTO reinforcements VALUES(?,?)').run(row.id, row.evidence);
    }
    for (const row of document.retrievalEvents ?? []) {
      requireValue(row && typeof row === 'object' && records.get(row.id)?.layer === row.layer &&
        row.layer !== 'L0' && typeof row.evidence === 'string' && /^recall:[a-f0-9]{64}$/.test(row.evidence),
      'INVALID_BACKUP', '召回依据引用无效。');
      store.db(row.layer).prepare('INSERT INTO retrieval_events VALUES(?,?)').run(row.id, row.evidence);
    }
    requireValue((document.privateEntries === undefined || Array.isArray(document.privateEntries)) &&
      (document.privateAliases === undefined || Array.isArray(document.privateAliases)) &&
      (document.privatePending === undefined || Array.isArray(document.privatePending)),
    'INVALID_BACKUP', '私人记录备份结构无效。');
    const privateIds = new Set();
    for (const entry of document.privateEntries ?? []) {
      string(entry.id, '私人记录 ID', 64);
      slug(entry.author);
      string(entry.content, '私人正文', MAX_PRIVATE_CONTENT_LENGTH);
      requireValue(entry.content.length <= MAX_PRIVATE_CONTENT_LENGTH, 'INVALID_BACKUP', '私人正文过长。');
      const created = timestamp(entry.created_at, '私人记录时间');
      const updated = timestamp(entry.updated_at, '私人记录更新时间');
      const day = entry.day_key ?? null, revision = entry.revision ?? 1, contentHash = entry.content_hash ?? null;
      let sources;
      try { sources = JSON.parse(entry.source_ids); }
      catch { throw new MemoryError('INVALID_BACKUP', '私人记录来源元数据无效。'); }
      requireValue(created && Array.isArray(sources) && sources.length <= 10000 &&
        sources.every(id => typeof id === 'string') && Number.isSafeInteger(revision) && revision > 0 &&
        (day === null || (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
          Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
          new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day)) &&
        (contentHash === null || contentHash === hash(entry.content)) &&
        (day === null || (updated && contentHash)), 'INVALID_BACKUP', '私人记录元数据无效。');
      requireValue(!privateIds.has(entry.id), 'INVALID_BACKUP', '私人记录 ID 重复。');
      privateIds.add(entry.id);
      store.privateDb.prepare('INSERT INTO entries(id,author,content,created_at,source_ids) VALUES(?,?,?,?,?)')
        .run(entry.id, entry.author, entry.content, created, JSON.stringify(sources));
      if (day !== null) store.privateDb.prepare('INSERT INTO entry_state VALUES(?,?,?,?,?,?)')
        .run(entry.id, entry.author, day, revision, updated, contentHash);
    }
    for (const alias of document.privateAliases ?? []) {
      requireValue(alias && typeof alias === 'object' && typeof alias.alias_id === 'string' &&
        alias.alias_id.length > 0 && alias.alias_id.length <= 64 && !privateIds.has(alias.alias_id) &&
        privateIds.has(alias.entry_id), 'INVALID_BACKUP', '私人记录别名无效。');
      store.privateDb.prepare('INSERT INTO entry_aliases VALUES(?,?)').run(alias.alias_id, alias.entry_id);
    }
    for (const pending of document.privatePending ?? []) {
      requireValue(pending && privateIds.has(pending.entry_id), 'INVALID_BACKUP', '私人整理待处理项无效。');
      store.privateDb.prepare('INSERT INTO journal_pending VALUES(?)').run(pending.entry_id);
    }
    store.rebuildViews();
    store.close();
    store = undefined;
    requireValue(!existsSync(target), 'SPACE_EXISTS', '恢复目标已被创建，请使用其他名称。', 409);
    renameSync(join(root, 'spaces', staging), target);
    completed = true;
    return { space: name, records: normalized.length, privateCount: document.privateEntries?.length ?? 0 };
  } finally {
    store?.close();
    if (!completed) rmSync(join(root, 'spaces', staging), { recursive: true, force: true });
  }
}
export function automaticBackup(space, root, { force = false } = {}) {
  const day = space.now().slice(0, 10);
  const last = space.system.prepare("SELECT value FROM metadata WHERE key='backup'").get();
  if (!force && last && JSON.parse(last.value).day === day) return;
  const directory = join(root, 'backups', space.name);
  const snapshot = space.snapshot();
  const { createdAt, ...content } = snapshot;
  const snapshotHash = hash(JSON.stringify(content));
  if (!force && last && JSON.parse(last.value).hash === snapshotHash) return;
  mkdirSync(directory, { recursive: true });
  const filename = `backup-${day}-${randomUUID()}.json`;
  atomicFile(join(directory, filename), packSnapshot(snapshot));
  space.system.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
    .run('backup', JSON.stringify({ day, hash: snapshotHash, filename }));
  const files = readdirSync(directory).filter(name => /^backup-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.json$/.test(name))
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
      privateFiles.push({ fingerprint, content });
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
      space.privateDb.prepare('INSERT OR IGNORE INTO entries(id,author,content,created_at,source_ids) VALUES(?,?,?,?,?)')
        .run(id, 'legacy-import', file.content, space.now(), '[]');
      privateCount++;
    }
  } catch (error) {
    throw new MemoryError('IMPORT_PARTIAL',
      `导入未全部完成：已处理 ${imported} 条普通候选和 ${privateCount} 个私人文件。已写入部分保留，重试会去重。` +
      (error instanceof MemoryError ? error.message : '请检查数据目录后重试。'), error.status ?? 500);
  }
  return { imported, privateCount: plan.privateFiles.length, status: '候选已保存，历史内容尚未当作当前事实。' };
}
