import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime } from '../src/runtime.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-runtime-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoExtract: true, autoBackup: false,
    bindings: [{ cwd, space: 'shared' }], ...overrides };
  const agent = { id: 'new-session', status: 'idle', session: {
    header: { cwd }, requestHeader: () => ({ config: { provider: 'synthetic', model: 'test' } }), snapshotEvents: () => [],
  } };
  let modelCalls = 0;
  const agents = [agent], ctx = {
    agents: { get: id => agents.find(a => a.id === id), list: () => agents },
    settings: { describe: () => [] }, logger: { warn() {} },
    llm: { stream: () => { modelCalls++; throw new Error('Memory must not call an LLM'); } },
  };
  const runtime = new TidalRuntime(ctx, config, root);
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, ctx, agent, agents, config, root, cwd, modelCalls: () => modelCalls };
}

test('maintenance uses local rules and never calls the configured model', async t => {
  const { runtime, modelCalls } = fixture(t);
  const store = runtime.space('shared');
  store.capture({ sessionId: 'old-session', eventId: 1, text: '记住：这次任务先不改数据库', role: 'user' });
  const result = await runtime.requestMaintenance(true, 'shared');
  assert.equal(result.results[0].localOrganization.organized, 1);
  assert.equal(store.all().find(r => r.text === '这次任务先不改数据库').layer, 'L1');
  assert.equal(runtime.legacyModelExtractionIgnored, true);
  assert.equal(modelCalls(), 0);
});

test('remembering through a session automatically saves explicit and unspecified horizons', t => {
  const { runtime, agent } = fixture(t);
  const send = (seq, text) => runtime.onEvent(agent.session, {
    type: 'user/message', seq, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
  send(1, '记住：这次任务先不改数据库');
  send(2, '记住：以后回答保持简洁');
  send(3, '记住：项目名称是潮汐');
  const store = runtime.space('shared');
  assert.deepEqual(store.all().filter(r => r.layer !== 'L0').map(r => [r.text, r.layer, r.horizon, r.status]),
    [['这次任务先不改数据库', 'L1', 'task', 'active'], ['项目名称是潮汐', 'L2', 'unspecified', 'active'],
      ['以后回答保持简洁', 'L3', 'long_term', 'active']]);
  assert.equal(store.db('L0').prepare("SELECT count(*) AS n FROM memories WHERE status='review'").get().n, 0);
});

test('context injection can be disabled and workspace mutations invalidate every session cache', t => {
  const { runtime, agent, agents, config, ctx } = fixture(t, { injectContext: false });
  assert.equal(runtime.context({ agent }), '');
  config.injectContext = true;
  const other = { ...agent, id: 'other-session' };
  agents.push(other);
  runtime.sessions.set(agent.id, { context: 'stale', space: 'shared' });
  runtime.sessions.set(other.id, { context: 'stale', space: 'shared' });
  runtime.invalidateSpace('shared');
  assert.equal(runtime.sessions.get(agent.id).context, null);
  assert.equal(runtime.sessions.get(other.id).context, null);
});
