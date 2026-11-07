import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, memoryContentHash } from '../src/model.js';
import { MemorySpace } from '../src/store.js';
import { packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const admin = { admin: true };
const reader = { sessionId: 'synthetic-reader' };
const now = Date.parse('2026-03-10T12:00:00Z');

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-graph-'));
  const spaces = [];
  const open = name => {
    const space = new MemorySpace(root, name, { clock: () => now,
      config: { residentBudget: 0, privateWriters: ['test-author'], ...config } });
    spaces.push(space);
    return space;
  };
  t.after(() => {
    for (const space of spaces) space.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, open, space: open('shared') };
}

const create = (space, text, options = {}) => space.create({
  layer: 'L2', text, status: 'active', kind: 'user_statement', ...options,
}, admin);

test('graph uses explicit ordinary evidence, pages and classifications without crossing privacy boundaries', async t => {
  const { space, open } = fixture(t);
  const source = create(space, 'synthetic source', { layer: 'L1' });
  const center = create(space, 'synthetic center', {
    layer: 'L3', topics: ['orchid'], tags: ['stable'], parents: [source.id],
  });
  const topic = create(space, 'synthetic topic', { topics: ['orchid'] });
  const tag = create(space, 'synthetic tag', { tags: ['stable'] });
  const isolated = create(space, 'synthetic isolated', { layer: 'L3' });
  const unicode = create(space, '全角ＡＢＣ与中文', { layer: 'L3', tags: ['全角ＡＢＣ'] });
  create(space, 'L0_GRAPH_CANARY', { layer: 'L0', topics: ['orchid'] });
  space.appendPrivate('test-author', 'PRIVATE_GRAPH_CANARY');
  create(open('other'), 'OTHER_SPACE_GRAPH_CANARY', { topics: ['orchid'] });

  assert.equal(space.graph().status().state, 'unprepared');
  await space.graph().sync();
  const list = space.graphList({}, reader);
  assert.deepEqual(new Set(list.items.map(item => item.id)), new Set([center.id, isolated.id, unicode.id]));
  assert.deepEqual(space.graphList({ topic: 'orchid' }, reader).items.map(item => item.id), [center.id]);
  assert.deepEqual(new Set(space.graphList({ relation: 'isolated' }, reader).items.map(item => item.id)),
    new Set([isolated.id, unicode.id]));
  assert.deepEqual(space.graphList({ topic: '全角abc' }, reader).items.map(item => item.id), [unicode.id]);
  assert.deepEqual(space.graphList({ query: '全角abc' }, reader).items.map(item => item.id), [unicode.id]);
  const page = space.graphNeighbors({ id: center.id, limit: 1 }, reader);
  assert.ok(page.nextCursor);
  const items = [...page.items];
  let cursor = page.nextCursor;
  while (cursor) {
    const next = space.graphNeighbors({ id: center.id, cursor, limit: 1 }, reader);
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  assert.deepEqual(new Set(items.map(item => item.id)), new Set([source.id, topic.id, tag.id]));
  assert.deepEqual(new Set(items.map(item => item.relation.kind)), new Set(['source', 'topic', 'tag']));
  assert.equal(JSON.stringify([list, items]).includes('PRIVATE_GRAPH_CANARY'), false);
  assert.equal(JSON.stringify([list, items]).includes('L0_GRAPH_CANARY'), false);
  assert.equal(JSON.stringify([list, items]).includes('OTHER_SPACE_GRAPH_CANARY'), false);
  assert.deepEqual(JSON.parse(JSON.stringify([list, items])), [list, items]);
  assert.throws(() => space.graphNeighbors({ id: center.id }, {}), { code: 'FORBIDDEN' });
});

test('manual decisions survive rebuild and backup, become stale on content changes and respect forgetting', async t => {
  const { root, space, open } = fixture(t);
  let center = create(space, 'synthetic center', { layer: 'L3', topics: ['orchid'] });
  const other = create(space, 'synthetic related', { topics: ['orchid'] });
  await space.graph().sync();
  space.graphDecision({ id: center.id, otherId: other.id, decision: 'excluded' }, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'excluded');
  const backup = packBackup(space);
  const envelope = JSON.parse(backup);
  assert.equal(envelope.version, 2);
  assert.equal(unpackBackup(backup).graphRelations.length, 1);
  space.graphIndex.close();
  space.graphIndex = null;
  await space.graph().sync();
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'excluded');
  restoreBackup(root, 'restored', backup, '', space.config);
  const restored = open('restored');
  await restored.graph().sync();
  assert.equal(restored.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'excluded');

  space.graphDecision({ id: center.id, otherId: other.id, decision: 'confirmed' }, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'confirmed');
  center = space.update(center.id, { text: 'synthetic changed center' }, center.revision, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'stale');
  space.graphDecision({ id: center.id, otherId: other.id, decision: 'reset' }, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items[0].relation.kind, 'topic');
  space.graphDecision({ id: center.id, otherId: other.id, decision: 'excluded' }, admin);
  const beforeForget = packBackup(space);
  space.forget(other.id, admin);
  assert.equal(space.system.prepare('SELECT count(*) AS n FROM graph_relations').get().n, 0);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items.length, 0);
  restoreBackup(root, 'after-forget', beforeForget, '', space.config);
  const after = open('after-forget');
  assert.equal(after.system.prepare('SELECT count(*) AS n FROM graph_relations').get().n, 0);
});

test('version-one snapshots still restore without graph decisions', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'synthetic legacy', { layer: 'L3' });
  const document = unpackBackup(packBackup(space));
  document.version = 1;
  delete document.graphRelations;
  const payload = JSON.stringify(document);
  const legacy = JSON.stringify({ format: 'tidal-backup', version: 1, sha256: hash(payload), payload });
  restoreBackup(root, 'legacy', legacy, '', space.config);
  assert.equal(open('legacy').get(record.id, admin).text, 'synthetic legacy');
});

test('version-one encrypted snapshots still restore ordinary and private records', t => {
  const { root, space, open } = fixture(t);
  const record = create(space, 'synthetic encrypted legacy', { layer: 'L3' });
  space.appendPrivate('test-author', 'SYNTHETIC_LEGACY_PRIVATE');
  const password = 'synthetic-legacy-password-123';
  const document = unpackBackup(packBackup(space, password), password);
  document.version = 1;
  delete document.graphRelations;
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  let envelope;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('tidal-backup-v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(document), 'utf8'), cipher.final()]);
    envelope = JSON.stringify({ format: 'tidal-encrypted-backup', version: 1, salt: salt.toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { key.fill(0); }
  restoreBackup(root, 'legacy-encrypted', envelope, password, space.config);
  const restored = open('legacy-encrypted');
  assert.equal(restored.get(record.id, admin).text, 'synthetic encrypted legacy');
  assert.equal(restored.privateStatus().count, 1);
});

test('graph recall only appends confirmed current neighbors after the unchanged baseline', async t => {
  const { space } = fixture(t);
  const seed = create(space, 'orchid deployment protocol', { layer: 'L2' });
  const neighbors = Array.from({ length: 5 }, (_, i) =>
    create(space, `separate supporting record ${i}`, { layer: 'L3' }));
  for (const other of neighbors) space.graphDecision({ id: seed.id, otherId: other.id, decision: 'confirmed' }, admin);
  await space.graph().sync();
  const before = space.recall('orchid deployment protocol', reader, { evidenceId: 'before' });
  space.setConfig({ ...space.config, graphRecall: true });
  const after = space.recall('orchid deployment protocol', reader, { evidenceId: 'after' });
  assert.deepEqual(after.picked.slice(0, before.picked.length).map(item => item.id), before.picked.map(item => item.id));
  assert.ok(after.text.startsWith(before.text));
  assert.equal(after.diagnostics.returnedGraph, 3);
  assert.equal(after.picked.filter(item => item.graphRelation).length, 3);
  assert.ok(after.picked.filter(item => item.graphRelation).every(item => !item.matched && item.graphRelation.seedId === seed.id));
  assert.ok(after.estimatedTokens <= after.budget);
  assert.deepEqual(JSON.parse(JSON.stringify(after)), after);
  assert.ok(neighbors.every(record => space.get(record.id, admin).recallCount === 0));
  const noSeed = space.recall('unrelated words with no matching record', reader);
  assert.equal(noSeed.diagnostics.returnedGraph, 0);
  const constrained = space.recall('orchid deployment protocol', reader, { budget: 256 });
  assert.ok(constrained.estimatedTokens <= 256);
});

test('excluding a source edge prevents its expansion without hiding direct matches', t => {
  const { space } = fixture(t);
  const source = create(space, 'separate supporting fact');
  const center = create(space, 'orchid anchoring phrase', { layer: 'L3', parents: [source.id] });
  assert.ok(space.recall('orchid anchoring phrase', reader).picked.some(item => item.id === source.id));
  space.graphDecision({ id: center.id, otherId: source.id, decision: 'excluded' }, admin);
  assert.ok(!space.recall('orchid anchoring phrase', reader).picked.some(item => item.id === source.id));
  assert.ok(space.recall('separate supporting fact', reader).picked.some(item => item.id === source.id));
  space.graphDecision({ id: center.id, otherId: source.id, decision: 'reset' }, admin);
  assert.ok(space.recall('orchid anchoring phrase', reader).picked.some(item => item.id === source.id));
});

test('semantic-only matches cannot seed unverified graph expansion', async t => {
  const { space } = fixture(t, { graphRecall: true });
  const center = create(space, 'unrelated center', { layer: 'L3' });
  const other = create(space, 'unrelated supporting information');
  space.graphDecision({ id: center.id, otherId: other.id, decision: 'confirmed' }, admin);
  await space.graph().sync();
  const result = space.recall('separate query', reader, {
    semantic: [{ id: center.id, score: 0.9, contentHash: memoryContentHash(center), revision: center.revision }],
  });
  assert.ok(result.picked.some(item => item.id === center.id && item.semanticScore === 0.9));
  assert.ok(!result.picked.some(item => item.id === other.id));
  assert.equal(result.diagnostics.returnedGraph, 0);
});

test('graph recall respects temporal scopes, archive selection, limits and index failures', async t => {
  const { space } = fixture(t, { graphRecall: true, maxRecall: 1 });
  const cases = [
    { name: 'current', options: {}, current: true, asOf: true },
    { name: 'archived', options: { status: 'archived' }, current: false, asOf: true },
    { name: 'expired', options: { validFrom: '2025-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' },
      current: false, asOf: true },
    { name: 'future', options: { validFrom: '2027-01-01T00:00:00Z' }, current: false, asOf: false },
  ];
  for (const [index, item] of cases.entries()) {
    item.query = `uniquetimeanchor${index}`;
    item.seed = create(space, `${item.query} synthetic center`, { layer: 'L3' });
    item.other = create(space, `separate ${item.name} information`, item.options);
    space.graphDecision({ id: item.seed.id, otherId: item.other.id, decision: 'confirmed' }, admin);
  }
  await space.graph().sync();
  for (const item of cases) {
    for (const [options, expected] of [
      [{}, item.current],
      [{ mode: 'history' }, true],
      [{ mode: 'as-of', asOf: '2025-06-01T00:00:00Z' }, item.asOf],
    ]) {
      space.setConfig({ ...space.config, graphRecall: false });
      const before = space.recall(item.query, reader, options);
      space.setConfig({ ...space.config, graphRecall: true });
      const after = space.recall(item.query, reader, options);
      assert.deepEqual(after.picked.slice(0, before.picked.length).map(value => value.id),
        before.picked.map(value => value.id));
      assert.ok(after.text.startsWith(before.text));
      assert.equal(after.picked.some(value => value.id === item.other.id && value.graphRelation), expected);
      assert.ok(after.picked.filter(value => value.channel === 'query').length <= 1);
      assert.ok(after.estimatedTokens <= after.budget);
    }
  }
  space.setConfig({ ...space.config, graphRecall: false });
  const baseline = space.recall(cases[0].query, reader);
  space.setConfig({ ...space.config, graphRecall: true });
  const constrained = space.recall(cases[0].query, reader, { budget: baseline.estimatedTokens });
  assert.equal(constrained.diagnostics.returnedGraph, 0);
  assert.ok(constrained.estimatedTokens <= baseline.estimatedTokens);
  space.graph().fail(new Error('synthetic corruption'));
  const degraded = space.recall(cases[0].query, reader);
  assert.equal(degraded.graphStatus.state, 'unavailable');
  assert.deepEqual(degraded.picked.map(item => item.id), baseline.picked.map(item => item.id));
  assert.equal(degraded.text, baseline.text);
  await assert.rejects(space.graph().sync(), { code: 'GRAPH_INDEX_FAILED' });
});

test('graph additions share the five-item association limit with source expansion', async t => {
  const { space } = fixture(t, { graphRecall: true, maxRecall: 1 });
  const sources = Array.from({ length: 4 }, (_, i) => create(space, `separate source ${i}`));
  const seed = create(space, 'uniqueassociationanchor', { layer: 'L3', parents: sources.map(item => item.id) });
  const neighbors = Array.from({ length: 4 }, (_, i) => create(space, `separate confirmed neighbor ${i}`));
  for (const other of neighbors) space.graphDecision({ id: seed.id, otherId: other.id, decision: 'confirmed' }, admin);
  await space.graph().sync();
  const result = space.recall('uniqueassociationanchor', reader);
  assert.equal(result.picked.filter(item => item.channel === 'query').length, 1);
  assert.equal(result.picked.filter(item => item.channel === 'association').length, 5);
  assert.equal(result.diagnostics.returnedGraph, 1);
  assert.ok(result.estimatedTokens <= result.budget);
});

test('dense graph relations page without duplicates and do not treat a linked node as isolated', async t => {
  const { space } = fixture(t);
  const center = create(space, 'dense synthetic center', { layer: 'L3', topics: ['shared synthetic topic'] });
  const neighbors = Array.from({ length: 215 }, (_, i) =>
    create(space, `dense synthetic neighbor ${i}`, { topics: ['shared synthetic topic'] }));
  await space.graph().sync();
  const ids = [], seenCursors = new Set();
  let cursor = '';
  do {
    const page = space.graphNeighbors({ id: center.id, cursor, limit: 50 }, reader);
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seenCursors.has(cursor));
      seenCursors.add(cursor);
    }
  } while (cursor);
  assert.equal(ids.length, neighbors.length);
  assert.deepEqual(new Set(ids), new Set(neighbors.map(item => item.id)));
  assert.ok(!space.graphList({ relation: 'isolated' }, reader).items.some(item => item.id === center.id));
});

test('restore rejects malformed graph references before publishing a space', t => {
  const { root, space } = fixture(t);
  const center = create(space, 'synthetic graph restore center', { layer: 'L3' });
  const other = create(space, 'synthetic graph restore other');
  space.graphDecision({ id: center.id, otherId: other.id, decision: 'confirmed' }, admin);
  const envelope = JSON.parse(packBackup(space));
  const document = JSON.parse(envelope.payload);
  document.graphRelations[0].rightId = '00000000-0000-0000-0000-000000000000';
  envelope.payload = JSON.stringify(document);
  envelope.sha256 = hash(envelope.payload);
  assert.throws(() => restoreBackup(root, 'invalid-graph', JSON.stringify(envelope), '', space.config),
    { code: 'INVALID_BACKUP' });
  envelope.version = 1;
  assert.throws(() => unpackBackup(JSON.stringify(envelope)), { code: 'INVALID_BACKUP' });
});

test('graph index yields when paused and invalidates on edits, expiry and restart', async t => {
  const { space, open } = fixture(t);
  let center = create(space, 'pause center', { layer: 'L3', topics: ['before'] });
  const other = create(space, 'pause neighbor', { topics: ['before'] });
  const index = space.graph();
  await assert.rejects(index.sync({ shouldPause: () => true }), { code: 'GRAPH_PAUSED' });
  assert.equal(index.state, 'partial');
  await index.sync();
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items.length, 1);
  center = space.update(center.id, { topics: ['after'] }, center.revision, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items.length, 0);
  space.update(other.id, { topics: ['after'], validUntil: '2026-03-01T00:00:00Z' }, other.revision, admin);
  assert.equal(space.graphNeighbors({ id: center.id }, reader).items.length, 0);
  assert.equal(space.graphNeighbors({ id: center.id, mode: 'history' }, reader).items.length, 1);
  space.close();
  const reopened = open('shared');
  await reopened.graph().sync();
  assert.equal(reopened.graphNeighbors({ id: center.id, mode: 'history' }, reader).items.length, 1);
});

test('a paused graph build resumes after its last completed batch', async t => {
  const { space } = fixture(t);
  for (let i = 0; i < 225; i++) create(space, `synthetic batch item ${i}`);
  const index = space.graph();
  let checks = 0;
  await assert.rejects(index.sync({ shouldPause: () => ++checks > 3 }), { code: 'GRAPH_PAUSED' });
  assert.equal(index.progress.scanned, 200);
  create(space, 'synthetic item added while paused');
  await index.sync();
  assert.ok(index.progress.scanned >= 225 && index.progress.scanned <= 226);
  assert.equal(index.status().indexed, 226);
});
