import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime, ADMIN } from '../src/runtime.js';
import { MODEL_PACKS } from '../src/model-packs.js';
import { packBackup, restoreBackup } from '../src/transfer.js';

class SyntheticEmbedding {
  constructor() { this.calls = []; this.state = { ready: true }; }
  configure(config) {
    this.key = config.embeddingMode;
    this.pack = { ...MODEL_PACKS.cpu, fingerprint: 'synthetic-fingerprint',
      files: { 'model/onnx/model.onnx': MODEL_PACKS.cpu.weightHash } };
  }
  async ready() { return this.pack; }
  async embed(texts) {
    this.calls.push(...texts);
    return texts.map(text => {
      const result = new Float32Array(this.pack.dimension);
      result[/center|candidate|EXPIRED|EXCLUDED/.test(text) ? 0 : 1] = 1;
      return result;
    });
  }
  async close() {}
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-graph-semantic-'));
  const embedding = new SyntheticEmbedding();
  const runtime = new TidalRuntime({ agents: { list: () => [] }, logger: { warn() {} } },
    { dataRoot: root, embeddingMode: 'cpu', autoBackup: false, privateWriters: ['synthetic-author'] },
    root, { embedding });
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const store = runtime.space('shared');
  const create = (text, options = {}) => store.create({
    layer: 'L2', text, status: 'active', kind: 'user_statement', ...options,
  }, ADMIN);
  return { runtime, store, embedding, create };
}

async function prepare(runtime, store) {
  const result = await runtime.prepareSemantic(store, ADMIN, '');
  assert.equal(result.status.state, 'ready');
}

test('semantic graph suggestions are bounded, scoped, lossless and never sent to recall automatically', async t => {
  const { runtime, store, embedding, create } = fixture(t);
  const center = create('center semantic cue', { layer: 'L3' });
  let candidate = create('candidate supporting information');
  const excluded = create('EXCLUDED supporting information');
  const expired = create('EXPIRED supporting information', { validUntil: '2020-01-01T00:00:00Z' });
  create('unrelated synthetic information');
  store.graphDecision({ id: center.id, otherId: excluded.id, decision: 'excluded' }, ADMIN);
  store.capture({ text: 'BUFFER_GRAPH_SEMANTIC_CANARY', sessionId: 's', eventId: 1, role: 'user' });
  store.appendPrivate('synthetic-author', 'PRIVATE_GRAPH_SEMANTIC_CANARY');
  runtime.space('other').create({ layer: 'L2', text: 'candidate OTHER_SPACE_CANARY' }, ADMIN);
  await prepare(runtime, store);
  const before = store.recall('center semantic cue', { sessionId: 'reader' });
  const result = await runtime.requestGraphSuggestions(store, { id: center.id });
  assert.deepEqual(result.items.map(item => item.id), [candidate.id]);
  assert.equal(result.items[0].relation.kind, 'semantic');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.ok(result.scanned <= 2000);
  assert.ok(result.comparisons <= 50000);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  assert.equal(JSON.stringify(embedding.calls).includes('CANARY'), false);
  const history = await runtime.requestGraphSuggestions(store, { id: center.id, mode: 'history' });
  assert.ok(history.items.some(item => item.id === expired.id));
  assert.ok(!history.items.some(item => item.id === excluded.id));
  assert.deepEqual(store.recall('center semantic cue', { sessionId: 'reader' }).picked.map(item => item.id),
    before.picked.map(item => item.id));
  candidate = store.update(candidate.id, { text: 'candidate revised information' }, candidate.revision, ADMIN);
  assert.throws(() => store.graphDecision({ id: center.id, otherId: candidate.id, decision: 'confirmed',
    revision: center.revision, otherRevision: result.items[0].revision }, ADMIN), { code: 'REVISION_CONFLICT' });
  await prepare(runtime, store);
  store.graphDecision({ id: center.id, otherId: candidate.id, decision: 'confirmed',
    revision: center.revision, otherRevision: candidate.revision }, ADMIN);
  assert.ok(!(await runtime.requestGraphSuggestions(store, { id: center.id })).items.some(item => item.id === candidate.id));
  await store.graph().sync();
  assert.ok(store.graphNeighbors({ id: center.id }, ADMIN).items.some(item => item.id === candidate.id &&
    item.relation.kind === 'confirmed'));
});

test('semantic graph candidates reject uncalibrated models and malformed vectors', async t => {
  const { runtime, store, embedding, create } = fixture(t);
  const center = create('center synthetic', { layer: 'L3' });
  const other = create('candidate synthetic');
  await prepare(runtime, store);
  embedding.pack.modelId = 'uncalibrated-model';
  await assert.rejects(runtime.requestGraphSuggestions(store, { id: center.id }), { code: 'GRAPH_MODEL_UNCALIBRATED' });
  embedding.pack.modelId = MODEL_PACKS.cpu.modelId;
  store.semanticIndex.db.prepare('UPDATE vectors SET vector=? WHERE id=?').run(Buffer.from([0]), other.id);
  await assert.rejects(runtime.requestGraphSuggestions(store, { id: center.id }), { code: 'SEMANTIC_INDEX_INVALID' });
  store.semanticIndex.db.prepare('UPDATE vectors SET vector=? WHERE id=?')
    .run(Buffer.alloc(MODEL_PACKS.cpu.dimension * 4), other.id);
  await assert.rejects(runtime.requestGraphSuggestions(store, { id: center.id }), { code: 'SEMANTIC_INDEX_INVALID' });
  store.semanticIndex.db.prepare("UPDATE metadata SET value='obsolete' WHERE key='model'").run();
  await assert.rejects(runtime.requestGraphSuggestions(store, { id: center.id }), { code: 'SEMANTIC_NOT_PREPARED' });
});

test('semantic suggestion work yields to foreground work and cannot return a concurrently forgotten node', async t => {
  const { runtime, store, create } = fixture(t);
  const center = create('center synthetic', { layer: 'L3' });
  const candidate = create('candidate synthetic');
  for (let i = 0; i < 130; i++) create(`unrelated synthetic item ${i}`);
  await prepare(runtime, store);
  const cancelled = runtime.requestGraphSuggestions(store, { id: center.id });
  runtime.cancelGraphBuild('shared');
  await assert.rejects(cancelled, { code: 'GRAPH_PAUSED' });
  const forgetting = runtime.requestGraphSuggestions(store, { id: center.id });
  store.forget(candidate.id, ADMIN);
  await assert.rejects(forgetting, { code: 'FORGET_CONFLICT' });
  await prepare(runtime, store);
  const changed = runtime.requestGraphSuggestions(store, { id: center.id });
  store.update(center.id, { text: 'changed center synthetic' }, center.revision, ADMIN);
  await assert.rejects(changed, { code: 'GRAPH_OBSOLETE' });
});

test('semantic suggestions recheck the forget ledger after collecting the last candidate', async t => {
  const { runtime, store, create } = fixture(t);
  const center = create('center synthetic', { layer: 'L3' });
  const candidate = create('candidate synthetic');
  restoreBackup(runtime.root, 'restored', packBackup(store), '', store.config);
  const sibling = runtime.space('restored');
  await prepare(runtime, store);
  const visible = store.visible;
  let candidateChecks = 0;
  store.visible = function (record, actor) {
    const accepted = visible.call(this, record, actor);
    if (record.id === candidate.id && ++candidateChecks === 2) sibling.forget(candidate.id, ADMIN);
    return accepted;
  };
  try {
    await assert.rejects(runtime.requestGraphSuggestions(store, { id: center.id }), { code: 'FORGET_CONFLICT' });
    assert.equal(candidateChecks, 2);
    assert.equal(store.rawOrdinary(candidate.id), undefined);
  } finally { store.visible = visible; }
});

test('long semantic documents are compared in bounded, resumable batches', async t => {
  const { runtime, store, create } = fixture(t);
  const center = create(`center ${'x'.repeat(15000)}`, { layer: 'L3' });
  for (let i = 0; i < 30; i++) create(`candidate ${i} ${'x'.repeat(15000)}`);
  await prepare(runtime, store);
  const chunks = store.semanticIndex.db.prepare('SELECT chunks FROM documents WHERE id=?').get(center.id).chunks;
  assert.ok(chunks > 1);
  const first = await runtime.requestGraphSuggestions(store, { id: center.id });
  assert.ok(first.nextCursor);
  assert.ok(first.comparisons <= 50000);
  assert.ok(first.items.length <= 10);
  const second = await runtime.requestGraphSuggestions(store, { id: center.id, cursor: first.nextCursor });
  assert.ok(second.comparisons <= 50000);
  assert.ok(second.items.length > 0 && second.items.length <= 10);
  assert.equal(first.items.some(item => second.items.some(next => next.id === item.id)), false);
});

test('changing the local model cancels in-flight graph suggestions', async t => {
  const { runtime, store, create } = fixture(t);
  const center = create('center synthetic', { layer: 'L3' });
  for (let i = 0; i < 130; i++) create(`candidate synthetic ${i}`);
  await prepare(runtime, store);
  const pending = runtime.requestGraphSuggestions(store, { id: center.id });
  runtime.rawConfig.embeddingMode = 'off';
  runtime.syncConfig();
  await assert.rejects(pending, { code: 'GRAPH_PAUSED' });
});
