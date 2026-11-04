import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime } from '../src/runtime.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-runtime-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoExtract: true, autoBackup: false, bindings: [{ cwd, space: 'shared' }] };
  const agent = { id: 'new-session', status: 'idle', session: {
    header: { cwd }, requestHeader: () => ({ config: { provider: 'synthetic', model: 'test' } }), snapshotEvents: () => [],
  } };
  const agents = [agent], ctx = {
    agents: { get: id => agents.find(a => a.id === id), list: () => agents },
    settings: { describe: () => [] }, logger: { warn() {} }, llm: {},
  };
  const runtime = new TidalRuntime(ctx, config, root, value => ({ role: 'user', ...value }));
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, ctx, agent, agents, config };
}
test('workspace queue resumes old sessions through any live idle agent of that workspace', async t => {
  const { runtime, ctx } = fixture(t);
  const store = runtime.space('shared');
  store.capture({ sessionId: 'closed-session-a', eventId: 1, text: '共同偏好', role: 'user' });
  store.capture({ sessionId: 'closed-session-b', eventId: 2, text: '共同偏好', role: 'user' });
  let calls = 0;
  ctx.llm.stream = async function* (request) {
    calls++;
    const records = JSON.parse(request.messages[0].content[0].text);
    assert.equal(records.length, 2);
    const text = JSON.stringify({ items: records.map(r => ({
      sourceId: r.sourceId, quote: r.text, layer: 'L3', category: 'preference', tags: [],
    })) });
    yield { type: 'text-delta', index: 0, text: text.slice(0, 10) };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: 'stop' };
  };
  await runtime.requestMaintenance(true, 'shared');
  assert.equal(calls, 1);
  const candidates = store.all().filter(r => r.layer === 'L3');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sources.length, 2);
  assert.equal(store.all().filter(r => r.layer === 'L0' && r.status === 'pending').length, 0);
});
test('shutdown aborts and joins HTTP-triggered model work before closing databases', async t => {
  const { runtime, ctx } = fixture(t);
  runtime.space('shared').capture({ sessionId: 'old', eventId: 1, text: 'pending input' });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  ctx.llm.stream = async function* (request) {
    started();
    await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  };
  const job = runtime.requestMaintenance(true, 'shared');
  await ready;
  await runtime.close();
  await job;
  assert.equal(runtime.jobs.size, 0);
  assert.equal(runtime.controllers.size, 0);
});
test('truncated or missing model finish never commits candidates', async t => {
  const { runtime, ctx, agent } = fixture(t);
  ctx.llm.stream = async function* () {
    yield { type: 'text-delta', index: 0, text: '{"items":[]}' };
    yield { type: 'finish', reason: 'max_tokens' };
  };
  await assert.rejects(() => runtime.generate(agent, '', '', new AbortController().signal), /未正常结束/);
});
