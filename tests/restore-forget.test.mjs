import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { hash } from '../src/model.js';
import { ForgetLedger } from '../src/forget-ledger.js';
import { packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const admin = { admin: true };
const reader = { sessionId: 'reader' };
const password = 'synthetic-offline-password-123';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-forget-'));
  const offline = mkdtempSync(join(tmpdir(), 'tidal-forget-offline-'));
  const spaces = [];
  const open = (base, name) => {
    const space = new MemorySpace(base, name, { config: { residentBudget: 0, privateWriters: ['test-author'] } });
    spaces.push(space);
    return space;
  };
  t.after(() => {
    for (const space of spaces) space.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(offline, { recursive: true, force: true });
  });
  return { root, offline, open, space: open(root, 'shared') };
}
const create = (space, text, extra = {}) => space.create({
  layer: 'L2', text, status: 'active', kind: 'user_statement', ...extra,
}, admin);
function legacyBackup(backup) {
  const envelope = JSON.parse(backup);
  const document = JSON.parse(envelope.payload);
  delete document.lineageId;
  envelope.payload = JSON.stringify(document);
  envelope.sha256 = hash(envelope.payload);
  return JSON.stringify(envelope);
}

test('a same-root restore applies newer forget markers to records, revisions, descendants and topics', t => {
  const { root, space, open } = fixture(t);
  let first = create(space, 'violet prior', { topics: ['orchid'] });
  first = space.update(first.id, { text: 'violet current' }, first.revision, admin);
  const derived = create(space, 'derived violet evidence', { layer: 'L3', parents: [first.id], topics: ['orchid'] });
  const survivor = create(space, 'separate evidence', { topics: ['orchid'] });
  const before = packBackup(space);
  const legacy = legacyBackup(before);
  space.recall('violet current', reader);
  space.forget(first.id, admin);
  const result = restoreBackup(root, 'recovered', before, '', space.config);
  assert.equal(result.forgetCoverage, 'local-ledger');
  assert.equal(result.skippedForgotten, 2);
  const recovered = open(root, 'recovered');
  assert.deepEqual(recovered.all().map(record => record.id), [survivor.id]);
  assert.throws(() => recovered.get(first.id, admin), { code: 'NOT_FOUND' });
  assert.throws(() => recovered.get(derived.id, admin), { code: 'NOT_FOUND' });
  assert.throws(() => create(recovered, 'violet prior'), { code: 'FORGOTTEN' });
  assert.throws(() => create(recovered, 'derived violet evidence', { layer: 'L3' }), { code: 'FORGOTTEN' });
  const card = recovered.recall('separate evidence', reader).topicCards.find(item => item.label === 'orchid');
  assert.equal(card.count, 1);
  assert.deepEqual(recovered.readEvidence({ topic: card.id }, reader).items.map(item => item.id), [survivor.id]);
  const legacyResult = restoreBackup(root, 'legacy', legacy, '', space.config);
  assert.equal(legacyResult.forgetCoverage, 'legacy-name-match');
  assert.equal(legacyResult.skippedForgotten, 2);
  const ledger = readFileSync(join(root, 'system', 'forget-ledger.sqlite3'));
  assert.equal(ledger.includes(Buffer.from('violet current')), false);
});

test('forgetting in a restored copy invalidates sibling copies without affecting unrelated spaces', t => {
  const { root, space, open } = fixture(t);
  const original = create(space, 'unique violet', { topics: ['violet'] });
  const backup = packBackup(space);
  restoreBackup(root, 'copy', backup, '', space.config);
  const copy = open(root, 'copy');
  const other = open(root, 'unrelated');
  const unrelated = create(other, 'unique violet');
  assert.ok(space.recall('unique violet', reader).picked.some(item => item.id === original.id));
  copy.forget(original.id, admin);
  assert.equal(space.recall('unique violet', reader).text, '');
  assert.throws(() => space.get(original.id, admin), { code: 'NOT_FOUND' });
  assert.equal(other.get(unrelated.id, admin).text, unrelated.text);
  space.recover();
  assert.equal(space.raw(original.id), undefined);
  const result = restoreBackup(root, 'second-copy', backup, '', space.config);
  assert.equal(result.skippedForgotten, 1);
  assert.equal(open(root, 'second-copy').all().length, 0);
});

test('a newly created space does not inherit the lineage of an old directory with the same name', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'reused name independent memory');
  const oldLineage = space.lineageId;
  space.forget(record.id, admin);
  space.close();
  renameSync(join(root, 'spaces', 'shared'), join(root, 'spaces', 'old-shared'));
  const fresh = open(root, 'shared');
  assert.notEqual(fresh.lineageId, oldLineage);
  const replacement = create(fresh, 'reused name independent memory');
  assert.equal(fresh.get(replacement.id, admin).text, replacement.text);
});

test('forgotten earlier revisions cannot survive inside another record or its descendants', t => {
  const { space } = fixture(t);
  let first = create(space, 'earlier violet text');
  first = space.update(first.id, { text: 'first current text' }, first.revision, admin);
  let other = create(space, 'earlier violet text');
  other = space.update(other.id, { text: 'second current text' }, other.revision, admin);
  const descendant = create(space, 'second descendant', { parents: [other.id] });
  const result = space.forget(first.id, admin);
  assert.equal(result.deleted, 3);
  assert.throws(() => space.get(other.id, admin), { code: 'NOT_FOUND' });
  assert.throws(() => space.get(descendant.id, admin), { code: 'NOT_FOUND' });
  assert.equal(space.db('L2').prepare('SELECT count(*) AS n FROM revisions').get().n, 0);
});

test('a forget arriving between recovery and snapshot is reconciled before backup succeeds', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'snapshot race canary');
  restoreBackup(root, 'race-copy', packBackup(space), '', space.config);
  const copy = open(root, 'race-copy');
  const recover = space.recover.bind(space);
  let injected = false;
  space.recover = () => {
    recover();
    if (!injected) { injected = true; copy.forget(record.id, admin); }
  };
  const document = unpackBackup(packBackup(space));
  assert.equal(injected, true);
  assert.equal(document.records.some(item => item.id === record.id), false);
  assert.ok(document.tombstones.some(item => item.id === record.id));
});

test('a concurrent forget cannot leak a record already selected for recall', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'recall race canary', { topics: ['race'] });
  restoreBackup(root, 'recall-race-copy', packBackup(space), '', space.config);
  const copy = open(root, 'recall-race-copy');
  const cards = space.topicCards.bind(space);
  let injected = false;
  space.topicCards = (...args) => {
    if (!injected) { injected = true; copy.forget(record.id, admin); }
    return cards(...args);
  };
  const result = space.recall('recall race canary', reader);
  assert.equal(injected, true);
  assert.equal(result.text.includes(record.text), false);
  assert.equal(result.picked.some(item => item.id === record.id), false);
  assert.equal(space.raw(record.id), undefined);
});

test('a concurrent forget cannot leak an already selected topic detail', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'detail race canary', { topics: ['race'] });
  restoreBackup(root, 'detail-race-copy', packBackup(space), '', space.config);
  const copy = open(root, 'detail-race-copy');
  const topic = space.recall('detail race canary', reader).topicCards[0].id;
  const visible = space.visible.bind(space);
  let injected = false;
  space.visible = (item, actor) => {
    const result = visible(item, actor);
    if (!injected && item.id === record.id) { injected = true; copy.forget(record.id, admin); }
    return result;
  };
  const result = space.readEvidence({ topic }, reader);
  assert.equal(injected, true);
  assert.equal(result.items.some(item => item.id === record.id), false);
  assert.equal(space.raw(record.id), undefined);
});

test('reconciliation observes new ledger revisions that arrive during an earlier pass', t => {
  const { root, space, open } = fixture(t);
  const first = create(space, 'first concurrent forget');
  const second = create(space, 'second concurrent forget');
  restoreBackup(root, 'concurrent-copy', packBackup(space), '', space.config);
  const copy = open(root, 'concurrent-copy');
  copy.forget(first.id, admin);
  const state = space.forgetLedger.state.bind(space.forgetLedger);
  let injected = false;
  space.forgetLedger.state = lineage => {
    const snapshot = state(lineage);
    if (!injected) { injected = true; copy.forget(second.id, admin); }
    return snapshot;
  };
  space.reconcileForgetLedger();
  assert.equal(space.raw(first.id), undefined);
  assert.equal(space.raw(second.id), undefined);
  assert.equal(space.reconciledForgetVersion, space.forgetVersion());
});

test('restore refuses publication if its lineage changes after staging', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'restore race canary');
  const backup = packBackup(space);
  restoreBackup(root, 'restore-race-source', backup, '', space.config);
  const copy = open(root, 'restore-race-source');
  const close = MemorySpace.prototype.close;
  let injected = false;
  MemorySpace.prototype.close = function () {
    if (this.name.startsWith('restore-') && !injected) {
      injected = true;
      copy.forget(record.id, admin);
    }
    return close.call(this);
  };
  try {
    assert.throws(() => restoreBackup(root, 'raced-target', backup, '', space.config), { code: 'FORGET_CONFLICT' });
  } finally { MemorySpace.prototype.close = close; }
  assert.equal(injected, true);
  assert.equal(existsSync(join(root, 'spaces', 'raced-target')), false);
  assert.throws(() => space.get(record.id, admin), { code: 'NOT_FOUND' });
});

test('a failed staged restore cannot publish derived forget markers to live spaces', t => {
  const { root, space, open } = fixture(t);
  const first = create(space, 'staged race ancestor');
  restoreBackup(root, 'staged-race-source', packBackup(space), '', space.config);
  const copy = open(root, 'staged-race-source');
  const survivor = create(space, 'unrelated live survivor');
  const document = unpackBackup(packBackup(space));
  document.records.find(record => record.id === survivor.id).parents = [first.id];
  const stagedBackup = packBackup({ snapshot: () => document });
  const recover = MemorySpace.prototype.recover;
  const rebuildViews = MemorySpace.prototype.rebuildViews;
  let recoveries = 0, injected = false;
  MemorySpace.prototype.recover = function () {
    if (this.name.startsWith('restore-') && ++recoveries === 2) {
      injected = true;
      copy.forget(first.id, admin);
    }
    return recover.call(this);
  };
  MemorySpace.prototype.rebuildViews = function () {
    if (this.name.startsWith('restore-')) throw new Error('injected view failure');
    return rebuildViews.call(this);
  };
  try {
    assert.throws(() => restoreBackup(root, 'failed-staged-target', stagedBackup, '', space.config),
      /injected view failure/);
  } finally {
    MemorySpace.prototype.recover = recover;
    MemorySpace.prototype.rebuildViews = rebuildViews;
  }
  assert.equal(injected, true);
  assert.equal(existsSync(join(root, 'spaces', 'failed-staged-target')), false);
  assert.equal(space.forgetLedger.has(space.lineageId, survivor), false);
  assert.equal(space.get(survivor.id, admin).text, survivor.text);
});

test('failed publication rolls back lineage registration and markers', t => {
  const { root, space } = fixture(t);
  const record = create(space, 'publication rollback canary');
  const ledger = new ForgetLedger(root);
  try {
    const version = ledger.version(space.lineageId);
    assert.throws(() => ledger.publishRestore('failed-publication', space.lineageId, version,
      [{ id: record.id, dedupe_key: record.dedupeKey }], [record.dedupeKey], ['private-rollback-canary'],
      () => { throw new Error('injected publication failure'); }), /injected publication failure/);
    assert.equal(ledger.lineageFor('failed-publication'), null);
    assert.equal(ledger.version(space.lineageId), version);
    assert.equal(ledger.has(space.lineageId, record), false);
    assert.equal(ledger.state(space.lineageId).privateIds.includes('private-rollback-canary'), false);
  } finally { ledger.close(); }
});

test('private aliases are forgotten across live copies and older fragment backups', t => {
  const { root, space, open } = fixture(t);
  const at = new Date().toISOString();
  const insert = space.privateDb.prepare('INSERT INTO entries VALUES(?,?,?,?,?)');
  insert.run('old-private-a', 'test-author', 'PRIVATE_FRAGMENT_A', at, '[]');
  insert.run('old-private-b', 'test-author', 'PRIVATE_FRAGMENT_B', at, '[]');
  const fragments = packBackup(space, password);
  const merged = space.appendPrivate('test-author', 'PRIVATE_FRAGMENT_C');
  assert.equal(space.privateDb.prepare('SELECT entry_id FROM entry_aliases WHERE alias_id=?')
    .get('old-private-b').entry_id, merged.id);
  const mergedBackup = packBackup(space, password);
  restoreBackup(root, 'private-live-copy', mergedBackup, password, space.config);
  const copy = open(root, 'private-live-copy');
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  assert.equal(copy.privateStatus().count, 0);
  assert.equal(copy.privateDb.prepare('SELECT count(*) AS n FROM entry_aliases').get().n, 0);
  assert.equal(copy.privateDb.prepare('SELECT count(*) AS n FROM journal_pending').get().n, 0);
  const result = restoreBackup(root, 'old-fragments', fragments, password, space.config);
  assert.equal(result.privateCount, 0);
  assert.equal(result.skippedPrivate, 2);
  const fresh = copy.appendPrivate('test-author', 'NEW_AFTER_CLEAR');
  assert.notEqual(fresh.id, merged.id);
});

test('private clear blocks old same-root encrypted restore without exposing the private text', t => {
  const { root, space, open } = fixture(t);
  const entry = space.appendPrivate('test-author', 'PRIVATE_FORGET_CANARY');
  const backup = packBackup(space, password);
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  const result = restoreBackup(root, 'private-copy', backup, password, space.config);
  assert.equal(result.privateCount, 0);
  assert.equal(result.skippedPrivate, 1);
  assert.equal(open(root, 'private-copy').privateStatus().count, 0);
  const ledger = readFileSync(join(root, 'system', 'forget-ledger.sqlite3'));
  assert.equal(ledger.includes(Buffer.from('PRIVATE_FORGET_CANARY')), false);
  assert.ok(entry.id);
});

test('new encrypted backups carry known ordinary and private forget markers to a fresh root', t => {
  const { root, offline, space, open } = fixture(t);
  const record = create(space, 'offline known forget');
  const entry = space.appendPrivate('test-author', 'PRIVATE_OFFLINE_FORGET');
  const before = packBackup(space, password);
  space.forget(record.id, admin);
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  const after = packBackup(space, password);
  const document = unpackBackup(after, password);
  assert.ok(document.tombstones.some(row => row.id === record.id));
  assert.ok(document.privateForgottenIds.includes(entry.id));
  const plain = packBackup(space);
  assert.equal(plain.includes(entry.id), false);
  assert.equal(plain.includes('privateForgottenIds'), false);
  restoreBackup(offline, 'latest', after, password, space.config);
  const result = restoreBackup(offline, 'stale', before, password, space.config);
  assert.equal(result.forgetCoverage, 'local-ledger');
  assert.equal(result.skippedForgotten, 1);
  assert.equal(result.skippedPrivate, 1);
  assert.equal(open(offline, 'stale').privateStatus().count, 0);
  assert.equal(open(offline, 'latest').all().length, 0);
  assert.ok(existsSync(join(root, 'system', 'forget-ledger.sqlite3')));
});

test('invalid backups cannot publish their ordinary or private forget markers', t => {
  const { root, space } = fixture(t);
  const record = create(space, 'live record must survive');
  const entry = space.appendPrivate('test-author', 'PRIVATE_MUST_SURVIVE');
  const document = unpackBackup(packBackup(space, password), password);
  document.tombstones.push({ id: record.id, dedupe_key: record.dedupeKey });
  document.privateForgottenIds.push(entry.id);
  document.privateEntries[0].content_hash = 'invalid';
  const forged = packBackup({ snapshot: () => document }, password);
  assert.throws(() => restoreBackup(root, 'invalid', forged, password, space.config), { code: 'INVALID_BACKUP' });
  assert.equal(space.get(record.id, admin).text, record.text);
  assert.equal(space.privateStatus().count, 1);
  assert.equal(existsSync(join(root, 'spaces', 'invalid')), false);
});

test('opening a local space reconstructs a lost lineage ledger from its own markers', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'ledger recovery canary');
  const entry = space.appendPrivate('test-author', 'PRIVATE_LEDGER_RECOVERY');
  const before = packBackup(space, password);
  space.forget(record.id, admin);
  space.clearPrivate(admin, 'DELETE PRIVATE JOURNAL');
  space.close();
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(root, 'system', `forget-ledger.sqlite3${suffix}`), { force: true });
  const reopened = open(root, 'shared');
  const result = restoreBackup(root, 'reconstructed', before, password, reopened.config);
  assert.equal(result.skippedForgotten, 1);
  assert.equal(result.skippedPrivate, 1);
  assert.ok(reopened.privateDb.prepare('SELECT 1 FROM private_tombstones WHERE id=?').get(entry.id));
});

test('old offline snapshots cannot know about later forget operations and report that limitation', t => {
  const { root, offline, space, open } = fixture(t);
  const record = create(space, 'offline historical snapshot');
  const before = packBackup(space, password);
  space.forget(record.id, admin);
  const result = restoreBackup(offline, 'offline', before, password, space.config);
  assert.equal(result.forgetCoverage, 'backup-only');
  assert.equal(result.skippedForgotten, 0);
  assert.equal(open(offline, 'offline').get(record.id, admin).text, record.text);
  const current = unpackBackup(packBackup(space, password), password);
  assert.ok(current.tombstones.some(row => row.id === record.id));
  assert.ok(existsSync(join(root, 'system', 'forget-ledger.sqlite3')));
});
