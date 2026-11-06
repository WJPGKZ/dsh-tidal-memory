import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { topicReferences } from '../src/topic-index.js';
import { packBackup, restoreBackup } from '../src/transfer.js';

const admin = { admin: true };
const reader = { sessionId: 'reader' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-topics-'));
  const spaces = [];
  const open = name => {
    const space = new MemorySpace(root, name, { clock: () => Date.parse('2026-03-10T12:00:00Z'),
      config: { residentBudget: 0, privateWriters: ['test-author'] } });
    spaces.push(space);
    return space;
  };
  t.after(() => { for (const space of spaces) space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, open, space: open('shared') };
}
const create = (space, text, options = {}) => space.create({
  layer: 'L2', text, status: 'active', kind: 'user_statement', ...options,
}, admin);
const topicId = record => topicReferences(record).find(ref => ref.kind === 'topic').id;

test('topics join four-layer evidence without changing recall text or accessing private records', t => {
  const { space, open } = fixture(t);
  const task = create(space, 'orchid task', { layer: 'L1', topics: ['Orchid'] });
  const episode = create(space, 'orchid experience', { layer: 'L2', topics: ['ｏｒｃｈｉｄ'] });
  const stable = create(space, 'orchid preference', { layer: 'L3', topics: ['orchid'] });
  create(space, 'orchid buffer', { layer: 'L0', topics: ['orchid'] });
  space.appendPrivate('test-author', 'PRIVATE_TOPIC_CANARY');
  const result = space.recall('orchid task', reader);
  const card = result.topicCards.find(item => item.kind === 'topic');
  assert.equal(card.label, 'orchid');
  assert.equal(card.count, 3);
  assert.deepEqual(new Set(card.evidenceIds), new Set([task.id, episode.id, stable.id]));
  assert.equal(result.text.includes('PRIVATE_TOPIC_CANARY'), false);
  assert.ok(result.estimatedTokens <= result.budget);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.ok(existsSync(join(space.directory, 'indexes', 'topics.sqlite3')));
  const page = space.readEvidence({ topic: card.id, limit: 2 }, reader);
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const tail = space.readEvidence({ topic: card.id, limit: 2, cursor: page.nextCursor }, reader);
  assert.equal(tail.items.length, 1);
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(new Set([...page.items, ...tail.items].map(item => item.id)),
    new Set([task.id, episode.id, stable.id]));
  assert.equal(JSON.stringify([result, page, tail]).includes('PRIVATE_TOPIC_CANARY'), false);
  assert.deepEqual(open('other').readEvidence({ topic: card.id }, reader).items, []);
});

test('every topic page rechecks status, validity and tombstones instead of trusting cards', t => {
  const { space } = fixture(t);
  const current = create(space, 'coral current', { topics: ['coral'] });
  const future = create(space, 'coral future', { topics: ['coral'], validFrom: '2026-04-01T00:00:00Z' });
  const expired = create(space, 'coral expired', { topics: ['coral'], validUntil: '2026-03-01T00:00:00Z' });
  const archive = create(space, 'coral archived', { topics: ['coral'], status: 'archived' });
  const candidate = create(space, 'coral candidate', { topics: ['coral'], status: 'candidate' });
  const topic = topicId(current);
  assert.deepEqual(space.readEvidence({ topic }, reader).items.map(item => item.id), [current.id]);
  assert.throws(() => space.readEvidence({ id: future.id }, reader), { code: 'NOT_FOUND' });
  assert.throws(() => space.readEvidence({ id: archive.id }, reader), { code: 'NOT_FOUND' });
  assert.equal(space.readEvidence({ id: archive.id, includeArchived: true }, reader).id, archive.id);
  const history = space.readEvidence({ topic, mode: 'history' }, reader);
  assert.deepEqual(new Set(history.items.map(item => item.id)), new Set([current.id, future.id, expired.id, archive.id]));
  assert.ok(!history.items.some(item => item.id === candidate.id));
  const past = space.readEvidence({ topic, mode: 'as-of', asOf: '2026-02-01T00:00:00Z' }, reader);
  assert.ok(past.items.some(item => item.id === expired.id));
  assert.ok(!past.items.some(item => item.id === future.id));
  assert.throws(() => space.readEvidence({ topic, mode: 'as-of' }, reader), { code: 'INVALID_TIME' });
  assert.throws(() => space.readEvidence({ topic, cursor: '../other' }, reader), { code: 'INVALID_ID' });
  assert.throws(() => space.readEvidence({ topic: '../other' }, reader), { code: 'INVALID_TOPIC' });
  assert.throws(() => space.readEvidence({ topic }, {}), { code: 'FORBIDDEN' });
  space.forget(current.id, admin);
  assert.equal(space.readEvidence({ topic }, reader).total, 0);
  assert.equal(space.topics().db.prepare('SELECT count(*) AS n FROM members WHERE id=?').get(current.id).n, 0);
  assert.throws(() => space.readEvidence({ id: current.id, mode: 'history' }, reader), { code: 'NOT_FOUND' });
});

test('derived references use exact fact and scene identities and never merge the records', t => {
  const { space } = fixture(t);
  const a = create(space, 'violet shared', {
    factKey: 'Project.Editor', aliases: ['NVIM'], occurredAt: '2026-03-01T00:00:00Z',
    source: { kind: 'manual', sceneId: 'Session-A' },
  });
  const b = create(space, 'violet shared', {
    factKey: 'Project.Editor', aliases: ['nvim'], occurredAt: '2026-03-02T00:00:00Z',
    source: { kind: 'manual', sceneId: 'Session-A' },
  });
  const c = create(space, 'violet separate', {
    factKey: 'project.editor', source: { kind: 'manual', sceneId: 'session-a' },
  });
  const refs = topicReferences(a);
  for (const kind of ['fact', 'alias', 'scene']) {
    const ref = refs.find(item => item.kind === kind);
    assert.deepEqual(new Set(space.readEvidence({ topic: ref.id }, reader).items.map(item => item.id)),
      new Set([a.id, b.id]));
  }
  assert.notEqual(refs.find(item => item.kind === 'fact').id, topicReferences(c).find(item => item.kind === 'fact').id);
  assert.notEqual(refs.find(item => item.kind === 'scene').id, topicReferences(c).find(item => item.kind === 'scene').id);
  assert.equal(space.all().length, 3);
});

test('adding a topic card leaves already selected evidence and budget unchanged', t => {
  const { space } = fixture(t);
  let record = create(space, 'violet protocol evidence');
  const before = space.recall('violet protocol', reader);
  record = space.update(record.id, { topics: ['orchid'] }, record.revision, admin);
  const after = space.recall('violet protocol', reader);
  assert.equal(after.text, before.text);
  assert.deepEqual(after.picked.map(item => [item.id, item.channel]), before.picked.map(item => [item.id, item.channel]));
  assert.equal(after.estimatedTokens, before.estimatedTokens);
  assert.equal(after.topicCards[0].label, 'orchid');
});

test('topic-card cache rechecks time, archive options, edits and forgetting', t => {
  const { space } = fixture(t);
  let now = Date.parse('2026-03-10T12:00:00Z');
  space.clock = () => now;
  const first = create(space, 'orchid selected evidence', { topics: ['orchid'] });
  let future = create(space, 'orchid future evidence', { topics: ['orchid'], validFrom: '2026-03-11T00:00:00Z' });
  const archived = create(space, 'orchid archived evidence', { topics: ['orchid'], status: 'archived' });
  const index = space.topics(), members = index.members.bind(index);
  let reads = 0;
  index.members = topic => { reads++; return members(topic); };
  const card = options => space.recall('orchid selected evidence', reader, options).topicCards.find(item => item.label === 'orchid');
  assert.equal(card().count, 1);
  card().evidenceIds.length = 0;
  assert.ok(card().evidenceIds.includes(first.id));
  assert.equal(card().count, 1);
  assert.equal(reads, 1);
  assert.equal(card({ includeArchived: true }).count, 2);
  assert.equal(card({ includeArchived: true }).count, 2);
  assert.equal(reads, 2);
  now = Date.parse('2026-03-11T00:00:00Z');
  assert.equal(card().count, 2);
  assert.equal(card({ includeArchived: true }).count, 3);
  future = space.update(future.id, { topics: ['different'] }, future.revision, admin);
  assert.equal(card().count, 1);
  assert.equal(card({ includeArchived: true }).count, 2);
  space.forget(archived.id, admin);
  assert.equal(card({ includeArchived: true }).count, 1);
  assert.ok(card().evidenceIds.includes(first.id));
});

test('topic pages bound output size while preserving a way to read all provenance', t => {
  const { space } = fixture(t);
  const records = [];
  for (const [index, count] of [1500, 550, 550].entries()) {
    const record = create(space, `bounded topic ${index}`, { topics: ['large-source'] });
    const sources = Array.from({ length: count }, (_, n) =>
      ({ kind: 'manual', id: `source-${n}`, excerpt: 'x'.repeat(1000) }));
    space.persist({ ...record, sources, revision: record.revision + 1 });
    records.push({ id: record.id, count });
  }
  const topic = topicId(space.get(records[0].id, admin));
  const items = [];
  let cursor, pages = 0;
  do {
    const result = space.readEvidence({ topic, cursor, limit: 100 }, reader);
    pages++;
    assert.equal(result.total, records.length);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1024 * 1024);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  assert.ok(pages > 1);
  assert.equal(items.length, records.length);
  assert.deepEqual(new Set(items.map(item => item.id)), new Set(records.map(record => record.id)));
  const large = items.find(item => item.id === records[0].id);
  assert.equal(large.sourcesComplete, false);
  assert.equal(large.sourcesTotal, records[0].count);
  assert.deepEqual(large.sources, []);
  assert.equal(space.readEvidence({ id: large.id }, reader).sources.length, records[0].count);
  for (const record of records.slice(1)) {
    const item = items.find(value => value.id === record.id);
    assert.equal(item.sourcesComplete, true);
    assert.equal(item.sourcesTotal, record.count);
    assert.equal(item.sources.length, record.count);
  }
});

test('topic-card cache invalidates when the local clock moves backwards', t => {
  const { space } = fixture(t);
  let now = Date.parse('2026-03-12T00:00:00Z');
  space.clock = () => now;
  const records = Array.from({ length: 6 }, (_, index) =>
    create(space, `clock cache evidence ${index}`, { topics: ['clock'] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const future = records.at(-1);
  space.update(future.id, { validFrom: '2026-03-11T00:00:00Z' }, future.revision, admin);
  const card = () => space.recall('clock cache evidence', reader).topicCards.find(item => item.label === 'clock');
  assert.equal(card().count, 6);
  assert.equal(card().evidenceIds.includes(future.id), false);
  now = Date.parse('2026-03-10T00:00:00Z');
  assert.equal(card().count, 5);
});

test('changes to fact and task keys invalidate cached derived references', t => {
  const { space } = fixture(t);
  const first = create(space, 'fact cache seed', {
    factKey: 'Project.Editor', taskKey: 'task-shared', occurredAt: '2026-03-01T00:00:00Z' });
  const second = create(space, 'fact cache seed', {
    factKey: 'Project.Editor', taskKey: 'task-shared', occurredAt: '2026-03-02T00:00:00Z' });
  const cards = () => space.recall('fact cache seed', reader).topicCards;
  assert.equal(cards().find(card => card.kind === 'fact').count, 2);
  assert.equal(cards().find(card => card.kind === 'task').count, 2);
  space.update(second.id, { factKey: 'Project.Other', taskKey: 'task-other' }, second.revision, admin);
  assert.equal(cards().some(card => card.kind === 'fact'), false);
  assert.equal(cards().some(card => card.kind === 'task'), false);
  assert.ok(space.get(first.id, admin));
});

test('index updates, restart reconciliation and backup rebuild retain authoritative topics', t => {
  const { root, space, open } = fixture(t);
  let record = create(space, 'silver evidence', { topics: ['silver'] });
  const old = topicId(record);
  assert.equal(space.readEvidence({ topic: old }, reader).total, 1);
  record = space.update(record.id, { topics: ['gold'] }, record.revision, admin);
  assert.equal(space.readEvidence({ topic: old }, reader).total, 0);
  assert.equal(space.readEvidence({ topic: topicId(record) }, reader).total, 1);
  const changed = { ...record, topics: ['bronze'] };
  space.db('L2').prepare('UPDATE memories SET data=? WHERE id=?').run(JSON.stringify(changed), record.id);
  space.close();
  const reopened = open('shared');
  assert.equal(reopened.readEvidence({ topic: topicId(record) }, reader).total, 0);
  assert.equal(reopened.readEvidence({ topic: topicId(changed) }, reader).total, 1);
  restoreBackup(root, 'copy', packBackup(reopened), '', reopened.config);
  const copy = open('copy');
  assert.equal(copy.readEvidence({ topic: topicId(changed) }, reader).items[0].text, changed.text);
});

test('duplicate sources preserve newly supplied explicit topics and invalid themes fail', t => {
  const { space } = fixture(t);
  const first = create(space, 'same ordinary memory');
  const merged = create(space, 'same ordinary memory', { topics: ['alpha', 'beta'] });
  assert.equal(merged.id, first.id);
  assert.deepEqual(merged.topics, ['alpha', 'beta']);
  assert.throws(() => create(space, 'invalid topic', { topics: ['   '] }), { code: 'INVALID_TOPICS' });
  assert.throws(() => create(space, 'too many topics', { topics: Array(21).fill('alpha') }), { code: 'INVALID_TOPICS' });
});
