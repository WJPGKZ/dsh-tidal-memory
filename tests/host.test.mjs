import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { hostModule } from '../src/host-deps.js';
import { openDatabase } from '../src/database.js';
import { configOf } from '../src/model.js';
import { MemorySpace } from '../src/store.js';
import { prepareHost } from './host-env.mjs';

prepareHost();

test('real rc5 tool output preserves graph additions as lossless JSON', async () => {
  const [plugin, { Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    import('../index.js'), hostModule('@deepseek-ai/cordis'),
    hostModule('@deepseek-ai/dsh-system-prompt'), hostModule('@deepseek-ai/dsh-tools'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'tidal-graph-host-'));
  const cwd = join(root, 'workspace'), ctx = new Context(), fibers = [];
  const session = { id: 'reader', header: { cwd }, snapshotEvents: () => [] };
  const agent = { id: session.id, session, status: 'idle' };
  let route, seed, related;
  try {
    const store = new MemorySpace(root, 'shared', { config: { residentBudget: 0 } });
    try {
      seed = store.create({ layer: 'L2', text: 'synthetic violet protocol' }, { admin: true });
      related = store.create({ layer: 'L3', text: 'synthetic supporting knowledge' }, { admin: true });
      store.graphDecision({ id: seed.id, otherId: related.id, decision: 'confirmed' }, { admin: true });
    } finally { store.close(); }
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] });
    ctx.provide('sessions', {});
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: { id: 'named-offline', cwd } }],
      readTitleSnapshots: async () => [{ status: 'fulfilled', value: {
        session: { id: 'named-offline', cwd }, title: { title: '合成的历史主会话' },
      } }],
    });
    ctx.provide('webServer', { register: value => { route = value; return () => {}; } });
    ctx.provide('connection', { requestRejection: () => undefined });
    ctx.provide('settings', { describe: () => [] });
    for (const dependency of [SystemPrompt, ToolRuntime]) fibers.push(await ctx.plugin(dependency, {}));
    fibers.push(await ctx.plugin(plugin, { dataRoot: root, bindings: [{ cwd, space: 'shared' }],
      autoBackup: false, residentBudget: 0, graphRecall: true }));
    const request = async (method, path, body) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.url = `/tidal-memory${path}?space=shared`;
      req.headers = { 'x-tidal-request': '1', 'content-type': 'application/json' };
      const res = { writableEnded: false, setHeader() {}, end(value) { this.body = value; this.writableEnded = true; } };
      await route.handler(req, res);
      const value = JSON.parse(res.body);
      assert.equal(value.ok, true, JSON.stringify(value));
      return value.data;
    };
    const sessions = await request('GET', '/workspace-sessions');
    assert.equal(sessions.items[0].id, 'named-offline');
    assert.equal(sessions.items[0].title, '合成的历史主会话');
    assert.equal(sessions.items[0].status, 'inactive');
    await request('POST', '/graph/prepare', {});
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await request('GET', '/graph/status');
      if (status.state === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.state, 'ready');
    const result = await ctx.tools.execute({
      callId: 'graph-recall-output', name: 'tidal_recall', arguments: { query: 'violet protocol' },
      agent, signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.value);
    const graph = result.value.picked.find(item => item.id === related.id);
    assert.equal(graph.graphRelation.kind, 'confirmed');
    assert.equal(graph.graphRelation.seedId, seed.id);
    assert.equal(graph.semanticScore, null);
    assert.equal(graph.matched, false);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const embeddingMode of ['off', 'cpu']) {
  test(`real rc5 recall output is lossless JSON: ${embeddingMode === 'off' ? 'standard' : 'missing model fallback'}`, async () => {
    const [plugin, { Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
      import('../index.js'), hostModule('@deepseek-ai/cordis'),
      hostModule('@deepseek-ai/dsh-system-prompt'), hostModule('@deepseek-ai/dsh-tools'),
    ]);
    const root = mkdtempSync(join(tmpdir(), 'tidal-tool-output-'));
    const cwd = join(root, 'workspace'), ctx = new Context(), fibers = [];
    const session = { id: 'reader', header: { cwd }, snapshotEvents: () => [] };
    const agent = { id: session.id, session, status: 'idle' };
    try {
      const store = new MemorySpace(root, 'shared');
      let seed, resident, association;
      try {
        seed = store.create({ layer: 'L2', text: 'violet protocol', sessionId: 'writer', topics: ['orchid'] }, { admin: true });
        resident = store.create({ layer: 'L3', text: 'stable background' }, { admin: true });
        association = store.create({ layer: 'L2', text: 'second evidence', parents: [seed.id], topics: ['orchid'] }, { admin: true });
      } finally { store.close(); }
      ctx.provide('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] });
      ctx.provide('sessions', {});
      ctx.provide('webServer', { register: () => () => {} });
      ctx.provide('connection', { requestRejection: () => undefined });
      ctx.provide('settings', { describe: () => [] });
      for (const dependency of [SystemPrompt, ToolRuntime]) fibers.push(await ctx.plugin(dependency, {}));
      fibers.push(await ctx.plugin(plugin, {
        dataRoot: root, bindings: [{ cwd, space: 'shared' }], autoBackup: false, embeddingMode,
      }));
      assert.ok(fibers.every(fiber => fiber.state === 2));
      const result = await ctx.tools.execute({
        callId: 'recall-output', name: 'tidal_recall', arguments: { query: 'violet protocol' },
        agent, signal: new AbortController().signal,
      });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value);
      assert.deepEqual(JSON.parse(result.content[0].text), result.value);
      const picked = new Map(result.value.picked.map(item => [item.id, item]));
      assert.equal(picked.size, 3);
      assert.equal(picked.get(seed.id).channel, 'query');
      assert.equal(picked.get(seed.id).semanticScore, null);
      assert.ok(picked.get(seed.id).fusionScore > 0);
      assert.equal(picked.get(resident.id).channel, 'resident');
      assert.equal(picked.get(resident.id).semanticScore, null);
      assert.equal(picked.get(resident.id).fusionScore, 0);
      assert.equal(picked.get(association.id).channel, 'association');
      assert.equal(picked.get(association.id).semanticScore, null);
      assert.equal(picked.get(association.id).fusionScore, null);
      assert.equal(result.value.semanticStatus.state, embeddingMode === 'off' ? 'disabled' : 'degraded');
      if (embeddingMode !== 'off') assert.equal(result.value.semanticStatus.code, 'MODEL_NOT_INSTALLED');
      const card = result.value.topicCards.find(item => item.label === 'orchid');
      assert.equal(card.count, 2);
      const detail = await ctx.tools.execute({
        callId: 'topic-output', name: 'tidal_read_evidence', arguments: { topic: card.id, limit: 1 },
        agent, signal: new AbortController().signal,
      });
      assert.equal(detail.isError, false, JSON.stringify(detail));
      assert.deepEqual(JSON.parse(detail.content[0].text), detail.value);
      assert.equal(detail.value.total, 2);
      assert.ok(detail.value.nextCursor);
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('real rc5 Cordis lifecycle, volatile configuration, tools, context and private author', async () => {
  const plugin = await import('../index.js');
  const { Context } = await hostModule('@deepseek-ai/cordis');
  const { SystemPrompt } = await hostModule('@deepseek-ai/dsh-system-prompt');
  const root = mkdtempSync(join(tmpdir(), 'tidal-host-'));
  const cwd = join(root, 'workspace');
  const ctx = new Context();
  const tools = new Map(), routes = new Map(), agents = new Map();
  const session = { id: 'session-a', header: { cwd }, snapshotEvents: () => [],
    requestContext: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) };
  let requestHook;
  const agent = { id: session.id, session, status: 'idle',
    ctx: { on(name, callback) {
      assert.equal(name, 'agent/request');
      requestHook = callback;
      return () => { requestHook = null; };
    } } };
  agents.set(agent.id, agent);
  let fiber, promptFiber, writerFiber, writer;
  const raw = { dataRoot: root, bindings: [{ cwd, space: 'shared' }], autoBackup: false,
    privateWriters: ['fixture-author'], privateContributionsEnabled: true,
    privateMainSessions: [{ space: 'shared', sessionId: 'session-a',
      provider: 'fixture-provider', model: 'fixture-model' }] };
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const priorStore = new MemorySpace(root, 'shared', {
      config: { privateWriters: ['fixture-author'] }, clock: () => yesterday.getTime(),
    });
    priorStore.appendPrivate('fixture-author', 'PRIVATE_CONTEXT_CANARY');
    priorStore.close();
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
    assert.equal(configOf(fiber.config).dailyConsolidateAt, '03:00');
    assert.equal(configOf(fiber.config).workingHours, 24);
    assert.equal(configOf(fiber.config).privateContextBudget, 8000);
    assert.equal(routes.size, 1);
    assert.deepEqual([...tools.keys()].sort(), ['tidal_correct', 'tidal_private_contribute', 'tidal_private_journal_commit',
      'tidal_read_evidence', 'tidal_recall', 'tidal_remember', 'tidal_timeline']);
    const record = await tools.get('tidal_remember').execute({ text: '候选主题', layer: 'L3' }, { agent });
    assert.equal(record.status, 'active');
    const corrected = await tools.get('tidal_correct').execute({
      id: record.id, text: '工具修订主题', revision: record.revision,
    }, { agent });
    assert.equal(corrected.kind, 'inference');
    assert.equal(corrected.status, 'active');
    await assert.rejects(() => tools.get('tidal_remember').execute({ text: 'bad', layer: 'L9' }, { agent }));
    const memory = ctx.tidalMemory.forAgent(agent);
    assert.equal(ctx.tidalMemory.version, 3);
    const task = memory.proposeMemory({ layer: 'L1', text: 'synthetic worker task' });
    assert.equal(memory.setFocus({ taskRef: task.id }).task.id, task.id);
    const sceneInput = { title: 'Synthetic shared scene', operationId: randomUUID() };
    const scene = memory.createScene(sceneInput);
    assert.equal(memory.createScene(sceneInput).id, scene.id);
    const secondSession = { id: 'session-b', header: { cwd }, snapshotEvents: () => [],
      requestContext: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) };
    const secondAgent = { id: secondSession.id, session: secondSession, status: 'idle' };
    agents.set(secondAgent.id, secondAgent);
    const secondMemory = ctx.tidalMemory.forAgent(secondAgent);
    assert.equal(secondMemory.joinScene(scene.id).memberCount, 2);
    secondMemory.setFocus({ sceneRef: scene.id });
    const sceneEvent = secondMemory.recordEvent({ text: 'synthetic cross-session scene result', eventType: 'result',
      operationId: randomUUID(), sceneRef: scene.id });
    memory.setFocus({ taskRef: task.id, sceneRef: scene.id });
    assert.ok(memory.scenes().some(item => item.id === scene.id));
    assert.ok(memory.recall('unrelated query').picked.some(item =>
      item.id === sceneEvent.id && item.channel === 'association'));
    const eventInput = { text: 'synthetic worker result', eventType: 'result',
      operationId: randomUUID(), taskRef: task.id, sceneRef: scene.id };
    const event = memory.recordEvent(eventInput);
    assert.equal(event.layer, 'L2');
    assert.equal(event.kind, 'observation');
    assert.ok(event.parents.includes(task.id));
    assert.equal(memory.recordEvent(eventInput).id, event.id);
    assert.throws(() => memory.recordEvent({ ...eventInput, text: 'different result' }),
      error => error.code === 'OPERATION_CONFLICT');
    let page = memory.changes(null, 1);
    const changes = [...page.items];
    while (page.hasMore) {
      page = memory.changes(page.cursor, 1);
      changes.push(...page.items);
    }
    assert.ok(changes.some(item => item.id === event.id && item.layer === 'L2'));
    assert.equal(memory.changes(page.cursor, 20).hasMore, false);
    assert.equal(memory.focus().taskRef, task.id);
    assert.equal(memory.setFocus({}).taskRef, null);
    const text = '记住：以后合成模板 {{must_stay_literal}} 是长期测试知识。';
    ctx.emit('session/event', session, { type: 'user/message', seq: 1, time: Date.now(),
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } });
    const privateAssembly = await ctx.systemPrompt.assemble({ agent });
    const privateContext = privateAssembly.contexts.find(value => value.name === 'tidal-private-journal');
    assert.match(privateContext.text, /PRIVATE_CONTEXT_CANARY/);
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
    const firstPrivate = writer.append('shared', 'PRIVATE_HOST_CANARY');
    const secondPrivate = writer.append('shared', 'PRIVATE_HOST_SECOND_CANARY');
    assert.equal(firstPrivate.saved, true);
    assert.notEqual(secondPrivate.id, firstPrivate.id);
    assert.equal(secondPrivate.revision, 1);
    const contribution = ctx.tidalMemory.forAgent(agent).contributePrivate({ content: 'SESSION_CONTRIBUTION_CANARY' });
    assert.equal(contribution.saved, true);
    assert.match(contribution.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(JSON.stringify(contribution).includes('SESSION_CONTRIBUTION_CANARY'), false);
    const contributionDb = openDatabase(join(root, 'spaces', 'shared', 'system', 'private', 'journal.sqlite3'));
    assert.equal(contributionDb.prepare('SELECT source_session FROM entries WHERE id=?')
      .get(contribution.id).source_session, 'session-a');
    contributionDb.close();
    await assert.rejects(() => requestHook({ turn: 1, step: 1 },
      async () => ({ provider: 'unapproved-provider', model: 'unapproved-model' })),
    { code: 'PRIVATE_ROUTE_UNAUTHORIZED' });
    assert.deepEqual(await requestHook({ turn: 1, step: 1 },
      async () => ({ provider: 'fixture-provider', model: 'fixture-model' })),
    { provider: 'fixture-provider', model: 'fixture-model' });
    const beforeReply = openDatabase(join(root, 'spaces', 'shared', 'system', 'private', 'journal.sqlite3'));
    assert.equal(beforeReply.prepare('SELECT count(*) AS n FROM journal_observations').get().n, 0);
    beforeReply.close();
    ctx.emit('session/event', session, { type: 'assistant/message', time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic response' }] },
        stream: [] } });
    const afterReply = openDatabase(join(root, 'spaces', 'shared', 'system', 'private', 'journal.sqlite3'));
    assert.equal(afterReply.prepare('SELECT count(*) AS n FROM journal_observations').get().n, 1);
    afterReply.close();
    const childSession = { id: 'private-fork', header: { cwd, parentSession: 'session-a' }, snapshotEvents: () => [] };
    const childAgent = { id: childSession.id, session: childSession, status: 'idle' };
    agents.set(childAgent.id, childAgent);
    const decision = await ctx.events.waterfall(ctx, 'agent/pre-step', {
      agent: childAgent, signal: new AbortController().signal,
    }, () => ({ kind: 'enter', messages: [] }));
    assert.equal(decision.kind, 'reject');
    const privacyCheck = openDatabase(join(root, 'system', 'private-sessions.sqlite3'));
    assert.equal(privacyCheck.prepare('SELECT state FROM private_sessions WHERE session_id=?')
      .get(childAgent.id).state, 'inherited');
    privacyCheck.close();
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
