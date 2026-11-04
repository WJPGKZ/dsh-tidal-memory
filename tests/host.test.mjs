import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostModule } from '../src/host-deps.js';
import { configOf } from '../src/model.js';
import { prepareHost } from './host-env.mjs';

prepareHost();

test('real rc5 Cordis lifecycle, volatile configuration, tools, context and private author', async () => {
  const plugin = await import('../index.js');
  const { Context } = await hostModule('@deepseek-ai/cordis');
  const { SystemPrompt } = await hostModule('@deepseek-ai/dsh-system-prompt');
  const root = mkdtempSync(join(tmpdir(), 'tidal-host-'));
  const cwd = join(root, 'workspace');
  const ctx = new Context();
  const tools = new Map(), routes = new Map(), agents = new Map();
  const session = { id: 'session-a', header: { cwd }, snapshotEvents: () => [] };
  const agent = { id: session.id, session, status: 'idle' };
  agents.set(agent.id, agent);
  let fiber, promptFiber, writerFiber, writer;
  const raw = { dataRoot: root, bindings: [{ cwd, space: 'shared' }], autoBackup: false,
    privateWriters: ['fixture-author'] };
  try {
    const modules = process.env.TIDAL_HOST_MODULES, entry = process.argv[1];
    try {
      delete process.env.TIDAL_HOST_MODULES;
      process.argv[1] = join(modules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
      assert.equal((await hostModule('@deepseek-ai/cordis')).Context, Context);
    } finally {
      process.env.TIDAL_HOST_MODULES = modules; process.argv[1] = entry;
    }
    ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
    ctx.provide('sessions', {});
    ctx.provide('tools', { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
    ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } });
    ctx.provide('connection', { requestRejection: () => undefined });
    ctx.provide('llm', { stream: () => { throw new Error('No model calls permitted in host check'); } });
    ctx.provide('settings', { describe: () => [], update: () => { throw new Error('No live settings'); } });
    promptFiber = await ctx.plugin(SystemPrompt, {});
    fiber = await ctx.plugin(plugin, raw);
    assert.equal(fiber.state, 2);
    assert.equal(plugin.inject.includes('llm'), false);
    assert.equal(configOf(fiber.config).tokenBudget, 48000);
    assert.equal(routes.size, 1);
    assert.deepEqual([...tools.keys()].sort(), ['tidal_correct', 'tidal_read_evidence', 'tidal_recall', 'tidal_remember']);
    const record = await tools.get('tidal_remember').execute({ text: '候选主题', layer: 'L3' }, { agent });
    assert.equal(record.status, 'active');
    const corrected = await tools.get('tidal_correct').execute({
      id: record.id, text: '工具修订主题', revision: record.revision,
    }, { agent });
    assert.equal(corrected.kind, 'inference');
    assert.equal(corrected.status, 'active');
    await assert.rejects(() => tools.get('tidal_remember').execute({ text: 'bad', layer: 'L9' }, { agent }));
    const text = '记住：以后合成模板 {{must_stay_literal}} 是长期测试知识。';
    ctx.emit('session/event', session, { type: 'user/message', seq: 1, time: Date.now(),
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } });
    const disposeComplete = ctx.systemPrompt.section({
      name: 'synthetic-complete', order: 1, text: 'complete section', complete: true,
    });
    const assembled = await ctx.systemPrompt.assemble({ agent });
    disposeComplete();
    assert.deepEqual(assembled.sections.map(section => section.name), ['synthetic-complete']);
    const context = assembled.contexts.find(c => c.name === 'tidal-memory');
    assert.match(context.text, /\{\{must_stay_literal\}\}/);
    assert.equal(context.interpolate, false);
    assert.equal(JSON.stringify(assembled).includes('候选主题'), false);
    writerFiber = await ctx.plugin({
      name: 'fixture-author', inject: ['tidalMemory'],
      apply(owner) { writer = owner.tidalMemory.privateWriter(owner); },
    });
    assert.equal(writer.append('shared', 'PRIVATE_HOST_CANARY').saved, true);
    assert.throws(() => ctx.tidalMemory.privateWriter({}), /真实 Context/);
    assert.equal(ctx.tidalMemory.forAgent(agent).recall('PRIVATE_HOST_CANARY').text.includes('PRIVATE_HOST_CANARY'), false);
    await writerFiber.dispose();
    assert.throws(() => writer.append('shared', 'stopped'), /停止/);
    await fiber.dispose();
    assert.equal(tools.size, 0);
    assert.equal(routes.size, 0);
  } finally {
    if (writerFiber?.uid) await writerFiber.dispose();
    if (fiber?.uid) await fiber.dispose();
    if (promptFiber?.uid) await promptFiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
