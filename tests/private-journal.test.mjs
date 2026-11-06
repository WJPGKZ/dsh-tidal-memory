import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemorySpace } from '../src/store.js';
import { openDatabase } from '../src/database.js';
import { packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const admin = { admin: true };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-private-test-'));
  let now = new Date(2026, 2, 4, 12, 0).getTime();
  const options = { clock: () => now, config: { privateWriters: ['author-a', 'author-b'] } };
  const spaces = [];
  t.after(() => { for (const space of spaces) space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, open(name = 'shared') { const space = new MemorySpace(root, name, options); spaces.push(space); return space; },
    get now() { return now; }, set now(value) { now = value; } };
}
const legacyInsert = (db, id, author, content, created) => db.prepare(
  'INSERT INTO entries(id,author,content,created_at,source_ids) VALUES(?,?,?,?,?)',
).run(id, author, content, created, '[]');

test('one authoritative entry per author and local day preserves append order and stable ID', t => {
  const f = fixture(t), space = f.open();
  const first = space.appendPrivate('author-a', 'SYNTHETIC_PRIVATE_FIRST');
  f.now += 1000;
  const next = space.appendPrivate('author-a', 'SYNTHETIC_PRIVATE_SECOND');
  assert.equal(next.id, first.id);
  assert.equal(next.revision, first.revision + 1);
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(first.id).content,
    'SYNTHETIC_PRIVATE_FIRST\n\nSYNTHETIC_PRIVATE_SECOND');
  assert.notEqual(space.appendPrivate('author-b', 'another author').id, first.id);
  f.now = new Date(2026, 2, 5, 0, 1).getTime();
  assert.notEqual(space.appendPrivate('author-a', 'another day').id, first.id);
  assert.deepEqual(space.privateStatus().dailyCount, 3);
  assert.equal(space.privateStatus().legacyCount, 0);
  assert.throws(() => space.appendPrivate('not-authorized', 'not saved'), { code: 'PRIVATE_WRITER_DISABLED' });
  assert.throws(() => space.appendPrivate('author-a', ' '.repeat(50000) + 'x'), { code: 'INVALID_INPUT' });
});

test('a legacy five-column insert remains readable without implying full package rollback support', t => {
  const f = fixture(t), space = f.open();
  const entry = space.appendPrivate('author-a', 'NEW_WRITER_FIRST');
  space.privateDb.prepare('INSERT INTO entries VALUES(?,?,?,?,?)')
    .run('rollback-fragment', 'author-a', 'OLD_WRITER_FRAGMENT', new Date(f.now).toISOString(), '[]');
  space.close();
  const reopened = f.open();
  assert.equal(reopened.appendPrivate('author-a', 'NEW_WRITER_LAST').id, entry.id);
  assert.equal(reopened.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(entry.id).content,
    'NEW_WRITER_FIRST\n\nOLD_WRITER_FRAGMENT\n\nNEW_WRITER_LAST');
  assert.equal(reopened.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?')
    .get('rollback-fragment').entry_id, entry.id);
});

test('legacy migration is additive until a bounded recent sleep window merges reliable fragments', t => {
  const f = fixture(t);
  const file = join(f.root, 'spaces', 'shared', 'private', 'journal.sqlite3');
  const db = openDatabase(file);
  db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY,author TEXT NOT NULL,content TEXT NOT NULL,
    created_at TEXT NOT NULL,source_ids TEXT NOT NULL); PRAGMA user_version=1;`);
  const old = new Date(2026, 2, 2, 10, 0).toISOString();
  const todayA = new Date(2026, 2, 4, 1, 0).toISOString();
  const todayB = new Date(2026, 2, 4, 2, 0).toISOString();
  legacyInsert(db, 'old-fragment', 'author-a', 'OLD_SYNTHETIC', old);
  legacyInsert(db, 'first-fragment', 'author-a', 'FIRST_SYNTHETIC', todayA);
  legacyInsert(db, 'second-fragment', 'author-a', 'SECOND_SYNTHETIC', todayB);
  legacyInsert(db, 'old-import', 'legacy-import', 'IMPORT_SYNTHETIC', todayB);
  legacyInsert(db, 'boundary-before', 'author-b', 'BEFORE_WINDOW', new Date(2026, 2, 3, 2, 30).toISOString());
  legacyInsert(db, 'boundary-after', 'author-b', 'AFTER_WINDOW', new Date(2026, 2, 3, 4, 30).toISOString());
  db.close();
  const space = f.open();
  assert.equal(space.privateStatus().count, 6);
  assert.equal(space.privateStatus().legacyCount, 6);
  const result = space.organizePrivateWindow({ from: new Date(2026, 2, 3, 3, 0).toISOString(),
    until: new Date(f.now).toISOString() });
  assert.equal(result.merged, 1);
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get('first-fragment').content,
    'FIRST_SYNTHETIC\n\nSECOND_SYNTHETIC');
  assert.equal(space.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?').get('second-fragment').entry_id,
    'first-fragment');
  assert.ok(space.privateDb.prepare('SELECT 1 FROM entries WHERE id=? AND id NOT IN (SELECT entry_id FROM entry_state)').get('old-fragment'));
  assert.ok(space.privateDb.prepare('SELECT 1 FROM entries WHERE id=? AND id NOT IN (SELECT entry_id FROM entry_state)').get('old-import'));
  assert.ok(space.privateDb.prepare('SELECT 1 FROM entries WHERE id=? AND id NOT IN (SELECT entry_id FROM entry_state)').get('boundary-before'));
  assert.ok(space.privateDb.prepare('SELECT 1 FROM entry_state WHERE entry_id=?').get('boundary-after'));
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get('boundary-after').content, 'AFTER_WINDOW');
  assert.equal(space.privateStatus().count, 5);
  const plain = packBackup(space);
  for (const text of ['FIRST_SYNTHETIC', 'SECOND_SYNTHETIC', 'OLD_SYNTHETIC', 'IMPORT_SYNTHETIC']) {
    assert.equal(plain.includes(text), false);
    assert.equal(JSON.stringify(space.privateStatus()).includes(text), false);
  }
});

test('a concurrent append defeats stale light-organization CAS and is retried without losing text', t => {
  const f = fixture(t), space = f.open();
  const entry = space.appendPrivate('author-a', 'FIRST\r\nSECOND');
  const cutoff = new Date(f.now).toISOString();
  const first = space.organizePrivateWindow({ from: new Date(f.now - 1000).toISOString(), until: cutoff,
    beforeCommit: () => { f.now += 1000; space.appendPrivate('author-a', 'LATE_APPEND'); } });
  assert.equal(first.conflicts, 1);
  assert.equal(first.state, 'partial');
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(entry.id).content,
    'FIRST\r\nSECOND\n\nLATE_APPEND');
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 1);
  const retry = space.organizePrivateWindow({ from: cutoff, until: new Date(f.now).toISOString() });
  assert.equal(retry.state, 'completed');
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(entry.id).content,
    'FIRST\nSECOND\n\nLATE_APPEND');
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 0);
});

test('a late append at the same clock tick remains queued for the next window', t => {
  const f = fixture(t), space = f.open(), cutoff = new Date(f.now).toISOString();
  const entry = space.appendPrivate('author-a', 'INITIAL');
  space.organizePrivateWindow({ from: new Date(f.now - 1000).toISOString(), until: cutoff });
  space.appendPrivate('author-a', 'LATE\r\nLINE');
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 1);
  const next = space.organizePrivateWindow({ from: cutoff, until: cutoff });
  assert.equal(next.state, 'completed');
  assert.equal(space.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(entry.id).content,
    'INITIAL\n\nLATE\nLINE');
});

test('deleting a journal during organization never resurrects it or leaves a stale pending reference', t => {
  const f = fixture(t), space = f.open(), cutoff = new Date(f.now).toISOString();
  space.appendPrivate('author-a', 'DELETED\r\nCONTENT');
  const result = space.organizePrivateWindow({ from: new Date(f.now - 1000).toISOString(), until: cutoff,
    beforeCommit: () => space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL') });
  assert.equal(result.state, 'partial');
  assert.equal(space.privateStatus().count, 0);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 0);
});

test('local daily identity survives spring-forward and repeated fall-back hours', t => {
  const oldTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz; });
  const f = fixture(t), space = f.open();
  f.now = new Date('2026-03-08T06:55:00Z').getTime();
  const spring = space.appendPrivate('author-a', 'BEFORE_SPRING');
  f.now += 10 * 60000;
  assert.equal(space.appendPrivate('author-a', 'AFTER_SPRING').id, spring.id);
  f.now = new Date('2026-11-01T05:15:00Z').getTime();
  const fall = space.appendPrivate('author-a', 'FIRST_FALL_HOUR');
  f.now += 60 * 60000;
  assert.equal(space.appendPrivate('author-a', 'SECOND_FALL_HOUR').id, fall.id);
  assert.notEqual(fall.id, spring.id);
});

test('private status never reflects unvalidated metadata strings', t => {
  const f = fixture(t), space = f.open();
  const entry = space.appendPrivate('author-a', 'PRIVATE_BODY_CANARY');
  space.privateDb.prepare('UPDATE entries SET created_at=? WHERE id=?').run('PRIVATE_TIMESTAMP_CANARY', entry.id);
  space.privateDb.prepare('UPDATE entry_state SET day_key=?,updated_at=? WHERE entry_id=?')
    .run('PRIVATE_DAY_CANARY', 'PRIVATE_UPDATED_CANARY', entry.id);
  space.privateDb.prepare("INSERT OR REPLACE INTO journal_metadata VALUES('last-organization',?)")
    .run(JSON.stringify({ state: 'completed', from: 'PRIVATE_FROM_CANARY', until: '2026-03-04T12:00:00.000Z',
      inspected: 1, updated: 1, merged: 0, migrated: 0, deferred: 0, conflicts: 0 }));
  const status = JSON.stringify(space.privateStatus());
  assert.equal(status.includes('PRIVATE_'), false);
  assert.equal(space.privateStatus().organization, null);
});

test('private alias and daily identity survive encrypted restore without appearing in plaintext backups', t => {
  const f = fixture(t), space = f.open();
  const created = new Date(f.now - 5000).toISOString();
  legacyInsert(space.privateDb, 'legacy-a', 'author-a', 'ALIAS_PRIVATE_A', created);
  legacyInsert(space.privateDb, 'legacy-b', 'author-a', 'ALIAS_PRIVATE_B', created);
  const daily = space.appendPrivate('author-a', 'ALIAS_PRIVATE_C');
  const plain = packBackup(space);
  assert.equal(plain.includes('ALIAS_PRIVATE'), false);
  assert.equal(plain.includes('legacy-b'), false);
  const encrypted = packBackup(space, 'synthetic-password-123');
  assert.equal(encrypted.includes('ALIAS_PRIVATE'), false);
  const document = unpackBackup(encrypted, 'synthetic-password-123');
  assert.equal(document.privateEntries.length, 1);
  assert.equal(document.privateAliases.length, 1);
  restoreBackup(f.root, 'restored', encrypted, 'synthetic-password-123', f.options.config);
  const restored = f.open('restored');
  assert.equal(restored.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?').get('legacy-b').entry_id, daily.id);
  assert.equal(restored.appendPrivate('author-a', 'ALIAS_PRIVATE_D').id, daily.id);
  assert.match(restored.privateDb.prepare('SELECT content FROM entries WHERE id=?').get(daily.id).content, /ALIAS_PRIVATE_D/);
  assert.throws(() => restoreBackup(f.root, 'restored', encrypted, 'synthetic-password-123', {}), /新空间/);
});

test('failed oversized legacy merge leaves all original fragments and IDs intact', t => {
  const f = fixture(t), space = f.open(), at = new Date(f.now).toISOString();
  legacyInsert(space.privateDb, 'large-a', 'author-a', 'A'.repeat(1100000), at);
  legacyInsert(space.privateDb, 'large-b', 'author-a', 'B'.repeat(1100000), at);
  assert.throws(() => space.appendPrivate('author-a', 'extra'), { code: 'INVALID_INPUT' });
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM entries').get().n, 2);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM entry_aliases').get().n, 0);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM entry_state').get().n, 0);
});

test('encrypted restore rejects raw oversized private text even when trimming would hide its size', t => {
  const f = fixture(t), space = f.open();
  legacyInsert(space.privateDb, 'oversized', 'author-a', ' '.repeat(2 * 1024 * 1024) + 'x', new Date(f.now).toISOString());
  const backup = packBackup(space, 'synthetic-password-123');
  assert.throws(() => restoreBackup(f.root, 'oversized-restore', backup, 'synthetic-password-123', {}), { code: 'INVALID_BACKUP' });
  assert.equal(existsSync(join(f.root, 'spaces', 'oversized-restore')), false);
});

test('private deletion removes aliases and pending state without touching old backups', t => {
  const f = fixture(t), space = f.open(), at = new Date(f.now).toISOString();
  legacyInsert(space.privateDb, 'delete-a', 'author-a', 'DELETE_PRIVATE_A', at);
  legacyInsert(space.privateDb, 'delete-b', 'author-a', 'DELETE_PRIVATE_B', at);
  const entry = space.appendPrivate('author-a', 'DELETE_PRIVATE_C');
  space.privateDb.prepare('INSERT OR IGNORE INTO journal_pending VALUES(?)').run(entry.id);
  const backup = packBackup(space, 'synthetic-password-123');
  assert.throws(() => space.clearPrivate(admin, 'wrong'), { code: 'CONFIRMATION_REQUIRED' });
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  assert.equal(space.privateStatus().count, 0);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM entry_aliases').get().n, 0);
  assert.equal(space.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 0);
  const restored = restoreBackup(f.root, 'backup-still-exists', backup, 'synthetic-password-123', {});
  assert.equal(restored.privateCount, 0);
  assert.equal(restored.skippedPrivate, 1);
  assert.ok(existsSync(join(f.root, 'spaces', 'backup-still-exists')));
});
