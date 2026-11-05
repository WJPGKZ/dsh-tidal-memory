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
]) {
  test(`real rc5 agent-loop request: ${scenario.name}`, { timeout: 15000 }, async () => {
    const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
      { SystemPrompt }, { ToolRuntime }, { AgentLoop }, { createUserMessage, isAgentLoopRequest }, plugin] = await Promise.all([
      hostModule('@deepseek-ai/cordis'), hostModule('@deepseek-ai/dsh-agent'),
      hostModule('@deepseek-ai/dsh-session'), hostModule('@deepseek-ai/dsh-session-projection'),
      hostModule('@deepseek-ai/dsh-system-prompt'), hostModule('@deepseek-ai/dsh-tools'),
      hostModule('@deepseek-ai/dsh-agent-loop'), hostModule('@deepseek-ai/dsh-llm'), import('../index.js'),
    ]);
    const root = mkdtempSync(join(tmpdir(), 'tidal-request-'));
    const cwd = join(root, 'workspace');
    const ctx = new Context(), fibers = [], requests = [];
    const canary = scenario.captured ? '这个项目用 SQLite 存储。' : 'omega protocol {{must_stay_literal}}';
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
      for (const dependency of [AgentRegistry, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentLoop]) {
        const fiber = await ctx.plugin(dependency, {});
        assert.equal(fiber.state, 2);
        fibers.push(fiber);
      }
      fibers.push(await ctx.plugin(plugin, {
        dataRoot: root, bindings: [{ cwd, space: 'shared' }], autoBackup: false,
        injectContext: !scenario.disabled,
      }));
      ctx.systemPrompt.section({ name: 'synthetic-prompt', order: 1, text: 'PROMPT_CANARY', complete: !!scenario.complete });
      if (scenario.suppressed) ctx.systemPrompt.suppressRuntimeContext();
      const agent = await ctx.agentLoop.create('request-session', { provider: 'synthetic', model: 'no-network' }, { cwd });
      if (!scenario.captured) {
        const memory = ctx.tidalMemory.forAgent(agent).proposeMemory({ layer: 'L3', text: canary });
        assert.equal(memory.status, 'active');
      }
      for (let turn = 0; turn < 2; turn++) {
        const current = scenario.captured && turn ? await ctx.agentLoop.create('other-session',
          { provider: 'synthetic', model: 'no-network' }, { cwd }) : agent;
        current.followup(createUserMessage({ content: [{ type: 'text', text: scenario.captured ? (turn ? 'SQLite' : canary) :
          scenario.long ? 'omega protocol '.repeat(300) : 'omega protocol' }], source: { kind: 'user' } }));
        await current.whenIdle();
      }
      assert.equal(requests.length, 2, JSON.stringify(agent.session.snapshotEvents()));
      const request = requests.at(-1);
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
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
