import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostModule } from '../src/host-deps.js';
import { prepareHost } from './host-env.mjs';

prepareHost();

for (const scenario of [
  { name: 'ordinary context', expected: true },
  { name: 'complete prompt', complete: true, expected: true },
  { name: 'long user message', long: true, expected: true },
  { name: 'explicit runtime suppression', complete: true, suppressed: true, expected: false },
  { name: 'plugin injection disabled', disabled: true, expected: false },
  { name: 'colloquial capture shared with another native session', captured: true, expected: true },
  { name: 'local semantic cross-session first request', semantic: 'cpu', captured: true, expected: true },
  { name: 'semantic context honors runtime suppression', semantic: 'cpu', captured: true, suppressed: true, expected: false },
  { name: 'semantic context honors complete prompt', semantic: 'cpu', captured: true, complete: true, expected: true },
  { name: 'enhanced semantic first request', semantic: 'enhanced', captured: true, expected: true },
  { name: 'explicit future meeting in another session', scheduled: true, captured: true, expected: true },
  { name: 'standard exact editor alias in another session', cross: true, expected: true,
    editor: { memory: '我写代码用 neovim。', query: '编辑器是 nvim', alias: 'nvim' } },
  { name: 'CPU editor rewrite in another session', semantic: 'cpu', cross: true, expected: true,
    editor: { memory: '我写代码用 neovim。', query: '编辑器是 nvim' } },
  { name: 'enhanced reverse editor rewrite in another session', semantic: 'enhanced', cross: true, expected: true,
    editor: { memory: '我的编辑器是 nvim。', query: '写代码用 neovim' } },
]) {
  test(`real rc5 agent-loop request: ${scenario.name}`, {
    timeout: scenario.semantic ? 60000 : 15000, skip: scenario.semantic && !process.env.TIDAL_MODEL_ROOT,
  }, async () => {
    const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
      { SystemPrompt }, { ToolRuntime }, nativeExecutor, { AgentLoop }, { createUserMessage, isAgentLoopRequest }, plugin] = await Promise.all([
      hostModule('@deepseek-ai/cordis'), hostModule('@deepseek-ai/dsh-agent'),
      hostModule('@deepseek-ai/dsh-session'), hostModule('@deepseek-ai/dsh-session-projection'),
      hostModule('@deepseek-ai/dsh-system-prompt'), hostModule('@deepseek-ai/dsh-tools'), hostModule('@deepseek-ai/dsh-tool-executor-native'),
      hostModule('@deepseek-ai/dsh-agent-loop'), hostModule('@deepseek-ai/dsh-llm'), import('../index.js'),
    ]);
    const root = mkdtempSync(join(tmpdir(), 'tidal-request-'));
    const cwd = join(root, 'workspace');
    const ctx = new Context(), fibers = [], requests = [];
    const canary = scenario.editor?.memory ?? (scenario.scheduled ? '我明天下午三点开会' :
      scenario.semantic ? '这个项目用 SQLite 数据库存储用户信息。' :
      scenario.captured ? '这个项目用 SQLite 存储。' : 'omega protocol {{must_stay_literal}}');
    const query = scenario.editor?.query ?? (scenario.scheduled ? '明天 开会' :
      scenario.semantic ? '用户数据放在哪种数据库里？' : scenario.captured ? 'SQLite' : 'omega protocol');
    try {
      ctx.provide('llm', {
        async prepareCall(config) {
          return { config, adapterDefaults: {}, async *stream(request) {
            assert.equal(isAgentLoopRequest(request), true);
            requests.push(request);
            yield { type: 'text-delta', index: 0, text: 'synthetic response' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          } };
        },
      });
      ctx.provide('webServer', { register: () => () => {} });
      ctx.provide('connection', { requestRejection: () => undefined });
      ctx.provide('settings', { describe: () => [] });
      for (const dependency of [SessionStore, SessionProjectionRegistry, AgentRegistry, SystemPrompt, ToolRuntime, nativeExecutor, AgentLoop]) {
        const fiber = await ctx.plugin(dependency, {});
        assert.equal(fiber.state, 2);
        fibers.push(fiber);
      }
      fibers.push(await ctx.plugin(plugin, {
        dataRoot: root, bindings: [{ cwd, space: 'shared' }], autoBackup: false,
        injectContext: !scenario.disabled,
        ...(scenario.editor ? { residentBudget: 0 } : {}),
        ...(scenario.semantic ? { embeddingMode: scenario.semantic, minScore: 1, residentBudget: 0,
          embeddingModelPath: join(process.env.TIDAL_MODEL_ROOT, 'models',
            scenario.semantic === 'cpu' ? 'bge-small-zh-v1.5' : 'qwen3-embedding-0.6b') } : {}),
      }));
      ctx.systemPrompt.section({ name: 'synthetic-prompt', order: 1, text: 'PROMPT_CANARY', complete: !!scenario.complete });
      if (scenario.suppressed) ctx.systemPrompt.suppressRuntimeContext();
      const agent = await ctx.agentLoop.create('request-session', { provider: 'synthetic', model: 'no-network' }, { cwd });
      if (!scenario.captured) {
        const memory = ctx.tidalMemory.forAgent(agent).proposeMemory({ layer: scenario.editor ? 'L2' : 'L3', text: canary,
          ...(scenario.editor?.alias ? { aliases: [scenario.editor.alias] } : {}) });
        assert.equal(memory.status, 'active');
      }
      for (let turn = 0; turn < 2; turn++) {
        const current = (scenario.captured || scenario.cross) && turn ? await ctx.agentLoop.create('other-session',
          { provider: 'synthetic', model: 'no-network' }, { cwd }) : agent;
        current.followup(createUserMessage({ content: [{ type: 'text', text: scenario.captured ?
          (turn ? query : scenario.scheduled ? `记住：${canary}` : canary) :
          scenario.editor ? (turn ? query : '先记录编辑器信息。') :
            scenario.long ? 'omega protocol '.repeat(300) : 'omega protocol' }], source: { kind: 'user' } }));
        await current.whenIdle();
      }
      assert.equal(requests.length, 2, JSON.stringify(agent.session.snapshotEvents()));
      const request = requests.at(-1);
      assert.equal(request.provider, 'synthetic');
      assert.equal(request.model, 'no-network');
      assert.equal(Object.isFrozen(request.messages), true);
      assert.match(JSON.stringify(request.messages), /PROMPT_CANARY/);
      const contexts = request.messages.filter(message => message.source?.kind === 'runtime-context');
      assert.equal(JSON.stringify(contexts).includes(canary), scenario.expected, scenario.captured ? JSON.stringify({
        contexts, recall: ctx.tidalMemory.forAgent(agent).recall('SQLite'),
        events: agent.session.snapshotEvents().filter(event => event.type === 'user/message'),
      }) : undefined);
      if (scenario.expected) {
        assert.match(JSON.stringify(contexts), scenario.captured ? /user_statement/ : /inference/);
        assert.match(JSON.stringify(contexts), /未人工核实/);
      }
      const { results: [{ result: recalled }] } = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: 'recall-after-request', name: 'tidal_recall', arguments: JSON.stringify({ query }) }],
        agent, signal: new AbortController().signal,
      });
      assert.equal(recalled.isError, false, JSON.stringify(recalled));
      assert.ok(recalled.value.picked.length > 0, JSON.stringify(recalled.value));
      assert.deepEqual(JSON.parse(recalled.content[0].text), recalled.value);
      if (scenario.semantic) {
        assert.equal(recalled.value.semanticStatus.state, 'ready');
        assert.ok(recalled.value.picked.some(item => typeof item.semanticScore === 'number'));
      }
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('real rc5 fork sessions retain the exact seeded conversation prefix', async () => {
  const [{ Context }, { SessionStore }, { createUserMessage }] = await Promise.all([
    hostModule('@deepseek-ai/cordis'), hostModule('@deepseek-ai/dsh-session'), hostModule('@deepseek-ai/dsh-llm'),
  ]);
  const ctx = new Context(), fibers = [];
  try {
    fibers.push(await ctx.plugin(SessionStore, {}));
    const cwd = join(tmpdir(), 'tidal-fork-contract');
    const parent = ctx.sessions.create('private-parent', { meta: { cwd } });
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE_FORK_CANARY' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' });
    const inherited = parent.snapshotEvents();
    const fork = ctx.sessions.create('private-fork', {
      seed: inherited, inheritedEventCount: inherited.length,
      meta: { cwd, parentSession: parent.id, isSeeded: true, origin: 'subagent', delegationDepth: 1 },
    });

    assert.equal(fork.header.isSeeded, true);
    assert.equal(fork.header.parentSession, parent.id);
    assert.equal(fork.header.origin, 'subagent');
    assert.equal(fork.inheritedEventCount, inherited.length);
    assert.match(JSON.stringify(fork.snapshotEvents().slice(0, fork.inheritedEventCount)), /PRIVATE_FORK_CANARY/);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});

test('real rc5 tool batches retain per-call result identity and bounded event reads', async () => {
  const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
    { SessionQueryEngine }, { SystemPrompt }, { ToolRuntime, defineTool }, nativeExecutor,
    { AgentLoop }, { createUserMessage }] = await Promise.all([
    hostModule('@deepseek-ai/cordis'), hostModule('@deepseek-ai/dsh-agent'),
    hostModule('@deepseek-ai/dsh-session'), hostModule('@deepseek-ai/dsh-session-projection'),
    hostModule('@deepseek-ai/dsh-session-query'), hostModule('@deepseek-ai/dsh-system-prompt'),
    hostModule('@deepseek-ai/dsh-tools'), hostModule('@deepseek-ai/dsh-tool-executor-native'),
    hostModule('@deepseek-ai/dsh-agent-loop'), hostModule('@deepseek-ai/dsh-llm'),
  ]);
  const ctx = new Context(), fibers = [];
  let requests = 0;
  try {
    ctx.provide('llm', {
      async prepareCall(config) {
        return { config, adapterDefaults: {}, async *stream() {
          if (requests++ === 0) {
            yield { type: 'tool-call-delta', index: 0, id: 'call-a',
              name: 'fixture_receipt', argumentsDelta: '{"item":"alpha"}' };
            yield { type: 'tool-call-delta', index: 1, id: 'call-b',
              name: 'fixture_receipt', argumentsDelta: '{"item":"beta"}' };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
          } else {
            yield { type: 'text-delta', index: 0, text: 'synthetic response' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        } };
      },
    });
    for (const dependency of [SessionStore, SessionProjectionRegistry, AgentRegistry, SessionQueryEngine,
      SystemPrompt, ToolRuntime, nativeExecutor, AgentLoop]) {
      const fiber = await ctx.plugin(dependency, {});
      assert.equal(fiber.state, 2);
      fibers.push(fiber);
    }
    const unregister = ctx.tools.register(defineTool({
      name: 'fixture_receipt', description: 'Synthetic per-item result.',
      parameters: { item: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async ({ item }) => ({ item, saved: item === 'alpha' }),
    }));
    try {
      const cwd = join(tmpdir(), 'tidal-rc5-event-contract');
      const agent = await ctx.agentLoop.create('event-contract', { provider: 'synthetic', model: 'no-network' }, { cwd });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the synthetic batch.' }],
        source: { kind: 'user' } }));
      await agent.whenIdle();
      const events = agent.session.snapshotEvents();
      const calls = events.filter(event => event.type === 'tool/call');
      const results = events.filter(event => event.type === 'tool/result');
      assert.equal(requests, 2);
      assert.equal(calls.length, 2);
      assert.equal(results.length, 2);
      for (const call of calls) {
        const result = results.find(item => item.data.message.toolCallId === call.data.callId);
        assert.ok(result);
        assert.equal(result.data.message.source.kind, 'tool');
        assert.equal(result.data.message.source.callId, call.data.callId);
        assert.equal(result.data.turn, call.data.turn);
        assert.equal(result.data.step, call.data.step);
        assert.deepEqual(result.sourceEventSeqs, [call.seq]);
        assert.equal(result.data.message.isError, false);
      }
      const selected = results[0];
      const window = await ctx.sessionQuery.readEvent({ sessionId: agent.id, seq: selected.seq, before: 1, after: 1 });
      assert.equal(window.session.id, agent.id);
      assert.equal(window.session.cwd, cwd);
      assert.equal(window.target.seq, selected.seq);
      assert.equal(window.events.length, 3);
      assert.deepEqual(window.events.map(event => event.seq), [selected.seq - 1, selected.seq, selected.seq + 1]);
      await assert.rejects(ctx.sessionQuery.readEvent({ sessionId: agent.id, seq: selected.seq, before: -1 }),
        { code: 'SESSION_QUERY_INVALID_WINDOW' });
    } finally {
      unregister();
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});
