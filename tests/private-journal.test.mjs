import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemorySpace } from '../src/store.js';
import { openDatabase, transaction } from '../src/database.js';
import { packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';
import { journalFileHash, stageJournalFile, journalTransactionDirectory, privateJournalDatabasePath,
  undatedJournalPath, writeJournalFile, publishJournalFile } from '../src/journal-files.js';
import { appendPrivateEntry, importPrivateEntry, originalJournalDay, migratePrivateJournalLayout } from '../src/private-journal.js';

const admin = { admin: true };
const password = 'synthetic-password-123';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-private-test-'));
  let now = new Date(2026, 2, 4, 12, 0).getTime();
  const options = { clock: () => now, config: { privateWriters: ['author-a', 'author-b'] } };
  const spaces = [];
  t.after(() => { for (const space of spaces) space.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, options,
    open(name = 'shared') { const space = new MemorySpace(root, name, options); spaces.push(space); return space; },
    get now() { return now; },
    set now(value) { now = value; }
  };
}
const legacyInsert = (db, id, author, content, created) => db.prepare(
  'INSERT INTO entries(id,author,content,created_at,source_ids) VALUES(?,?,?,?,?)',
).run(id, author, content, created, '[]');

test('daily Markdown is authoritative and SQLite stores metadata only', t => {
  const f = fixture(t), space = f.open();
  const first = space.appendPrivate('author-a', 'SYNTHETIC_PRIVATE_FIRST');
  f.now += 1000;
  const second = space.appendPrivate('author-a', 'SYNTHETIC_PRIVATE_SECOND');
  assert.notEqual(first.id, second.id);
  const status = space.privateStatus();
  assert.equal(status.format, 'markdown');
  assert.equal(status.count, 2);
  assert.equal(status.dailyCount, 1);
  assert.equal(status.contentVisible, false);
  const file = join(space.privateDirectory, '2026-03-04.md');
  const markdown = readFileSync(file, 'utf8');
  assert.match(markdown, /SYNTHETIC_PRIVATE_FIRST/);
  assert.match(markdown, /SYNTHETIC_PRIVATE_SECOND/);
  assert.equal(space.privateDb.prepare('PRAGMA table_info(entries)').all().some(column => column.name === 'content'), false);
  assert.equal(JSON.stringify(status).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 2);
  assert.notEqual(space.appendPrivate('author-b', 'another author').id, first.id);
  f.now = new Date(2026, 2, 5, 0, 1).getTime();
  assert.notEqual(space.appendPrivate('author-a', 'another day').id, first.id);
  assert.equal(space.privateStatus().dailyCount, 2);
  assert.deepEqual(readdirSync(space.privateDirectory).sort(), ['2026-03-04.md', '2026-03-05.md']);
  assert.equal(existsSync(privateJournalDatabasePath(space.directory)), true);
  assert.equal(existsSync(join(space.privateDirectory, 'journal.sqlite3')), false);
  assert.throws(() => space.appendPrivate('not-authorized', 'not saved'), { code: 'PRIVATE_WRITER_DISABLED' });
});

test('legacy SQLite bodies migrate losslessly and unknown dates are explicitly labeled archival dates', t => {
  const f = fixture(t);
  const privateDirectory = join(f.root, 'spaces', 'shared', 'private');
  const db = openDatabase(join(privateDirectory, 'journal.sqlite3'));
  db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY,author TEXT NOT NULL,content TEXT NOT NULL,
    created_at TEXT NOT NULL,source_ids TEXT NOT NULL);
    CREATE TABLE entry_state (entry_id TEXT PRIMARY KEY,author TEXT NOT NULL,day_key TEXT,
      revision INTEGER NOT NULL,updated_at TEXT NOT NULL,content_hash TEXT);
    CREATE TABLE entry_aliases (alias_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL);
    CREATE TABLE journal_pending (entry_id TEXT PRIMARY KEY);
    CREATE TABLE journal_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE private_tombstones (id TEXT PRIMARY KEY);
    PRAGMA user_version=1;`);
  const known = '2026-03-02T10:00:00.000Z';
  legacyInsert(db, 'known-id', 'author-a', 'LEGACY\nBODY', known);
  legacyInsert(db, 'unknown-id', 'legacy-import', 'UNDATED_BODY', '2020-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO entry_state VALUES(?,?,?,?,?,?)')
    .run('known-id', 'author-a', '2026-03-02', 3, known, journalFileHash('LEGACY\nBODY'));
  db.prepare('INSERT INTO entry_aliases VALUES(?,?)').run('legacy-alias', 'known-id');
  db.prepare('INSERT INTO journal_pending VALUES(?)').run('known-id');
  db.prepare('INSERT INTO journal_metadata VALUES(?,?)').run('migration-note', 'kept');
  db.prepare('INSERT INTO private_tombstones VALUES(?)').run('forgotten-id');
  db.close();

  const space = f.open();
  const dated = readFileSync(join(privateDirectory, '2026-03-02.md'), 'utf8');
  const archivedFile = space.privateDb.prepare("SELECT relative_path FROM entries WHERE id='unknown-id'").get().relative_path;
  assert.match(archivedFile, /^2020-01-0[12]\.md$/);
  assert.match(dated, /LEGACY\nBODY/);
  assert.match(readFileSync(join(privateDirectory, archivedFile), 'utf8'), /UNDATED_BODY/);
  assert.match(readFileSync(join(privateDirectory, archivedFile), 'utf8'), /原日期未知/);
  assert.equal(space.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?').get('legacy-alias').entry_id,
    'known-id');
  assert.equal(space.privateDb.prepare('SELECT state FROM journal_pending WHERE entry_id=?').get('known-id').state, 'pending');
  assert.equal(space.privateDb.prepare('SELECT value FROM journal_metadata WHERE key=?').get('migration-note').value, 'kept');
  assert.ok(space.privateDb.prepare('SELECT 1 FROM private_tombstones WHERE id=?').get('forgotten-id'));
  assert.equal(space.privateDb.prepare('PRAGMA table_info(entries)').all().some(column => column.name === 'content'), false);
  assert.equal(space.privateStatus().count, 2);
  assert.equal(space.privateStatus().importedCount, 1);
  assert.equal(space.privateStatus().lastContributionAt, known);
  assert.equal(space.privateStatus().lastImportedAt, '2020-01-01T00:00:00.000Z');
  assert.ok(readdirSync(privateDirectory).every(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)));
});

test('pending Markdown publication recovers from its fsynced staging file after restart', t => {
  const f = fixture(t), space = f.open();
  const day = '2026-03-04', path = `${day.slice(0, 4)}/${day}.md`;
  const id = 'a06ddcde-a301-4c44-85a0-8870e316c421';
  const created = new Date(f.now).toISOString();
  const content = `# ${day}\n\n## 待整理贡献\n\n<!-- tidal-entry:${id} -->\n### ${created} · author-a\n\nRECOVERY_CANARY\n<!-- /tidal-entry:${id} -->\n\n`;
  const staged = stageJournalFile(space.privateDirectory, path, content);
  mkdirSync(join(space.privateDirectory, '.transactions'), { recursive: true });
  renameSync(join(journalTransactionDirectory(space.privateDirectory), staged.temporary.split('/')[1]),
    join(space.privateDirectory, ...staged.temporary.split('/')));
  transaction(space.privateDb, () => {
    space.privateDb.prepare(`INSERT INTO entries
      (id,author,created_at,source_ids,day_key,relative_path,revision,content_hash) VALUES(?,?,?,?,?,?,1,?)`)
      .run(id, 'author-a', created, '[]', day, path, journalFileHash('RECOVERY_CANARY'));
    space.privateDb.prepare('INSERT INTO journal_pending(entry_id,state,updated_at) VALUES(?,?,?)')
      .run(id, 'pending', created);
    space.privateDb.prepare(`INSERT INTO journal_transactions
      (operation_id,entry_id,day_key,relative_path,temporary_path,old_hash,new_hash,revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(staged.temporary.slice('.transactions/'.length, -'.tmp'.length), id, day, path,
        staged.temporary, null, staged.hash, 1, created);
  });
  space.close();
  const reopened = f.open();
  assert.match(readFileSync(join(reopened.privateDirectory, '2026-03-04.md'), 'utf8'), /RECOVERY_CANARY/);
  assert.deepEqual(readdirSync(reopened.privateDirectory), ['2026-03-04.md']);
  assert.equal(reopened.privateDb.prepare('SELECT count(*) AS n FROM journal_transactions').get().n, 0);
  assert.equal(reopened.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 1);
});

test('private review is route-bound, segmented, observed after replies, and version-checked before organization', t => {
  const f = fixture(t), space = f.open();
  const day = '2026-03-04';
  space.appendPrivate('author-a', 'REVIEW_CANARY\n' + 'x'.repeat(2200));
  f.now = new Date(2026, 2, 5, 12, 0).getTime();
  const read = (provider = 'approved-provider') => space.privateJournalContext({
    sessionId: 'approved-main', provider, model: 'approved-model', now: new Date(f.now), maxBytes: 1024,
  });
  const wrongRoute = read('other-provider');
  assert.ok(wrongRoute);
  assert.equal(space.recordPrivateObservation(wrongRoute.receipt), true);
  let candidate = read();
  assert.equal(candidate.receipt.segmentIndex, 0);
  assert.ok(Buffer.byteLength(candidate.text) <= 1024);
  assert.throws(() => space.organizePrivateDay({
    day, expectedHash: candidate.receipt.contentHash, markdown: '整理摘要',
    sessionId: 'approved-main', provider: 'approved-provider', model: 'approved-model',
    maxBytes: 1024,
  }), { code: 'JOURNAL_NOT_FULLY_OBSERVED' });
  let segmentCount = candidate.receipt.segmentCount;
  for (let index = 0; index < segmentCount; index++) {
    candidate = read();
    assert.equal(candidate.receipt.segmentIndex, index);
    assert.equal(space.recordPrivateObservation(candidate.receipt), true);
  }
  assert.equal(read(), null);
  const result = space.organizePrivateDay({
    day, expectedHash: candidate.receipt.contentHash, markdown: '## 合成回顾\n\n保留原始贡献。',
    sessionId: 'approved-main', provider: 'approved-provider', model: 'approved-model',
    maxBytes: 1024,
  });
  assert.equal(result.saved, true);
  assert.equal(read(), null);
  const file = join(space.privateDirectory, `${day}.md`);
  const organized = readFileSync(file, 'utf8');
  assert.match(organized, /REVIEW_CANARY/);
  assert.match(organized, /保留原始贡献/);
  appendPrivateEntry(space.privateDb, space.privateDirectory, {
    author: 'author-b', content: 'LATE_CONTRIBUTION', now: '2026-03-04T13:00:00.000Z',
  });
  const updated = readFileSync(file, 'utf8');
  assert.ok(updated.indexOf('LATE_CONTRIBUTION') < updated.indexOf('<!-- tidal-organized:start -->'));
  assert.notEqual(read()?.receipt.contentHash, result.contentHash);
});

test('private Markdown is encrypted in v4 backups and restored as files, never SQLite bodies', t => {
  const f = fixture(t), space = f.open();
  const entry = space.appendPrivate('author-a', 'BACKUP_PRIVATE_CANARY');
  f.now = new Date(2026, 2, 5, 12, 0).getTime();
  const review = space.privateJournalContext({
    sessionId: 'backup-main', provider: 'backup-provider', model: 'backup-model', now: new Date(f.now),
  });
  assert.ok(review);
  assert.equal(space.recordPrivateObservation(review.receipt), true);
  space.organizePrivateDay({
    day: review.receipt.day, expectedHash: review.receipt.contentHash,
    markdown: '备份中的合成整理结果。', sessionId: 'backup-main',
    provider: 'backup-provider', model: 'backup-model',
  });
  const plain = packBackup(space);
  assert.equal(plain.includes('BACKUP_PRIVATE_CANARY'), false);
  assert.equal(unpackBackup(plain).privateFiles, undefined);
  assert.equal(unpackBackup(plain).privateObservations, undefined);
  const encrypted = packBackup(space, password);
  assert.equal(encrypted.includes('BACKUP_PRIVATE_CANARY'), false);
  const document = unpackBackup(encrypted, password);
  assert.equal(document.version, 4);
  assert.equal(document.privateEntries.length, 1);
  assert.equal(document.privateObservations.length, 1);
  assert.equal(document.privateOrganized.length, 1);
  assert.equal(Object.hasOwn(document.privateEntries[0], 'content'), false);
  assert.equal(document.privateFiles.length, 1);
  assert.match(document.privateFiles[0].content, /BACKUP_PRIVATE_CANARY/);
  restoreBackup(f.root, 'restored', encrypted, password, f.options.config);
  const restored = f.open('restored');
  const row = restored.privateDb.prepare('SELECT * FROM entries WHERE id=?').get(entry.id);
  assert.equal(Object.hasOwn(row, 'content'), false);
  assert.match(readFileSync(join(restored.privateDirectory, ...row.relative_path.split('/')), 'utf8'),
    /BACKUP_PRIVATE_CANARY/);
  assert.equal(restored.privateDb.prepare('SELECT count(*) AS n FROM journal_observations').get().n, 1);
  assert.equal(restored.privateDb.prepare('SELECT count(*) AS n FROM journal_organized').get().n, 1);
  f.now = new Date(2026, 2, 4, 12, 0).getTime();
  assert.equal(restored.appendPrivate('author-a', 'AFTER_RESTORE').day_key, '2026-03-04');
  const changed = structuredClone(document);
  changed.privateFiles[0].sha256 = '0'.repeat(64);
  const envelope = JSON.stringify({ format: 'tidal-backup', version: 3, sha256: '0'.repeat(64), payload: JSON.stringify(changed) });
  assert.throws(() => restoreBackup(f.root, 'invalid-restore', envelope, '', {}));
  assert.equal(existsSync(join(f.root, 'spaces', 'invalid-restore')), false);
});

test('private forget and clear remove Markdown bodies but preserve metadata tombstones', t => {
  const f = fixture(t), space = f.open();
  const first = space.appendPrivate('author-a', 'FORGET_CANARY');
  const second = space.appendPrivate('author-a', 'KEEP_CANARY');
  const path = join(space.privateDirectory, '2026-03-04.md');
  space.privateDb.prepare('INSERT INTO entry_aliases(alias_id,entry_id) VALUES(?,?)').run('legacy-alias', first.id);
  space.forgetLedger.addPrivate(space.lineageId, [first.id, 'legacy-alias']);
  space.reconcileForgetLedger();
  assert.equal(readFileSync(path, 'utf8').includes('FORGET_CANARY'), false);
  assert.equal(readFileSync(path, 'utf8').includes('KEEP_CANARY'), true);
  assert.equal(space.privateStatus().count, 1);
  assert.throws(() => space.clearPrivate(admin, 'wrong'), { code: 'CONFIRMATION_REQUIRED' });
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  assert.equal(space.privateStatus().count, 0);
  assert.equal(existsSync(path), false);
  assert.ok(space.privateDb.prepare('SELECT 1 FROM private_tombstones WHERE id=?').get(second.id));
});

test('dates come from original filenames or explicit metadata, never incidental prose', () => {
  assert.equal(originalJournalDay('【旧日记原件：archive/2026-10-24.private.md】\n\nBody'), '2026-10-24');
  assert.equal(originalJournalDay('Text', 'private/2026-10-24.md'), '2026-10-24');
  assert.equal(originalJournalDay('---\ndate: "2026-10-24"\n---\nText'), '2026-10-24');
  assert.equal(originalJournalDay('# Journal 2026-10-24\nText'), '2026-10-24');
  assert.equal(originalJournalDay('We discussed an event on 2026-10-24.'), null);
  assert.equal(originalJournalDay('# Journal 2026-02-30\nText'), null);
  assert.equal(originalJournalDay('Text', 'private/2026-02-30.md'), null);
  assert.equal(originalJournalDay('Text', 'private/2026-10-241.md'), null);
  assert.equal(originalJournalDay('【旧日记原件：archive/2026-10-241.md】'), null);
});

function addUndated(space, content, created = '2026-11-01T12:00:00.000Z') {
  const id = randomUUID(), path = undatedJournalPath(id), hash = journalFileHash(content);
  const document = `<!-- tidal-entry:${id} sha256:${hash} -->\n### ${created} · legacy-import\n\n${content}\n<!-- /tidal-entry:${id} -->\n\n`;
  writeJournalFile(space.privateDirectory, path, document);
  space.privateDb.prepare(`INSERT INTO entries(id,author,created_at,source_ids,day_key,relative_path,revision,content_hash)
    VALUES(?,'legacy-import',?,'[]',NULL,?,1,?)`).run(id, created, path, hash);
  space.privateDb.prepare("INSERT INTO journal_pending VALUES(?,'pending',?)").run(id, created);
  return { id, path, document, content, hash };
}

test('0.8.0 undated imports are merged by original date and migration is lossless and idempotent', t => {
  const f = fixture(t), space = f.open();
  const a = addUndated(space, '【旧日记原件：archive/2026-10-24.private.md】\n\nFIRST\r\nORIGINAL');
  const b = addUndated(space, '【旧日记原件：archive/2026-10-24.other.md】\n\nSECOND ORIGINAL');
  space.privateDb.prepare('INSERT INTO entry_aliases VALUES(?,?)').run('kept-alias', a.id);
  const directory = space.directory;
  space.close();
  renameSync(privateJournalDatabasePath(directory), join(directory, 'private', 'journal.sqlite3'));
  const reopened = f.open();
  const document = readFileSync(join(reopened.privateDirectory, '2026-10-24.md'), 'utf8');
  for (const original of [a, b]) {
    assert.equal(document.split(original.content).length - 1, 1);
    const row = reopened.privateDb.prepare('SELECT * FROM entries WHERE id=?').get(original.id);
    assert.equal(row.content_hash, original.hash);
    assert.equal(row.relative_path, '2026-10-24.md');
    assert.equal(row.day_key, '2026-10-24');
  }
  assert.equal(reopened.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?').get('kept-alias').entry_id, a.id);
  assert.equal(reopened.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 2);
  assert.deepEqual(readdirSync(reopened.privateDirectory), ['2026-10-24.md']);
  reopened.close();
  const twice = f.open();
  assert.equal(readFileSync(join(twice.privateDirectory, '2026-10-24.md'), 'utf8'), document);
  assert.equal(twice.privateStatus().dailyCount, 1);
});

test('imports append to date Markdown, retry without duplicates, and label archival dates', t => {
  const f = fixture(t), space = f.open();
  const options = { id: randomUUID(), content: 'NAMED_IMPORT', filename: 'private/2026-03-02.md',
    createdAt: '2026-03-04T12:00:00.000Z' };
  const first = importPrivateEntry(space.privateDb, space.privateDirectory, options);
  assert.equal(first.day_key, '2026-03-02');
  assert.equal(importPrivateEntry(space.privateDb, space.privateDirectory, options).id, first.id);
  importPrivateEntry(space.privateDb, space.privateDirectory, { ...options, id: randomUUID(), content: 'SECOND_IMPORT' });
  const text = readFileSync(join(space.privateDirectory, '2026-03-02.md'), 'utf8');
  assert.equal(text.split('NAMED_IMPORT').length - 1, 1);
  assert.ok(text.includes('SECOND_IMPORT'));
  const unknown = importPrivateEntry(space.privateDb, space.privateDirectory, {
    id: randomUUID(), content: 'An event mentioned 2020-01-01.', createdAt: '2026-03-04T12:00:00.000Z',
  });
  const archive = readFileSync(join(space.privateDirectory, unknown.relative_path), 'utf8');
  assert.match(unknown.relative_path, /^2026-03-0[45]\.md$/);
  assert.match(archive, /原日期未知/);
  assert.ok(readdirSync(space.privateDirectory).every(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)));
  assert.throws(() => importPrivateEntry(space.privateDb, space.privateDirectory, {
    id: randomUUID(), content: 'INVALID_TIME', createdAt: 'not-a-date',
  }), { code: 'INVALID_PRIVATE_DATE' });
  assert.throws(() => appendPrivateEntry(space.privateDb, space.privateDirectory, {
    author: 'author-a', content: 'INVALID_TIME', now: 'not-a-date',
  }), { code: 'INVALID_PRIVATE_DATE' });
});

test('originals merge into an existing date without replacing prior contributions', t => {
  const f = fixture(t), space = f.open();
  space.appendPrivate('author-a', 'EXISTING_DAY');
  addUndated(space, '【旧日记原件：archive/2026-03-04.private.md】\n\nIMPORTED_DAY');
  migratePrivateJournalLayout(space.privateDb, space.privateDirectory);
  const text = readFileSync(join(space.privateDirectory, '2026-03-04.md'), 'utf8');
  assert.equal(text.split('EXISTING_DAY').length - 1, 1);
  assert.equal(text.split('IMPORTED_DAY').length - 1, 1);
  assert.equal(space.privateStatus().count, 2);
  assert.deepEqual(readdirSync(space.privateDirectory), ['2026-03-04.md']);
  space.close();
  assert.equal(readFileSync(join(f.open().privateDirectory, '2026-03-04.md'), 'utf8'), text);
});

test('two distinct SQLite indexes are never overwritten during migration', t => {
  const f = fixture(t), space = f.open();
  space.appendPrivate('author-a', 'KEPT_IN_NEW_INDEX');
  space.close();
  const legacy = openDatabase(join(space.privateDirectory, 'journal.sqlite3'));
  legacy.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('old-index')");
  legacy.close();
  assert.throws(() => f.open(), { code: 'JOURNAL_INDEX_CONFLICT' });
  assert.equal(existsSync(privateJournalDatabasePath(space.directory)), true);
  assert.equal(existsSync(join(space.privateDirectory, 'journal.sqlite3')), true);
  assert.match(readFileSync(join(space.privateDirectory, '2026-03-04.md'), 'utf8'), /KEPT_IN_NEW_INDEX/);
});

test('dated target conflicts preserve old original files and metadata', t => {
  const f = fixture(t), space = f.open();
  const entry = addUndated(space, '【旧日记原件：archive/2026-10-24.md】\n\nORIGINAL');
  writeFileSync(join(space.privateDirectory, '2026-10-24.md'), 'UNRELATED_HANDWRITTEN_FILE');
  assert.throws(() => migratePrivateJournalLayout(space.privateDb, space.privateDirectory), { code: 'JOURNAL_MIGRATION_CONFLICT' });
  assert.equal(readFileSync(join(space.privateDirectory, ...entry.path.split('/')), 'utf8'), entry.document);
  assert.equal(space.privateDb.prepare('SELECT relative_path FROM entries WHERE id=?').get(entry.id).relative_path, entry.path);
  assert.equal(readFileSync(join(space.privateDirectory, '2026-10-24.md'), 'utf8'), 'UNRELATED_HANDWRITTEN_FILE');
});

test('layout publication resumes before and after publication and after metadata commit', t => {
  for (const phase of ['pending', 'published', 'cleanup']) {
    const f = fixture(t), space = f.open();
    const entry = addUndated(space, '【旧日记原件：archive/2026-10-24.md】\n\nRECOVERY');
    const path = '2026-10-24.md', content = `# 2026-10-24\n\n${entry.document}`;
    const staged = stageJournalFile(space.privateDirectory, path, content);
    const plan = { phase: phase === 'cleanup' ? 'cleanup' : 'pending',
      entries: [{ id: entry.id, day: '2026-10-24' }],
      sources: [{ path: entry.path, hash: journalFileHash(entry.document) }],
      documents: [{ ...staged, day: '2026-10-24', oldHash: null, revision: 1, updatedAt: '2026-11-01T12:00:00.000Z' }] };
    if (phase !== 'pending') publishJournalFile(space.privateDirectory, staged);
    if (phase === 'cleanup') {
      space.privateDb.prepare('UPDATE entries SET day_key=?,relative_path=? WHERE id=?').run('2026-10-24', path, entry.id);
      space.privateDb.prepare('INSERT INTO journal_days VALUES(?,?,1,?,?)').run('2026-10-24', path,
        '2026-11-01T12:00:00.000Z', staged.hash);
    }
    space.privateDb.prepare("INSERT INTO journal_metadata VALUES('layout-migration',?)").run(JSON.stringify(plan));
    space.close();
    const reopened = f.open();
    assert.equal(readFileSync(join(reopened.privateDirectory, path), 'utf8'), content);
    assert.deepEqual(readdirSync(reopened.privateDirectory), [path]);
    assert.equal(reopened.privateDb.prepare("SELECT count(*) AS n FROM journal_metadata WHERE key='layout-migration'").get().n, 0);
    assert.equal(reopened.privateStatus().count, 1);
  }
});

test('0.8.0 encrypted backups with yearly paths restore into flat date files', t => {
  const f = fixture(t), space = f.open();
  space.appendPrivate('author-a', 'OLD_BACKUP');
  mkdirSync(join(space.privateDirectory, '2026'));
  renameSync(join(space.privateDirectory, '2026-03-04.md'), join(space.privateDirectory, '2026', '2026-03-04.md'));
  space.privateDb.exec("UPDATE entries SET relative_path='2026/2026-03-04.md'; UPDATE journal_days SET relative_path='2026/2026-03-04.md'");
  const encrypted = packBackup(space, password);
  restoreBackup(f.root, 'old-backup', encrypted, password, f.options.config);
  const restored = f.open('old-backup');
  assert.deepEqual(readdirSync(restored.privateDirectory), ['2026-03-04.md']);
  assert.match(readFileSync(join(restored.privateDirectory, '2026-03-04.md'), 'utf8'), /OLD_BACKUP/);
});
