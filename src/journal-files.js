import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { requireValue } from './model.js';

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
  new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export function dailyJournalPath(day) {
  requireValue(validDay(day), 'INVALID_DATE', '私人记录日期无效。');
  return `${day}.md`;
}

export const privateJournalDatabasePath = directory => join(directory, 'system', 'private', 'journal.sqlite3');
export const journalTransactionDirectory = root => join(dirname(root), 'system', 'private', 'transactions');

export function undatedJournalPath(id) {
  requireValue(typeof id === 'string' && id.length > 0 && id.length <= 256, 'INVALID_ID', '私人记录 ID 无效。');
  return `undated/${digest(id)}.md`;
}

function resolveJournalPath(root, relative) {
  requireValue(typeof relative === 'string' &&
    /^(?:(?:\d{4}\/)?\d{4}-\d{2}-\d{2}\.md|undated\/[a-f0-9]{64}\.md|\.transactions\/[a-f0-9-]{36}\.tmp)$/.test(relative),
  'INVALID_JOURNAL_PATH', '日记文件路径无效。', 409);
  if (relative.startsWith('.transactions/'))
    return join(journalTransactionDirectory(root), relative.slice('.transactions/'.length));
  const base = resolve(root);
  const file = resolve(base, ...relative.split('/'));
  requireValue(file.startsWith(`${base}${sep}`), 'INVALID_JOURNAL_PATH', '日记文件路径越界。', 409);
  return file;
}

export function migrateJournalStaging(root) {
  const legacy = join(root, '.transactions');
  if (!existsSync(legacy)) return;
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    requireValue(entry.isFile() && /^[a-f0-9-]{36}\.tmp$/.test(entry.name),
      'JOURNAL_STAGE_CONFLICT', '旧日记暂存目录含未知文件，未移动或删除。', 409);
    const source = join(legacy, entry.name), target = join(journalTransactionDirectory(root), entry.name);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      requireValue(digest(readFileSync(source)) === digest(readFileSync(target)),
        'JOURNAL_STAGE_CONFLICT', '新旧日记暂存文件不一致，未覆盖。', 409);
      rmSync(source);
    } else renameSync(source, target);
  }
  rmdirSync(legacy);
}

export function removeEmptyJournalDirectories(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^(?:\d{4}|undated)$/.test(entry.name)) {
      const directory = join(root, entry.name);
      if (readdirSync(directory).length === 0) rmdirSync(directory);
    }
  }
}

export function readJournalFile(root, relative) {
  const file = resolveJournalPath(root, relative);
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function stageJournalFile(root, relative, content, operationId = randomUUID()) {
  const target = resolveJournalPath(root, relative);
  const temporary = `.transactions/${operationId}.tmp`;
  const staged = resolveJournalPath(root, temporary);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(staged), { recursive: true });
  const descriptor = openSync(staged, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(staged, { force: true });
    throw error;
  }
  closeSync(descriptor);
  return { temporary, relative, hash: digest(content) };
}

export function publishJournalFile(root, staged) {
  const temporary = resolveJournalPath(root, staged.temporary);
  const target = resolveJournalPath(root, staged.relative);
  requireValue(existsSync(temporary), 'JOURNAL_STAGE_MISSING', '日记暂存文件丢失，保留原正文并停止恢复。', 409);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(temporary, target);
}

export function writeJournalFile(root, relative, content) {
  const staged = stageJournalFile(root, relative, content);
  publishJournalFile(root, staged);
  return staged.hash;
}

export function removeJournalFile(root, relative) {
  rmSync(resolveJournalPath(root, relative), { force: true });
}

export function journalFileHash(content) {
  return digest(content);
}

export function listJournalFiles(root) {
  const files = [];
  const visit = (directory, relative = '') => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (relative === '' && entry.name === '.transactions') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(childPath, childRelative);
      else if (/^(?:(?:\d{4}\/)?\d{4}-\d{2}-\d{2}\.md|undated\/[a-f0-9]{64}\.md)$/.test(childRelative))
        files.push({ path: childRelative, content: readFileSync(childPath, 'utf8') });
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
