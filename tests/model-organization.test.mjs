import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime } from '../src/runtime.js';
import { organizeMemoryBatch } from '../src/model-consolidation.js';

const admin = { admin: true };

function installLlmStub(t, root) {
  const packageRoot = join(root, '@deepseek-ai', 'dsh-llm');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm', type: 'module', exports: { '.': './index.js' },
  }));
  writeFileSync(join(packageRoot, 'index.js'), `
    export class BlockAssembler {
      constructor() { this.value = ''; this.finish = { kind: 'complete' }; }
      push(chunk) { this.value += chunk; }
      blocks() { return [{ type: 'text', text: this.value }]; }
    }
  `);
  const previous = process.env.TIDAL_HOST_MODULES;
  process.env.TIDAL_HOST_MODULES = root;
  t.after(() => {
    if (previous === undefined) delete process.env.TIDAL_HOST_MODULES;
    else process.env.TIDAL_HOST_MODULES = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function fixture(t, options = {}, runtimeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-model-organization-'));
  const cwd = join(root, 'workspace');
  const agent = { id: 'main-session', status: 'idle', session: {
    id: 'main-session', header: { id: 'main-session', cwd, origin: 'primary' },
    requestContext: () => ({ provider: 'synthetic', model: 'test-model' }),
    snapshotEvents: () => [],
  } };
  const modelCalls = [];
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, list: () => [agent] },
    settings: { describe: () => [] },
    logger: { warn() {} },
    llm: { stream: async function* (request) {
      modelCalls.push(request);
      if (request.purpose === 'test-output') return;
      assert.equal(request.messages[0].content.length, 1);
      assert.equal(request.messages[0].content[0].type, 'text');
      const input = JSON.parse(request.messages[0].content[0].text);
      const output = request.system.includes('私人日记')
        ? '## 今日记录\n\n完成了重要工作。'
        : JSON.stringify({ memories: [{ text: '用户偏好简洁回答。', category: 'preference',
          sourceIds: [input.records[0].id] }] });
      yield output;
    } },
    sessionQuery: {
      listSessions: async () => [{ header: agent.session.header }],
      readSession: async () => ({ session: agent.session.header, events: [] }),
    },
  };
  const config = {
    dataRoot: root,
    bindings: [{ cwd, space: 'shared' }],
    deepOrganizationMode: 'session',
    deepOrganizationSessions: [{ space: 'shared', sessionId: agent.id,
      provider: 'synthetic', model: 'test-model' }],
    privateMainSessions: [{ space: 'shared', sessionId: agent.id,
      provider: 'synthetic', model: 'test-model' }],
    privateWriters: ['test-author'],
    ...options,
  };
  const runtime = new TidalRuntime(ctx, config, root, runtimeOptions);
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, agent, ctx, runtime, modelCalls };
}

test('model deep sleep keeps source-checked output in review instead of asserting an unsupported fact', async t => {
  const host = mkdtempSync(join(tmpdir(), 'tidal-llm-stub-'));
  installLlmStub(t, host);
  const { runtime, ctx, modelCalls } = fixture(t);
  const store = runtime.space('shared');
  const l1 = store.create({ layer: 'L1', text: '用户喜欢简洁回答。', category: 'preference' }, admin);
  const l2 = store.create({ layer: 'L2', text: '本周完成了文档整理。', category: 'event' }, admin);
  store.create({ layer: 'L0', text: 'BUFFER_ONLY_CANARY', status: 'pending' }, admin);
  store.appendPrivate('test-author', 'PRIVATE_DIARY_CANARY');
  const result = await runtime.runModelDeepSleep(store);
  assert.equal(result.state, 'completed');
  assert.equal(result.inspected, 2);
  assert.equal(result.saved, 0);
  assert.equal(result.pendingEvidence, 1);
  assert.equal(modelCalls.length, 1);
  const input = modelCalls[0].messages[0].content[0].text;
  assert.equal(input.includes('BUFFER_ONLY_CANARY'), false);
  assert.equal(input.includes('PRIVATE_DIARY_CANARY'), false);
  assert.equal(input.includes(l1.id), true);
  assert.equal(input.includes(l2.id), true);
  assert.deepEqual(new Set(JSON.parse(input).records.map(record => record.layer)), new Set(['L1', 'L2']));
  const generated = store.all().find(record => record.layer === 'L3');
  assert.equal(generated.text, '用户偏好简洁回答。');
  assert.equal(generated.kind, 'inference');
  assert.equal(generated.status, 'review');
  assert.deepEqual(generated.parents, [l1.id]);
  assert.equal(store.recall('用户偏好简洁回答', { sessionId: 'other' }).picked.some(record => record.id === generated.id), false);
});

test('a model restatement never merges provenance into an existing active memory', async t => {
  const host = mkdtempSync(join(tmpdir(), 'tidal-llm-stub-'));
  installLlmStub(t, host);
  const { runtime } = fixture(t);
  const store = runtime.space('shared');
  store.create({ layer: 'L1', text: '不相关的来源。', category: 'task' }, admin);
  const existing = store.create({ layer: 'L3', text: '用户偏好简洁回答。', category: 'preference' }, admin);
  const result = await runtime.runModelDeepSleep(store);
  const after = store.raw(existing.id);
  assert.equal(result.duplicates, 1);
  assert.equal(result.pendingEvidence, 0);
  assert.equal(after.status, 'active');
  assert.equal(after.revision, existing.revision);
  assert.deepEqual(after.sources, existing.sources);
});

test('API organizer uses the configured endpoint and rejects model sources outside the input batch', async () => {
  const previous = globalThis.fetch;
  const key = Buffer.from('synthetic-api-secret');
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content:
      JSON.stringify({ memories: [{ text: '可长期记忆', category: 'knowledge', sourceIds: ['source-1'] }] }) } }] }) };
  };
  try {
    const result = await organizeMemoryBatch({}, {
      mode: 'api', endpoint: 'https://memory.example/v1/chat/completions',
      model: 'test-model', apiKey: key,
      records: [{ id: 'source-1', layer: 'L2', category: 'knowledge', text: '来源内容' }],
    });
    assert.equal(result[0].text, '可长期记忆');
    assert.equal(request.url, 'https://memory.example/v1/chat/completions');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.authorization, 'Bearer synthetic-api-secret');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[1].content.includes('来源内容'), true);

    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content:
        '{"memories":[{"text":"伪造来源","category":"knowledge","sourceIds":["not-in-batch"]}]}' } }] }),
    });
    await assert.rejects(organizeMemoryBatch({}, {
      mode: 'api', endpoint: 'https://memory.example/v1/chat/completions',
      model: 'test-model', apiKey: key,
      records: [{ id: 'source-1', layer: 'L2', category: 'knowledge', text: '来源内容' }],
    }), { code: 'MODEL_OUTPUT_INVALID' });
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
    key.fill(0);
  }
});

test('daily private summary reads only the bound workspace and saves date-named Markdown privately', async t => {
  const host = mkdtempSync(join(tmpdir(), 'tidal-llm-stub-'));
  installLlmStub(t, host);
  const { runtime, ctx, cwd, modelCalls } = fixture(t, { privateAutoJournalEnabled: true });
  const otherCwd = join(runtime.root, 'outside');
  const mainHeader = ctx.agents.get('main-session').session.header;
  const workspaceHeader = { id: 'workspace-session', cwd, origin: 'primary' };
  const outsideHeader = { id: 'outside-session', cwd: otherCwd, origin: 'primary' };
  const loaded = [];
  const day = '2026-03-03';
  const targetTime = new Date(2026, 2, 3, 12).toISOString();
  ctx.sessionQuery = {
    listSessions: async () => [mainHeader, workspaceHeader, outsideHeader].map(header => ({ header })),
    readSession: async id => {
      loaded.push(id);
      if (id === 'outside-session') throw new Error('must not read other workspaces');
      return { session: id === 'workspace-session' ? workspaceHeader : mainHeader,
        events: id === 'workspace-session' ? [
        { type: 'user/message', time: targetTime, seq: 1,
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'JOURNAL_SOURCE_CANARY' }] } },
        { type: 'assistant/message', time: targetTime, seq: 2,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手回应' }] } } },
        { type: 'user/message', time: new Date(2026, 2, 2, 12).toISOString(), seq: 3,
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'OTHER_DAY_CANARY' }] } },
      ] : [] };
    },
  };
  const store = runtime.space('shared');
  const result = await runtime.api('POST', '/private/daily-summary',
    new URLSearchParams({ space: 'shared' }), { day });
  assert.equal(result.state, 'completed');
  assert.equal(result.messageCount, 2);
  assert.deepEqual(loaded, ['main-session', 'workspace-session']);
  const content = readFileSync(join(store.privateDirectory, `${day}.md`), 'utf8');
  assert.equal(content.includes('完成了重要工作。'), true);
  assert.equal(content.includes('JOURNAL_SOURCE_CANARY'), false);
  assert.equal(content.includes('OTHER_DAY_CANARY'), false);
  assert.equal(store.privateStatus().automaticSummary.state, 'completed');
  assert.equal(JSON.stringify(store.privateStatus()).includes('完成了重要工作。'), false);
  assert.equal(JSON.stringify(await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' })))
    .includes('JOURNAL_SOURCE_CANARY'), false);
  assert.equal(modelCalls.length, 1);
  const repeated = await runtime.api('POST', '/private/daily-summary',
    new URLSearchParams({ space: 'shared' }), { day });
  assert.equal(repeated.alreadyRun, true);
  assert.equal(store.privateDb.prepare("SELECT count(*) AS count FROM entries WHERE author='tidal-auto'").get().count, 1);
});

test('daily summary rejects a changed history workspace without sending or writing messages', async t => {
  const { runtime, ctx, modelCalls } = fixture(t, { privateAutoJournalEnabled: true });
  const header = ctx.agents.get('main-session').session.header;
  ctx.sessionQuery.readSession = async () => ({
    session: { ...header, cwd: join(runtime.root, 'outside') },
    events: [{ type: 'user/message', time: new Date(2026, 2, 3, 12).toISOString(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_CANARY' }] } }],
  });
  await assert.rejects(runtime.api('POST', '/private/daily-summary',
    new URLSearchParams({ space: 'shared' }), { day: '2026-03-03' }), {
    code: 'WORKSPACE_SESSIONS_CHANGED',
    message: '会话历史所属工作区已变化；未写入私人日记。',
  });
  assert.equal(modelCalls.length, 0);
  assert.equal(runtime.space('shared').privateStatus().automaticSummary.state, 'failed');
  assert.equal(runtime.space('shared').privateDb.prepare(
    "SELECT count(*) AS count FROM entries WHERE author='tidal-auto'").get().count, 0);
});

test('idle daily consolidation catches up the prior day private journal without mixing workspaces', async t => {
  const host = mkdtempSync(join(tmpdir(), 'tidal-llm-stub-'));
  installLlmStub(t, host);
  const now = new Date(2026, 2, 4, 4);
  const { runtime, ctx, cwd, modelCalls } = fixture(t, {
    privateAutoJournalEnabled: true,
    dailyConsolidateAt: '03:00',
  }, { clock: () => now });
  runtime.lastActivity = now.getTime() - 21 * 60_000;
  const headers = [ctx.agents.get('main-session').session.header,
    { id: 'workspace-session', cwd, origin: 'primary' },
    { id: 'outside-session', cwd: join(runtime.root, 'outside'), origin: 'primary' }];
  const loaded = [];
  ctx.sessionQuery = {
    listSessions: async () => headers.map(header => ({ header })),
    readSession: async id => {
      loaded.push(id);
      return { session: headers.find(header => header.id === id),
        events: id === 'workspace-session' ? [{
        type: 'user/message', time: new Date(2026, 2, 3, 10).toISOString(), seq: 1,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'SCHEDULED_DIARY_CANARY' }] },
      }] : [] };
    },
  };
  const result = await runtime.checkDailyConsolidation(now);
  assert.equal(result.results[0].day, '2026-03-04');
  assert.equal(result.results[0].privateDailySummary.state, 'completed');
  assert.equal(result.results[0].modelOrganization.state, 'completed');
  assert.deepEqual(loaded, ['main-session', 'workspace-session']);
  const store = runtime.space('shared');
  assert.equal(store.privateDb.prepare("SELECT count(*) AS count FROM entries WHERE day_key='2026-03-03'").get().count, 1);
  assert.equal(store.dailyConsolidationStatus().day, '2026-03-04');
  assert.equal(modelCalls.length, 1);
});
