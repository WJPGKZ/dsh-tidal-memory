import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime, ADMIN } from '../src/runtime.js';
import { MemorySpace } from '../src/store.js';
import { semanticChunks } from '../src/semantic-index.js';
import { MemoryError, hash } from '../src/model.js';
import { readModelPack, normalizedVector, packFile } from '../src/embedding.js';

class TestEmbedding {
  constructor() {
    this.calls = [];
    this.state = {};
    this.wait = Promise.resolve();
  }
  configure(config) {
    this.key = JSON.stringify([config.embeddingMode, config.embeddingModelPath]);
    this.pack = { fingerprint: hash(this.key), modelId: 'synthetic-local', dimension: 32,
      chunkSize: 384, minScore: 0.7, relativeFloor: 0.9 };
  }
  async ready() {
    await this.wait;
    if (this.closed) throw new MemoryError('CLOSED', 'test model closed');
    return this.pack;
  }
  async embed(texts, kind) {
    this.calls.push({ texts, kind });
    return texts.map(text => {
      const vector = new Float32Array(32);
      vector[/SQLite|PostgreSQL|数据库|数据保存/.test(text) ? 0 : /帆船|水上运动/.test(text) ? 1 : 31] = 1;
      return vector;
    });
  }
  pause() { this.wait = new Promise(resolve => { this.resume = resolve; }); }
  reload() { this.key += ':reload'; this.pack.fingerprint = hash(this.key); }
  async close() { this.closed = true; this.resume?.(); }
}
function fixture(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-semantic-'));
  const cwd = join(root, 'workspace'), embedding = new TestEmbedding();
  const config = { dataRoot: root, embeddingMode: 'cpu', autoBackup: false, residentBudget: 0,
    bindings: [{ cwd, space: 'shared' }], privateWriters: ['test-author'], ...patch };
  const agent = { id: 'session-b', session: { id: 'session-b', header: { cwd }, snapshotEvents: () => [] } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined, list: () => [agent] },
    settings: { describe: () => [] }, logger: { warn() {} } };
  const runtime = new TidalRuntime(ctx, config, root, { embedding });
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, embedding, agent, config, store: runtime.space('shared') };
}
const message = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const admit = text => async () => ({ kind: 'accept', messages: [message(text)] });

test('mixed semantic, resident and association recall keeps nullable scores lossless', async t => {
  const { runtime, store, agent } = fixture(t, { residentBudget: 16000 });
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  const resident = store.create({ layer: 'L3', text: 'stable background' }, ADMIN);
  const association = store.create({ layer: 'L2', text: 'second evidence', parents: [memory.id] }, ADMIN);
  const result = await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const picked = new Map(result.picked.map(item => [item.id, item]));
  assert.equal(picked.size, 3);
  assert.equal(picked.get(memory.id).semanticScore, 1);
  assert.ok(picked.get(memory.id).fusionScore > 0);
  assert.equal(picked.get(resident.id).semanticScore, null);
  assert.equal(picked.get(resident.id).fusionScore, 0);
  assert.equal(picked.get(association.id).semanticScore, null);
  assert.equal(picked.get(association.id).fusionScore, null);
});

test('semantic recall indexes only ordinary persistent memory and reaches every async surface', async t => {
  const { runtime, store, embedding, agent } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite', sessionId: 'session-a' }, ADMIN);
  store.capture({ text: 'BUFFER_CANARY', sessionId: 's', eventId: 1, role: 'user' });
  store.appendPrivate('test-author', 'PRIVATE_CANARY');
  const result = await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.ok(result.picked.some(item => item.id === memory.id && item.semanticScore === 1));
  assert.equal(result.semanticStatus.state, 'ready');
  assert.equal(store.semanticIndex.status().indexed, 1);
  assert.equal(JSON.stringify(embedding.calls).includes('CANARY'), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('vector'), false);
  const api = await runtime.api('POST', '/recall', new URLSearchParams({ space: 'shared' }), { query: '数据保存在哪里？' });
  assert.ok(api.picked.some(item => item.id === memory.id));
  assert.equal(runtime.recallForAgent(agent, '数据保存在哪里？').semanticStatus.state, 'lexical');
  await assert.rejects(runtime.recallForAgentAsync({ ...agent, id: 'intruder' }, '数据保存在哪里？'), { code: 'NO_AGENT' });
});

test('first admitted input supplies semantic recall before capture, strengthening waits for its real event', async t => {
  const { runtime, store, agent } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  await runtime.preStep({ agent }, admit('数据保存在哪里？'));
  assert.equal(store.db('L0').prepare('SELECT count(*) AS n FROM memories').get().n, 0);
  assert.match(runtime.context({ agent }), /SQLite/);
  assert.equal(store.raw(memory.id).recallCount, 0);
  const event = { type: 'user/message', seq: 1, time: Date.now(), data: message('数据保存在哪里？') };
  runtime.onEvent(agent.session, event);
  runtime.onEvent(agent.session, event);
  assert.equal(store.raw(memory.id).recallCount, 1);
});

test('index revisions update without recomputing unchanged content; edits and forgetting remove old vectors', async t => {
  const { runtime, store, embedding, agent } = fixture(t);
  let memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  const documentCalls = () => embedding.calls.filter(call => call.kind === 'document').length;
  assert.equal(documentCalls(), 1);
  store.recordRetrieval(memory.id, 'new-evidence');
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.equal(documentCalls(), 1);
  memory = store.raw(memory.id);
  store.update(memory.id, { text: '我喜欢帆船。' }, memory.revision, ADMIN);
  assert.equal(store.semanticIndex.status().indexed, 0);
  const oldQuery = await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.equal(oldQuery.picked.some(item => item.id === memory.id), false);
  assert.equal(documentCalls(), 2);
  const fresh = await runtime.recallForAgentAsync(agent, '水上运动');
  assert.ok(fresh.picked.some(item => item.id === memory.id));
  store.forget(memory.id, ADMIN);
  assert.equal(store.semanticIndex.db.prepare('SELECT count(*) AS n FROM vectors').get().n, 0);
  assert.equal((await runtime.recallForAgentAsync(agent, '水上运动')).picked.length, 0);
});

test('semantic candidates respect time modes, hidden statuses and space boundaries before ranking', async t => {
  const { runtime, store, agent } = fixture(t);
  const old = store.create({ layer: 'L2', text: '过去使用 SQLite。', status: 'superseded', validUntil: '2020-01-01' }, ADMIN);
  const current = store.create({ layer: 'L2', text: '现在使用 PostgreSQL。', validFrom: '2020-01-01' }, ADMIN);
  store.create({ layer: 'L2', text: 'SQLite 待核查', status: 'review' }, ADMIN);
  runtime.space('other').create({ layer: 'L2', text: 'OTHER_SPACE_SQLite' }, ADMIN);
  const result = await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.deepEqual(result.picked.map(item => item.id), [current.id]);
  const past = await runtime.recallForAgentAsync(agent, '数据保存在哪里？', { mode: 'as-of', asOf: '2019-01-01' });
  assert.deepEqual(past.picked.map(item => item.id), [old.id]);
  const history = await runtime.recallForAgentAsync(agent, '数据保存在哪里？', { mode: 'history' });
  assert.equal(history.picked.length, 2);
  await assert.rejects(runtime.recallForAgentAsync(agent, '数据保存在哪里？', { mode: 'as-of' }), { code: 'INVALID_TIME' });
  assert.equal(store.semanticIndex.status().indexed, 2);
});

test('cancelled and configuration-obsolete preparation never injects late semantic results', async t => {
  const { runtime, store, agent, embedding, config } = fixture(t);
  store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  embedding.pause();
  const signal = new AbortController();
  const cancelled = runtime.preStep({ agent, signal: signal.signal }, admit('数据保存在哪里？'));
  await new Promise(resolve => setImmediate(resolve));
  signal.abort();
  await cancelled;
  assert.equal(runtime.sessions.get(agent.id).semantic, undefined);
  embedding.resume();
  await Promise.allSettled([...runtime.jobs]);
  assert.equal(runtime.sessions.get(agent.id).semantic, undefined);
  embedding.pause();
  const obsolete = runtime.preStep({ agent }, admit('数据保存在哪里？'));
  await new Promise(resolve => setImmediate(resolve));
  config.embeddingMode = 'off';
  runtime.syncConfig();
  embedding.resume();
  await obsolete;
  assert.equal(runtime.sessions.get(agent.id).semantic, null);
});

test('missing local model is an explicit lexical fallback and does not prevent storage', async t => {
  const { runtime, store, embedding, agent } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  embedding.ready = async () => { throw new MemoryError('MODEL_NOT_INSTALLED', 'synthetic missing model'); };
  await runtime.preStep({ agent }, admit('SQLite'));
  const text = runtime.context({ agent });
  assert.match(text, /SQLite/);
  assert.match(text, /未完整就绪/);
  assert.equal(runtime.lastError.code, 'MODEL_NOT_INSTALLED');
  const result = await runtime.recallForAgentAsync(agent, 'SQLite');
  assert.equal(result.semanticStatus.state, 'degraded');
  assert.ok(result.picked.some(item => item.id === memory.id));
  assert.equal(store.create({ layer: 'L2', text: 'new memory' }, ADMIN).status, 'active');
});

test('async tool retrieval rechecks workspace authorization after local preparation', async t => {
  const { runtime, agent, embedding, root } = fixture(t);
  embedding.pause();
  const pending = runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  await new Promise(resolve => setImmediate(resolve));
  agent.session.header.cwd = join(root, 'unbound');
  embedding.resume();
  await assert.rejects(pending, { code: 'UNBOUND_WORKSPACE' });
});

test('closing while local preparation waits releases pending work', { timeout: 3000 }, async t => {
  const { runtime, agent, embedding } = fixture(t);
  embedding.pause();
  const pending = runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  const rejected = assert.rejects(pending, { code: 'CLOSED' });
  await new Promise(resolve => setImmediate(resolve));
  await runtime.close();
  await rejected;
  assert.equal(runtime.jobs.size, 0);
});

test('disabled injection does not invoke embeddings and model changes rebuild only derived data', async t => {
  const { runtime, store, embedding, agent, config } = fixture(t, { injectContext: false });
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  await runtime.preStep({ agent }, admit('数据保存在哪里？'));
  assert.equal(embedding.calls.length, 0);
  assert.equal(runtime.context({ agent }), '');
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  const before = store.semanticIndex.status().fingerprint;
  config.embeddingModelPath = join(runtime.root, 'different-pack');
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.notEqual(store.semanticIndex.status().fingerprint, before);
  assert.equal(store.raw(memory.id).text, 'SQLite');
});

test('restart into standard mode still purges persisted vectors on forget', async t => {
  const { runtime, store, agent, root } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  await runtime.close();
  const reopened = new MemorySpace(root, 'shared', { config: { embeddingMode: 'off' } });
  try {
    assert.equal(reopened.semanticIndex.status().indexed, 1);
    reopened.forget(memory.id, ADMIN);
    assert.equal(reopened.semanticIndex.status().indexed, 0);
  } finally { reopened.close(); }
});

test('incomplete persisted chunks are rebuilt and forgetting clears query caches', async t => {
  const { runtime, store, agent, embedding } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite '.repeat(100) }, ADMIN);
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  store.semanticIndex.db.prepare('DELETE FROM vectors WHERE id=? AND part=0').run(memory.id);
  assert.equal(store.semanticIndex.status().pending, 1);
  const before = embedding.calls.filter(call => call.kind === 'document').length;
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  assert.equal(embedding.calls.filter(call => call.kind === 'document').length, before + 1);
  assert.equal(store.semanticIndex.status().pending, 0);
  assert.ok(runtime.semanticQueries.size);
  store.forget(memory.id, ADMIN);
  assert.equal(runtime.semanticQueries.size, 0);
});

test('corrupt derived index leaves primary data available and can be removed while forgetting', async t => {
  const { runtime, store, agent, root } = fixture(t);
  const memory = store.create({ layer: 'L2', text: 'SQLite' }, ADMIN);
  await runtime.recallForAgentAsync(agent, '数据保存在哪里？');
  await runtime.close();
  const file = join(store.directory, 'indexes', 'semantic.sqlite3');
  writeFileSync(file, 'corrupt derived file');
  const reopened = new MemorySpace(root, 'shared');
  try {
    assert.ok(reopened.errors.some(error => error.code === 'SEMANTIC_INDEX_INVALID'));
    assert.equal(reopened.raw(memory.id).text, 'SQLite');
    reopened.forget(memory.id, ADMIN);
    assert.equal(existsSync(file), false);
  } finally { reopened.close(); }
});

test('chunking preserves long input and validates pack paths and numeric vectors', () => {
  const text = '中文🙂'.repeat(3000);
  const chunks = semanticChunks(text, 384);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => [...chunk].length <= 384 && chunk.isWellFormed()));
  assert.equal(chunks[0] + chunks.slice(1).map(chunk => [...chunk].slice(48).join('')).join(''), text);
  assert.throws(() => packFile(process.cwd(), '..\\outside-model'), { code: 'INVALID_MODEL_PACK' });
  assert.throws(() => readModelPack(join(process.cwd(), 'nonexistent-model-pack')), { code: 'MODEL_NOT_INSTALLED' });
  assert.throws(() => normalizedVector([NaN, 1], 2), { code: 'INVALID_EMBEDDING' });
  assert.throws(() => normalizedVector([0, 0], 2), { code: 'INVALID_EMBEDDING' });
});
