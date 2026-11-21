import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { TidalRuntime, recallQuery } from '../src/runtime.js';
import { MAX_RECALL_QUERY_LENGTH, MemoryError } from '../src/model.js';
import { MemorySpace } from '../src/store.js';
import { prepareWorkspace, verifiedLocalDirectory } from '../src/workspace-storage.js';
import { automaticBackup, packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

function fixture(t, overrides = {}, runtimeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-runtime-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoExtract: true, autoBackup: false,
    bindings: [{ cwd, space: 'shared' }], ...overrides };
  const agent = { id: 'new-session', status: 'idle', session: {
    id: 'new-session', header: { cwd }, requestHeader: () => ({ config: { provider: 'synthetic', model: 'test' } }),
    requestContext: () => ({ provider: 'synthetic', model: 'test' }), snapshotEvents: () => [],
  } };
  let modelCalls = 0;
  const agents = [agent], ctx = {
    agents: { get: id => agents.find(a => a.id === id), list: () => agents },
    settings: { describe: () => [] }, logger: { warn() {} },
    llm: { stream: () => { modelCalls++; throw new Error('Memory must not call an LLM'); } },
  };
  const runtime = new TidalRuntime(ctx, config, root, runtimeOptions);
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, ctx, agent, agents, config, root, cwd, modelCalls: () => modelCalls };
}

test('status version matches the installed package manifest', async t => {
  const { runtime } = fixture(t);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
  assert.equal(status.version, manifest.version);
});

test('registered workspaces bind without sessions; rename and unbind never migrate data or transfer grants', async t => {
  const f = fixture(t);
  let revision = 0;
  f.ctx.settings = { describe: () => [{ ns: 'tidal-memory', revision }], update: async (_ns, patch, rev) => {
    assert.equal(rev, revision++); Object.assign(f.config, patch);
  } };
  const projects = mkdtempSync(join(tmpdir(), 'tidal-projects-'));
  t.after(() => rmSync(projects, { recursive: true, force: true }));
  const a = { id: 'one', path: join(projects, 'a'), title: '课程', sessionIds: ['DO_NOT_RETURN'] };
  const b = { id: 'two', path: join(projects, 'b'), title: '课程' };
  const rows = [a, b];
  for (const row of rows) mkdirSync(row.path);
  const change = (space, args) => f.runtime.api('POST', '/workspace-binding', new URLSearchParams({ space }), { revision, ...args });
  await assert.rejects(f.runtime.api('GET', '/workspaces', new URLSearchParams()), { code: 'WORKSPACE_DIRECTORY_UNAVAILABLE' });
  f.ctx.workspaceRegistry = { list: () => rows, get: id => rows.find(item => item.id === id) };
  const catalog = (await f.runtime.api('GET', '/workspaces', new URLSearchParams())).items;
  assert.ok(catalog.every(row => !row.error && !row.bound && !('sessionIds' in row)));
  assert.deepEqual(catalog.map(({ id, title, cwd }) => ({ id, title, cwd })),
    rows.map(({ id, title, path: cwd }) => ({ id, title, cwd })));
  await assert.rejects(change('shared', { action: 'bind', workspaceId: a.id, cwd: b.path }), { code: 'WORKSPACE_CHANGED' });
  const { space } = await change('shared', { action: 'bind', workspaceId: a.id, cwd: a.path });
  assert.equal((await change('shared', { action: 'bind', workspaceId: a.id, cwd: a.path })).space, space);
  assert.notEqual((await change('shared', { action: 'bind', workspaceId: b.id, cwd: b.path })).space, space);
  const stored = f.runtime.space(space);
  const record = stored.create({ layer: 'L2', text: 'synthetic identity marker' }, { admin: true });
  f.config.historyMainSessions = [{ space, sessionId: 'offline', provider: 'p', model: 'm' }];
  await change(space, { action: 'rename', displayName: '中文名字' });
  assert.equal(f.runtime.config.bindings.find(item => item.space === space).displayName, '中文名字');
  assert.deepEqual(f.runtime.config.historyMainSessions, f.config.historyMainSessions);
  assert.equal(stored.get(record.id, { admin: true }).text, 'synthetic identity marker');
  await assert.rejects(change(space, { action: 'rename', displayName: '未保存', revision: revision - 1 }), { code: 'REVISION_CONFLICT' });
  a.id = 'replacement';
  assert.equal(f.runtime.bindingAt(a.path), undefined);
  await assert.rejects(change('shared', { action: 'bind', workspaceId: a.id, cwd: a.path }), { code: 'WORKSPACE_CHANGED' });
  await change(space, { action: 'unbind' });
  assert.deepEqual(f.config.historyMainSessions, []);
  a.id = 'one';
  assert.equal((await change('shared', { action: 'bind', workspaceId: a.id, cwd: a.path })).space, space);
  assert.equal(stored.directory, join(a.path, '.tidal-memory'));
  assert.equal(existsSync(join(f.root, 'spaces', space)), false);
  assert.equal(stored.get(record.id, { admin: true }).text, 'synthetic identity marker');
});

test('offline workspace migration preserves records, journal and ledger; busy or foreign folders are never overwritten', t => {
  const base = mkdtempSync(join(tmpdir(), 'tidal-cold-location-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'global'), cwd = join(base, 'project'), target = join(cwd, '.tidal-memory');
  mkdirSync(cwd);
  const row = { id: 'stable-project', cwd }, name = 'existing', admin = { admin: true };
  const old = new MemorySpace(root, name, { config: { privateWriters: ['synthetic'] } });
  const survivor = old.create({ layer: 'L2', text: 'synthetic migration canary' }, admin);
  const gone = old.create({ layer: 'L2', text: 'synthetic tombstone' }, admin);
  old.forget(gone.id, admin); old.appendPrivate('synthetic', 'fixture journal');
  const lineage = old.lineageId;
  try {
    assert.throws(() => prepareWorkspace(root, row, name), { code: 'WORKSPACE_MIGRATION_REQUIRED' });
    assert.throws(() => prepareWorkspace(root, row, name, { migrate: true }), { code: 'SPACE_BUSY' });
  } finally { old.close(); }
  mkdirSync(target); writeFileSync(join(target, 'not-ours'), 'leave intact');
  assert.throws(() => prepareWorkspace(root, row, name, { migrate: true }), { code: 'WORKSPACE_FOLDER_CONFLICT' });
  assert.equal(readFileSync(join(target, 'not-ours'), 'utf8'), 'leave intact');
  rmSync(target, { recursive: true });
  assert.equal(prepareWorkspace(root, row, name, { migrate: true }), target);
  assert.equal(existsSync(join(root, 'spaces', name)), false);
  assert.equal(prepareWorkspace(root, row, name), target);
  assert.throws(() => verifiedLocalDirectory(root, { ...row, id: 'replacement' }, name), { code: 'WORKSPACE_CHANGED' });
  const migrated = new MemorySpace(root, name, { directory: target });
  try {
    assert.equal(migrated.lineageId, lineage);
    assert.equal(migrated.get(survivor.id, admin).text, survivor.text);
    assert.equal(migrated.privateStatus().count, 1);
    assert.throws(() => migrated.get(gone.id, admin), { code: 'NOT_FOUND' });
    assert.ok(existsSync(join(target, 'L2-episodes', 'episodes.sqlite3')));
  } finally { migrated.close(); }
});

test('picker searches cold headers without reading logs and validates the exact route when saving one purpose', async t => {
  const f = fixture(t);
  const q = new URLSearchParams({ space: 'shared', view: 'picker' });
  let revision = 0, model = 'first';
  f.ctx.settings = { describe: () => [{ ns: 'tidal-memory', revision }], update: async (_ns, patch, rev) => {
    assert.equal(rev, revision++); Object.assign(f.config, patch);
  } };
  f.ctx.sessionQuery = {
    listSessions: async () => Array.from({ length: 48 }, (_, i) => ({ header: { id: `s-${i}`, cwd: f.cwd,
      ...(i === 1 ? { parentSession: 's-0' } : {}) } })),
    readTitleSnapshots: () => assert.fail('picker must not fold a cold log'),
    readSession: () => assert.fail('picker must not load events'),
  };
  f.ctx.sessionProjectionCache = { cachedSnapshot: () => ({ values: { modelSelection: { next: { provider: 'p', model } } } }) };
  const items = (await f.runtime.api('GET', '/workspace-sessions', q)).items;
  assert.equal(items.length, 48);
  assert.equal(items.find(x => x.id === 's-1').child, true);
  const save = (id, picked, setting = 'historyMainSessions') => f.runtime.api('POST', '/workspace-selection', q,
    { revision, setting, selection: { sessionId: id, provider: 'p', model: picked } });
  await assert.rejects(save('s-1', model, 'privateMainSessions'), { code: 'SESSION_UNAVAILABLE' });
  await assert.rejects(save('other', model), { code: 'SESSION_UNAVAILABLE' });
  model = 'second';
  await assert.rejects(save('s-47', 'first'), { code: 'SESSION_MODEL_CHANGED' });
  await save('s-47', 'second');
  assert.equal(f.config.historyMainSessions[0].sessionId, 's-47');
  assert.deepEqual(f.runtime.config.privateMainSessions, []);
  assert.equal(f.runtime.config.historyReadEnabled, false);
  f.runtime.privateSessionRegistry().markInherited({ sessionId: 's-0', space: 'shared',
    lineageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now: new Date().toISOString() });
  assert.equal((await f.runtime.api('GET', '/workspace-sessions', q)).items.some(x => ['s-0', 's-1'].includes(x.id)), false);
  f.config.bindings = [{ cwd: f.cwd, space: 'shared', workspaceId: 'live-id' }];
  f.ctx.workspaceRegistry = { get: id => ({ id, path: f.cwd, sessionIds: ['s-47'] }) };
  assert.deepEqual((await f.runtime.api('GET', '/workspace-sessions', q)).items.map(item => item.id), ['s-47']);
});

test('workspace session catalog includes named inactive sessions and excludes other workspaces before reading titles', async t => {
  const f = fixture(t);
  const headers = [
    { id: f.agent.id, cwd: f.cwd, createdAt: 3 },
    { id: 'saved-main', cwd: f.cwd, createdAt: 2 },
    { id: 'private-title-session', cwd: f.cwd, createdAt: 1.5 },
    { id: 'private-inherited-child', cwd: f.cwd, createdAt: 1.4, parentSession: 'private-title-session' },
    { id: 'foreign', cwd: join(f.root, 'other'), createdAt: 1 },
    { id: 'child-directory', cwd: join(f.cwd, 'child'), createdAt: 0 },
  ];
  f.ctx.sessions = { get: id => id === f.agent.id ? f.agent.session : undefined };
  f.ctx.sessionProjections = { cachedSnapshot: () => ({ values: { title: '日常主会话' } }) };
  f.ctx.sessionProjectionCache = { cachedSnapshot: () => ({ values: {
    modelSelection: { next: { provider: 'saved-provider', model: 'saved-model' } },
  } }) };
  f.agent.session.snapshotEvents = () => { throw new Error('Do not read messages for session selection'); };
  const requested = [];
  f.runtime.privateSessionRegistry().markInherited({ sessionId: 'private-title-session',
    space: 'shared', lineageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now: new Date().toISOString() });
  f.ctx.sessionQuery = {
    listSessions: async () => headers.map(header => ({ header })),
    readTitleSnapshots: async ids => {
      requested.push(...ids);
      return ids.map(id => ({ status: 'fulfilled', value: {
        session: headers.find(header => header.id === id), title: { title: '日常主会话', privateBody: 'DO_NOT_RETURN' },
      } }));
    },
  };
  const configBefore = JSON.stringify(f.runtime.config);
  const data = await f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'shared' }));
  assert.deepEqual(data.items.map(item => item.id), [f.agent.id, 'saved-main']);
  assert.deepEqual(data.items.map(item => item.title), ['日常主会话', '日常主会话']);
  assert.deepEqual(requested, ['saved-main']);
  assert.equal(requested.includes('private-title-session'), false);
  assert.equal(requested.includes('private-inherited-child'), false);
  assert.equal(data.items[1].status, 'inactive');
  assert.equal(data.items[1].provider, 'saved-provider');
  assert.equal(data.items[1].model, 'saved-model');
  assert.equal(data.total, 2);
  assert.equal(data.nextOffset, null);
  assert.equal(JSON.stringify(data).includes('DO_NOT_RETURN'), false);
  assert.equal(JSON.stringify(f.runtime.config), configBefore);
  assert.equal(existsSync(join(f.root, 'spaces')), false);
});

test('authorized history lookup searches only selected workspace sessions and returns a bounded temporary window', async t => {
  const f = fixture(t, { historyReadEnabled: true, historyMainSessions: [{
    space: 'shared', sessionId: 'new-session', provider: 'synthetic', model: 'test',
  }] });
  const targetId = 'saved-history';
  const headers = [
    { id: f.agent.id, cwd: f.cwd },
    { id: targetId, cwd: f.cwd },
    { id: 'foreign-history', cwd: join(f.root, 'other') },
  ];
  const at = new Date().toISOString();
  const targetEvents = [
    { type: 'user/message', seq: 1, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '准备导出报告。' }] } },
    { type: 'assistant/message', seq: 2, time: at, data: { message: { role: 'assistant',
      content: [{ type: 'text', text: '计划先检查生成步骤。' }] } } },
    { type: 'user/message', seq: 3, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '记住：报告导出目录是 D:\\reports。' }] } },
    { type: 'assistant/message', seq: 4, time: at, data: { message: { role: 'assistant',
      content: [{ type: 'text', text: '导出目录记为 D:\\reports。' }] } } },
    { type: 'user/message', seq: 5, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '确认以后从这里读取。' }] } },
  ];
  const read = [];
  f.ctx.sessionQuery = {
    listSessions: async () => headers.map(header => ({ header })),
    readSession: async id => {
      read.push(id);
      return { session: { id, cwd: id === 'foreign-history' ? join(f.root, 'other') : f.cwd },
        events: targetEvents };
    },
  };
  const record = f.runtime.space('shared').create({ layer: 'L3', text: 'existing only' }, { admin: true });
  const result = await f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: [targetId], query: '报告导出目录',
  });
  assert.equal(result.space, 'shared');
  assert.equal(result.sessionsChecked, 1);
  assert.equal(result.windows.length, 2);
  assert.ok(result.bytes <= 6 * 1024);
  assert.match(JSON.stringify(result.windows), /D:\\\\reports/);
  assert.equal(f.runtime.space('shared').all().length, 1);
  assert.equal(f.runtime.space('shared').all()[0].id, record.id);
  assert.deepEqual(read, [targetId]);
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: ['foreign-history'], query: '报告',
  }), { code: 'HISTORY_SESSION_OUT_OF_SCOPE' });
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: [targetId, 'saved-history-2', 'saved-history-3', 'saved-history-4'], query: '报告',
  }), { code: 'INVALID_HISTORY_SCOPE' });
});

test('history lookup rejects unauthorized routes, private sessions, and unanchored legacy forget coverage', async t => {
  const f = fixture(t, { historyReadEnabled: true, historyMainSessions: [] });
  const targetId = 'saved-history';
  f.config.historyMainSessions.push({ space: 'shared', sessionId: f.agent.id,
    provider: 'synthetic', model: 'test' });
  let reads = 0;
  const at = new Date().toISOString();
  const privateEvent = { type: 'user/message', seq: 1, time: at, data: {
    role: 'user', source: { kind: 'runtime-context', sections: [{ name: 'tidal-private-journal' }] },
    content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_HISTORY_CANARY' }],
  } };
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd } }],
    readSession: async id => {
      reads++;
      return { session: { id, cwd: f.cwd }, events: id === targetId ? [privateEvent] : [] };
    },
  };
  f.agent.session.requestContext = () => ({ provider: 'other-provider', model: 'other-model' });
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, { sessionIds: [targetId], query: 'private' }),
    { code: 'HISTORY_ROUTE_UNAUTHORIZED' });
  assert.equal(reads, 0);
  f.agent.session.requestContext = () => ({ provider: 'synthetic', model: 'test' });
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, { sessionIds: [targetId], query: 'private' }),
    { code: 'PRIVATE_HISTORY_EXCLUDED' });
  assert.equal(JSON.stringify(f.runtime.lastError).includes('SYNTHETIC_PRIVATE_HISTORY_CANARY'), false);
  assert.equal(f.runtime.privateSessionRegistry().get(targetId).state, 'inherited');

  const cleanId = 'clean-history';
  f.ctx.sessionQuery.listSessions = async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
    { header: { id: cleanId, cwd: f.cwd } }];
  f.ctx.sessionQuery.readSession = async id => {
    reads++;
    return { session: { id, cwd: f.cwd }, events: [{ type: 'user/message', seq: 2, time: at, data: {
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary history' }],
    } }] };
  };
  f.runtime.space('shared').forgetLedger.add(f.runtime.space('shared').lineageId,
    [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', dedupe_key: 'b'.repeat(64) }], []);
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, { sessionIds: [cleanId], query: 'ordinary' }),
    { code: 'FORGET_SOURCE_COVERAGE_UNKNOWN' });
});

test('history lookup returns matching context without crossing sensitive events and respects global bounds', async t => {
  const f = fixture(t, { historyReadEnabled: true, historyMainSessions: [{
    space: 'shared', sessionId: 'new-session', provider: 'synthetic', model: 'test',
  }] });
  const selected = ['history-a', 'history-b', 'history-c'];
  const headers = [{ id: f.agent.id, cwd: f.cwd }, ...selected.map(id => ({ id, cwd: f.cwd }))];
  const at = new Date().toISOString();
  const message = (seq, role, text) => ({
    type: role === 'user' ? 'user/message' : 'assistant/message', seq, time: at,
    data: role === 'user' ? { role, source: { kind: 'user' }, content: [{ type: 'text', text }] } :
      { message: { role, content: [{ type: 'text', text }] } },
  });
  const events = [
    message(1, 'user', `前置上下文 ${'a'.repeat(900)}`),
    message(2, 'assistant', `needle 命中一 ${'b'.repeat(900)}`),
    message(3, 'user', `后续上下文 ${'c'.repeat(900)}`),
    message(4, 'user', 'password: synthetic-secret-value'),
    message(5, 'user', `另一段上下文 ${'d'.repeat(900)}`),
    message(6, 'assistant', `needle 命中二 ${'e'.repeat(900)}`),
    message(7, 'user', `末尾上下文 ${'f'.repeat(900)}`),
  ];
  const read = [];
  f.ctx.sessionQuery = {
    listSessions: async () => headers.map(header => ({ header })),
    readSession: async id => {
      read.push(id);
      return { session: { id, cwd: f.cwd }, events: id === selected[0] ? events : [] };
    },
  };
  const result = await f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: selected, query: 'needle',
  });
  assert.equal(result.windows.length, 2);
  assert.ok(result.bytes <= 6 * 1024);
  assert.equal(result.sessionsChecked, 1);
  assert.deepEqual(read, [selected[0]]);
  assert.equal(result.ignoredSensitive, 1);
  assert.deepEqual(result.windows.map(window => window.events.some(event => event.text.includes('needle'))),
    [true, true]);
  assert.equal(JSON.stringify(result.windows).includes('synthetic-secret-value'), false);
  assert.ok(result.windows[0].untilSeq < 4);
  assert.ok(result.windows[1].fromSeq > 4);
});

test('history lookup discards a snapshot when authorization changes during the read', async t => {
  const f = fixture(t, { historyReadEnabled: true, historyMainSessions: [{
    space: 'shared', sessionId: 'new-session', provider: 'synthetic', model: 'test',
  }] });
  const targetId = 'history-target';
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd } }],
    readSession: async id => {
      f.config.historyReadEnabled = false;
      return { session: { id, cwd: f.cwd }, events: [{
        type: 'user/message', seq: 1, time: new Date().toISOString(), data: {
          role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'HISTORY_CANARY' }],
        },
      }] };
    },
  };
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: [targetId], query: 'HISTORY_CANARY',
  }), { code: 'HISTORY_AUTHORIZATION_CHANGED' });
});

test('history lookup discards earlier windows when a source is forgotten during a later snapshot read', async t => {
  const f = fixture(t, { historyReadEnabled: true, historyMainSessions: [{
    space: 'shared', sessionId: 'new-session', provider: 'synthetic', model: 'test',
  }] });
  const sessionIds = ['first-history', 'later-history'];
  const store = f.runtime.space('shared');
  const time = new Date().toISOString();
  const text = '导出目录曾是 D:\\reports。';
  const record = store.create({ layer: 'L2', text,
    source: { kind: 'session', sessionId: sessionIds[0], eventId: '10', role: 'user', at: time },
  }, { admin: true });
  let forgetDuringRead = false;
  f.ctx.sessionQuery = {
    listSessions: async () => [f.agent.id, ...sessionIds].map(id => ({ header: { id, cwd: f.cwd } })),
    readSession: async id => {
      if (id === sessionIds[1] && forgetDuringRead) store.forget(record.id, { admin: true });
      const events = id === sessionIds[0] ? [{ type: 'user/message', seq: 10, time, data: {
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
      } }] : [];
      return { session: { id, cwd: f.cwd }, events };
    },
  };
  const request = { sessionIds, query: '导出目录' };
  const before = await f.runtime.findWorkspaceHistory(f.agent, request);
  assert.equal(before.sessionsChecked, 2);
  assert.equal(before.windows[0].events[0].text, text);
  forgetDuringRead = true;
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, request), { code: 'HISTORY_FORGET_STATE_CHANGED' });
  forgetDuringRead = false;
  const after = await f.runtime.findWorkspaceHistory(f.agent, request);
  assert.deepEqual(after.windows, []);
  assert.equal(after.forgottenEvents, 1);
});

test('history backfill previews without memory writes, confirms selected source-bound candidates, and deduplicates retries', async t => {
  const f = fixture(t);
  const targetId = 'backfill-source';
  const at = new Date().toISOString();
  let events = [
    { type: 'user/message', seq: 10, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '我喜欢简洁的回复。' }] } },
    { type: 'user/message', seq: 11, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '当前项目使用 pnpm。' }] } },
    { type: 'user/message', seq: 12, time: at, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '请记住 password: synthetic-secret-value' }] } },
    { type: 'assistant/message', seq: 13, time: at, data: { message: { role: 'assistant',
      content: [{ type: 'text', text: '已经修改设置。' }] } } },
  ];
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd } }],
    readSession: async id => ({ session: { id, cwd: f.cwd }, events }),
  };
  const query = new URLSearchParams({ space: 'shared' });
  const before = f.runtime.space('shared').allRaw().length;
  const preview = await f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: '喜欢',
  });
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].status, 'new');
  assert.equal(preview.candidates[0].layer, 'L2');
  assert.equal(preview.ignoredSensitive, 1);
  assert.equal(f.runtime.space('shared').allRaw().length, before);
  const applied = await f.runtime.api('POST', '/history/import-apply', query, {
    id: preview.id, selected: [preview.candidates[0].importId],
  });
  assert.equal(applied.imported, 1);
  const imported = f.runtime.space('shared').allRaw().find(record =>
    record.source?.historicalImport === true);
  assert.ok(imported);
  assert.equal(imported.status, 'candidate');
  assert.equal(imported.kind, 'historical');
  assert.equal(imported.layer, 'L2');
  assert.equal(imported.source.sessionId, targetId);
  assert.equal(imported.source.eventId, '10');
  assert.equal(f.runtime.space('shared').allRaw().filter(record =>
    record.source?.historicalImport === true).length, 1);

  const retryPreview = await f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: '喜欢',
  });
  assert.equal(retryPreview.candidates[0].status, 'already-exists');
  const retry = await f.runtime.api('POST', '/history/import-apply', query, {
    id: retryPreview.id, selected: [retryPreview.candidates[0].importId],
  });
  assert.equal(retry.existing, 1);
  assert.equal(f.runtime.space('shared').allRaw().filter(record =>
    record.source?.historicalImport === true).length, 1);
});

test('historical records from distinct same-day source events keep distinct anchors', async t => {
  const f = fixture(t);
  const targetId = 'two-history-events';
  const at = new Date().toISOString();
  const events = [10, 11].map(seq => ({ type: 'user/message', seq, time: at, data: {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢简洁的回复。' }],
  } }));
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd } }],
    readSession: async id => ({ session: { id, cwd: f.cwd }, events }),
  };
  const query = new URLSearchParams({ space: 'shared' });
  const preview = await f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: '简洁',
  });
  assert.deepEqual(preview.candidates.map(item => item.eventSeq), [10, 11]);
  const result = await f.runtime.api('POST', '/history/import-apply', query, {
    id: preview.id, selected: preview.candidates.map(item => item.importId),
  });
  assert.equal(result.imported, 2);
  assert.deepEqual(f.runtime.space('shared').allRaw()
    .filter(record => record.source?.historicalImport === true)
    .map(record => record.source.eventId).sort(), ['10', '11']);
});

test('historical tasks never merge into a live task, even when their text is identical', async t => {
  const f = fixture(t);
  const id = 'old-task-session';
  const time = new Date().toISOString();
  const text = '请检查导出配置。';
  const store = f.runtime.space('shared');
  const live = store.create({ layer: 'L1', text, status: 'active' }, { admin: true });
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id, cwd: f.cwd } }],
    readSession: async () => ({ session: { id, cwd: f.cwd }, events: [
      { type: 'user/message', seq: 1, time, data: { role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text }] } },
    ] }),
  };
  const query = new URLSearchParams({ space: 'shared' });
  const preview = await f.runtime.api('POST', '/history/import-preview', query, { sessionIds: [id], query: '导出配置' });
  assert.equal(preview.candidates[0].status, 'new');
  const applied = await f.runtime.api('POST', '/history/import-apply', query, {
    id: preview.id, selected: [preview.candidates[0].importId],
  });
  assert.equal(applied.imported, 1);
  assert.deepEqual(store.raw(live.id), live);
  const history = store.all().find(record => record.id !== live.id);
  assert.equal(history.status, 'candidate');
  assert.equal(history.layer, 'L1');
  assert.equal(history.source.eventId, '1');
});

test('history backfill accepts exactly 200 candidates but does not issue a commit token for overflow', async t => {
  const f = fixture(t);
  const id = 'history-limit';
  const time = new Date().toISOString();
  let count = 201;
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id, cwd: f.cwd } }],
    readSession: async () => ({ session: { id, cwd: f.cwd }, events: Array.from({ length: count }, (_, seq) => ({
      type: 'user/message', seq, time, data: { role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '我喜欢简洁的回复。' }] },
    })) }),
  };
  const query = new URLSearchParams({ space: 'shared' });
  const request = { sessionIds: [id], query: '简洁' };
  const overflow = await f.runtime.api('POST', '/history/import-preview', query, request);
  assert.equal(overflow.truncated, true);
  assert.equal(overflow.candidates.length, 200);
  assert.equal(overflow.id, null);
  await assert.rejects(f.runtime.api('POST', '/history/import-apply', query, {
    id: overflow.id, selected: [overflow.candidates[0].importId],
  }), { code: 'PREVIEW_EXPIRED' });
  assert.equal(f.runtime.space('shared').all().length, 0);

  count = 200;
  const complete = await f.runtime.api('POST', '/history/import-preview', query, request);
  assert.equal(complete.truncated, false);
  assert.equal(complete.candidates.length, 200);
  const applied = await f.runtime.api('POST', '/history/import-apply', query, {
    id: complete.id, selected: [complete.candidates[0].importId],
  });
  assert.equal(applied.imported, 1);
});

test('history backfill does not duplicate partial writes and cannot commit after its token expires during a read', async t => {
  let now = Date.now();
  const f = fixture(t, {}, { clock: () => new Date(now) });
  const id = 'history-retry';
  const time = new Date(now).toISOString();
  const events = [1, 2].map(seq => ({ type: 'user/message', seq, time, data: {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢简洁的回复。' }],
  } }));
  let expireDuringRead = false;
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id, cwd: f.cwd } }],
    readSession: async () => {
      if (expireDuringRead) now += 21 * 60_000;
      return { session: { id, cwd: f.cwd }, events };
    },
  };
  const query = new URLSearchParams({ space: 'shared' });
  const request = { sessionIds: [id], query: '简洁' };
  const preview = await f.runtime.api('POST', '/history/import-preview', query, request);
  const selection = { id: preview.id, selected: preview.candidates.map(item => item.importId) };
  const store = f.runtime.space('shared');
  const create = store.create.bind(store);
  const stub = t.mock.method(store, 'create', (input, actor) => {
    if (input.source.eventId === '2') throw new Error('synthetic interruption');
    return create(input, actor);
  });
  await assert.rejects(f.runtime.api('POST', '/history/import-apply', query, selection), { code: 'HISTORY_IMPORT_PARTIAL' });
  assert.equal(store.all().length, 1);
  stub.mock.restore();
  const replay = await f.runtime.api('POST', '/history/import-apply', query, selection);
  assert.deepEqual([replay.existing, replay.imported], [1, 1]);
  assert.equal(store.all().length, 2);

  const next = await f.runtime.api('POST', '/history/import-preview', query, request);
  expireDuringRead = true;
  await assert.rejects(f.runtime.api('POST', '/history/import-apply', query, {
    id: next.id, selected: next.candidates.map(item => item.importId),
  }), { code: 'PREVIEW_EXPIRED' });
  assert.equal(store.all().length, 2);
});

test('history backfill rejects changed, private, forgotten, and stale preview sources before writing', async t => {
  const f = fixture(t);
  const targetId = 'backfill-source';
  const privateId = 'private-backfill-source';
  const at = new Date().toISOString();
  let events = [{ type: 'user/message', seq: 10, time: at, data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '我喜欢简洁的回复。' }] } }];
  const privateEvents = [{ type: 'user/message', seq: 1, time: at, data: {
    role: 'user', source: { kind: 'runtime-context', sections: [{ name: 'tidal-private-journal' }] },
    content: [{ type: 'text', text: '我喜欢简洁的回复。' }],
  } }];
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd } }, { header: { id: privateId, cwd: f.cwd } }],
    readSession: async id => ({ session: { id, cwd: f.cwd }, events: id === privateId ? privateEvents : events }),
  };
  const query = new URLSearchParams({ space: 'shared' });
  const preview = await f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: '简洁',
  });
  events = [{ ...events[0], data: { ...events[0].data,
    content: [{ type: 'text', text: '我喜欢复杂的回复。' }] } }];
  await assert.rejects(f.runtime.api('POST', '/history/import-apply', query, {
    id: preview.id, selected: [preview.candidates[0].importId],
  }), { code: 'HISTORY_SOURCE_CHANGED' });
  assert.equal(f.runtime.space('shared').allRaw().length, 0);

  await assert.rejects(f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [privateId], query: '简洁',
  }), { code: 'PRIVATE_HISTORY_EXCLUDED' });
  assert.equal(JSON.stringify(f.runtime.lastError).includes('我喜欢简洁的回复'), false);

  events = [{ type: 'user/message', seq: 10, time: at, data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '我喜欢简洁的回复。' }] } }];
  const stale = await f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: '简洁',
  });
  f.runtime.space('shared').forgetLedger.add(f.runtime.space('shared').lineageId, [], [], {
    events: [{ sessionId: targetId, eventSeq: 10 }], known: true,
  });
  await assert.rejects(f.runtime.api('POST', '/history/import-apply', query, {
    id: stale.id, selected: [stale.candidates[0].importId],
  }), { code: 'PREVIEW_EXPIRED' });
  assert.equal(f.runtime.space('shared').allRaw().length, 0);
});

test('history lookup and backfill fail closed when a parent session is absent from the workspace catalog', async t => {
  const f = fixture(t);
  const targetId = 'orphan-child';
  let reads = 0;
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: f.agent.id, cwd: f.cwd } },
      { header: { id: targetId, cwd: f.cwd, parentSession: 'missing-parent' } }],
    readSession: async id => {
      reads++;
      return { session: { id, cwd: f.cwd }, events: [] };
    },
  };
  const query = new URLSearchParams({ space: 'shared' });
  await assert.rejects(f.runtime.api('POST', '/history/import-preview', query, {
    sessionIds: [targetId], query: 'some text',
  }), { code: 'HISTORY_LINEAGE_UNAVAILABLE' });
  assert.equal(reads, 0);
  f.config.historyReadEnabled = true;
  f.config.historyMainSessions = [{ space: 'shared', sessionId: f.agent.id, provider: 'synthetic', model: 'test' }];
  await assert.rejects(f.runtime.findWorkspaceHistory(f.agent, {
    sessionIds: [targetId], query: 'some text',
  }), { code: 'HISTORY_LINEAGE_UNAVAILABLE' });
  assert.equal(reads, 0);
});

test('workspace catalog pagination is bounded and title changes do not change the saved session id', async t => {
  const f = fixture(t);
  const headers = Array.from({ length: 27 }, (_, index) => ({ id: `saved-${index}`, cwd: f.cwd, createdAt: 27 - index }));
  let title = 'Original name', calls = 0;
  f.ctx.sessionQuery = {
    listSessions: async () => headers.map(header => ({ header })),
    readTitleSnapshots: async ids => {
      calls += ids.length;
      return ids.map(id => ({ status: 'fulfilled', value: { session: headers.find(h => h.id === id), title: { title } } }));
    },
  };
  f.config.privateMainSessions = [{ space: 'shared', sessionId: 'saved-0', provider: 'p', model: 'm' }];
  const query = new URLSearchParams({ space: 'shared' });
  const first = await f.runtime.api('GET', '/workspace-sessions', query);
  assert.equal(first.items.length, 25);
  assert.equal(first.nextOffset, 25);
  assert.equal(calls, 25);
  const next = await f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'shared', offset: '25' }));
  assert.equal(next.items.length, 2);
  assert.equal(next.nextOffset, null);
  title = 'Renamed main';
  const renamed = await f.runtime.api('GET', '/workspace-sessions', query);
  assert.equal(renamed.items[0].title, 'Renamed main');
  assert.equal(f.runtime.config.privateMainSessions[0].sessionId, 'saved-0');
  await assert.rejects(f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'shared', offset: '-1' })),
    { code: 'INVALID_OFFSET' });
});

test('missing catalog support and title errors are explicit instead of pretending the workspace is empty', async t => {
  const f = fixture(t);
  const query = new URLSearchParams({ space: 'shared' });
  await assert.rejects(f.runtime.api('GET', '/workspace-sessions', query), { code: 'WORKSPACE_SESSIONS_UNAVAILABLE' });
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: 'saved', cwd: f.cwd } }],
    readTitleSnapshots: async () => [{ status: 'rejected', reason: new Error('PRIVATE_ERROR_CANARY') }],
  };
  const result = await f.runtime.api('GET', '/workspace-sessions', query);
  assert.equal(result.total, 1);
  assert.equal(result.warnings, 1);
  assert.equal(result.items[0].metadataError, 'SESSION_TITLE_READ_FAILED');
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_CANARY'), false);
  await assert.rejects(f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'unbound' })),
    { code: 'UNBOUND_WORKSPACE' });
});

test('changed workspace ownership during asynchronous name reads never returns the wrong titles', async t => {
  const f = fixture(t);
  f.ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: 'saved', cwd: f.cwd } }],
    readTitleSnapshots: async () => [{ status: 'fulfilled', value: {
      session: { id: 'saved', cwd: join(f.root, 'different') }, title: { title: 'NOT_AUTHORIZED' },
    } }],
  };
  await assert.rejects(f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'shared' })),
    { code: 'WORKSPACE_SESSIONS_CHANGED' });
  f.ctx.sessionQuery.readTitleSnapshots = async () => {
    f.config.bindings = [{ cwd: join(f.root, 'rebound'), space: 'shared' }];
    return [{ status: 'fulfilled', value: { session: { id: 'saved', cwd: f.cwd }, title: { title: 'STALE_NAME' } } }];
  };
  await assert.rejects(f.runtime.api('GET', '/workspace-sessions', new URLSearchParams({ space: 'shared' })),
    { code: 'WORKSPACE_SESSIONS_CHANGED' });
});

test('graph record editing does not return a concurrent sibling forget', async t => {
  const { runtime, root } = fixture(t);
  const store = runtime.space('shared');
  const record = store.create({ layer: 'L3', text: 'synthetic graph record' }, { admin: true });
  restoreBackup(root, 'sibling', packBackup(store), '', store.config);
  const sibling = runtime.space('sibling');
  const visible = store.visible;
  let forgotten = false;
  store.visible = function (item, actor) {
    const accepted = visible.call(this, item, actor);
    if (!forgotten && item.id === record.id) {
      forgotten = true;
      sibling.forget(record.id, { admin: true });
    }
    return accepted;
  };
  try {
    await assert.rejects(runtime.api('GET', '/graph/record',
      new URLSearchParams({ space: 'shared', id: record.id })), { code: 'NOT_FOUND' });
    assert.equal(forgotten, true);
  } finally { store.visible = visible; }
});

test('graph record editing does not return a newly quarantined private source', async t => {
  const { runtime } = fixture(t);
  const store = runtime.space('shared');
  const record = store.create({ layer: 'L3', text: 'SYNTHETIC_GRAPH_PRIVATE',
    sessionId: 'soon-private' }, { admin: true });
  const visible = store.visible;
  let marked = false;
  store.visible = function (item, actor) {
    const accepted = visible.call(this, item, actor);
    if (!marked && item.id === record.id) {
      marked = true;
      runtime.privateSessionRegistry().markExposed({ sessionId: 'soon-private', space: 'shared',
        lineageId: store.lineageId, provider: 'synthetic', model: 'test', now: new Date().toISOString() });
    }
    return accepted;
  };
  try {
    await assert.rejects(runtime.api('GET', '/graph/record',
      new URLSearchParams({ space: 'shared', id: record.id })), { code: 'NOT_FOUND' });
    assert.equal(marked, true);
  } finally { store.visible = visible; }
});

test('status on a new space is read-only and does not create its data directory', async t => {
  const { runtime, root } = fixture(t);
  const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
  assert.equal(status.layers.length, 4);
  assert.ok(status.layers.every(layer => layer.count === 0 && layer.pending === 0));
  assert.equal(existsSync(join(root, 'spaces')), false);
  assert.equal(runtime.spaces.has('shared'), false);
});

test('status reads existing workspace databases without modifying their files', async t => {
  const { runtime, root } = fixture(t);
  const store = runtime.space('shared');
  store.create({ layer: 'L3', text: 'status probe', status: 'active' }, { admin: true });
  store.close();
  runtime.spaces.delete('shared');
  const snapshot = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, statSync(path).size, statSync(path).mtimeMs]];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const before = snapshot(join(root, 'spaces', 'shared'));
  const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
  assert.equal(status.layers.find(layer => layer.id === 'L3').count, 1);
  assert.deepEqual(snapshot(join(root, 'spaces', 'shared')), before);
});

test('runtime close still releases open spaces if embedding shutdown fails', async t => {
  const { runtime } = fixture(t);
  const store = runtime.space('shared');
  const closeEmbedding = runtime.embedding.close.bind(runtime.embedding);
  runtime.embedding.close = async () => { throw new Error('injected embedding close failure'); };
  await assert.rejects(runtime.close(), AggregateError);
  assert.equal(store.closed, true);
  runtime.embedding.close = closeEmbedding;
});

test('restore requests may exceed the ordinary 12 MiB write limit', async t => {
  const { runtime } = fixture(t);
  runtime.ctx.connection = { requestRejection: () => undefined };
  const req = Readable.from([Buffer.from(JSON.stringify({
    name: 'restore-probe', text: 'x'.repeat(13 * 1024 * 1024),
  }))]);
  req.method = 'POST';
  req.url = '/tidal-memory/restore';
  req.headers = { 'x-tidal-request': '1', 'content-type': 'application/json' };
  const res = { writableEnded: false, setHeader() {}, end(body) { this.body = body; this.writableEnded = true; } };
  await runtime.handle(req, res);
  assert.notEqual(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).ok, false);
});

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

test('daily deep consolidation runs once after the scheduled local time and catches up missed schedules', async t => {
  const { runtime } = fixture(t, { dailyConsolidateAt: '03:00' });
  const store = runtime.space('shared');
  for (const [eventId, day, text] of [
    ['1', '01', '我更喜欢简洁的回答。'],
    ['2', '02', '我偏好简明的答复。'],
  ]) {
    store.capture({ sessionId: 's', eventId, role: 'user', at: `2026-03-${day}T12:00:00Z`, text });
  }
  store.organizePending();
  runtime.clock = () => new Date('2026-03-03T04:00:00');
  runtime.lastActivity = runtime.clock().getTime() - 21 * 60000;
  const first = await runtime.checkDailyConsolidation();
  assert.equal(first.results[0].promoted, 1);
  assert.equal(first.results[0].missed, true);
  assert.equal((await runtime.checkDailyConsolidation()).results[0].alreadyRun, true);
  runtime.rawConfig.dailyConsolidateAt = '';
  assert.equal((await runtime.checkDailyConsolidation()).disabled, true);
});

test('daily scheduling uses local dates, waits for idle, and persists completion across restart', async t => {
  let now = new Date(2026, 2, 4, 3, 0);
  const { runtime, ctx, config, root, agent, modelCalls } = fixture(t, {}, { clock: () => now });
  assert.equal((await runtime.checkDailyConsolidation()).results[0].waiting, true);
  runtime.lastActivity -= 21 * 60000;
  agent.status = 'running';
  assert.equal((await runtime.checkDailyConsolidation()).results[0].waitingForConversation, true);
  agent.status = 'idle';
  runtime.busy = true;
  assert.equal((await runtime.checkDailyConsolidation()).busy, true);
  runtime.busy = false;
  const result = await runtime.checkDailyConsolidation();
  assert.equal(result.results[0].day, '2026-03-04');
  assert.equal(result.results[0].missed, false);
  assert.ok(result.results[0].backup);
  const query = new URLSearchParams({ space: 'shared' });
  const status = await runtime.api('GET', '/status', query);
  assert.equal(status.nextDailyConsolidationAt, new Date(2026, 2, 5, 3, 0).toISOString());
  now = new Date(2026, 2, 5, 1, 0);
  assert.equal((await runtime.checkDailyConsolidation()).results[0].alreadyRun, true);
  await runtime.close();
  const restarted = new TidalRuntime(ctx, config, root, { clock: () => now });
  try {
    restarted.lastActivity -= 21 * 60000;
    assert.equal((await restarted.checkDailyConsolidation()).results[0].alreadyRun, true);
    now = new Date(2026, 2, 5, 3, 0);
    assert.equal((await restarted.checkDailyConsolidation()).results[0].day, '2026-03-05');
  } finally { await restarted.close(); }
  assert.equal(modelCalls(), 0);
});

test('scheduled sleep creates bounded review candidates and resumes without duplicates after restart', async t => {
  let now = new Date(2026, 2, 4, 4, 0);
  const { runtime, ctx, config, root, modelCalls } = fixture(t, { privateWriters: ['test-author'] }, { clock: () => now });
  runtime.lastActivity -= 21 * 60000;
  const store = runtime.space('shared');
  const questionAt = new Date(now.getTime() - 15 * 60000);
  const answerAt = new Date(now.getTime() - 14 * 60000);
  const question = store.capture({ sessionId: 's', eventId: 'q', text: '这个项目的包管理器是什么？',
    at: questionAt.toISOString() });
  const answer = store.capture({ sessionId: 's', eventId: 'a', text: 'pnpm', at: answerAt.toISOString() });
  const journal = store.appendPrivate('test-author', 'PRIVATE_SLEEP_FIRST\r\nSECOND');
  const first = await runtime.checkDailyConsolidation();
  assert.equal(first.results[0].reencoding.candidates, 1);
  const candidate = store.all().find(record => record.source.kind === 'local-context');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.kind, 'inference');
  assert.deepEqual(candidate.parents, [answer.id, question.id]);
  assert.equal(store.recall('pnpm', { sessionId: 'another' }).picked.length, 0);
  const journalPath = store.privateDb.prepare('SELECT relative_path FROM entries WHERE id=?').get(journal.id).relative_path;
  assert.match(readFileSync(join(store.privateDirectory, ...journalPath.split('/')), 'utf8'),
    /PRIVATE_SLEEP_FIRST\r?\nSECOND/);
  assert.equal(store.privateStatus().count, 1);
  assert.equal(store.status().encoding.sleep.candidates, 1);
  await runtime.close();
  const restarted = new TidalRuntime(ctx, config, root, { clock: () => now });
  try {
    restarted.lastActivity -= 21 * 60000;
    assert.equal((await restarted.checkDailyConsolidation()).results[0].alreadyRun, true);
    now = new Date(2026, 2, 5, 4, 0);
    const next = await restarted.checkDailyConsolidation();
    assert.equal(next.results[0].reencoding.candidates, 0);
    assert.equal(restarted.space('shared').all().filter(record => record.source.kind === 'local-context').length, 1);
    assert.equal(restarted.space('shared').privateStatus().count, 1);
  } finally { await restarted.close(); }
  assert.equal(modelCalls(), 0);
});

test('startup before 03:00 catches up only the most recent missed day and disabled settings stay off', async t => {
  const now = new Date(2026, 2, 8, 1, 0);
  const { runtime, config } = fixture(t, {}, { clock: () => now });
  runtime.lastActivity -= 21 * 60000;
  const result = await runtime.checkDailyConsolidation();
  assert.equal(result.results[0].day, '2026-03-07');
  assert.equal(result.results[0].missed, true);
  assert.equal(runtime.space('shared').system.prepare("SELECT count(*) AS n FROM metadata WHERE key LIKE 'daily-consolidation:%'").get().n, 1);
  config.enabled = false;
  assert.equal((await runtime.checkDailyConsolidation()).disabled, true);
  assert.equal((await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }))).nextDailyConsolidationAt, null);
});

test('manual runs make fresh retained recovery points, drain pending capture, and leave the private journal untouched', async t => {
  const { runtime, root, agent, modelCalls } = fixture(t, { backupKeep: 1, privateWriters: ['test-author'] });
  const store = runtime.space('shared');
  store.appendPrivate('test-author', 'PRIVATE_DEEP_CANARY');
  const journal = store.privateDb.prepare('SELECT * FROM entries').all();
  automaticBackup(store, root);
  store.capture({ sessionId: 's', eventId: '1', text: '我喜欢简短的回答。', at: '2026-03-01T10:00:00Z' });
  store.capture({ sessionId: 's', eventId: '2', text: '我偏好简明的答复。', at: '2026-03-02T10:00:00Z' });
  const saved = store.create({ layer: 'L2', text: 'new since ordinary backup' }, { admin: true });
  const query = new URLSearchParams({ space: 'shared' });
  agent.status = 'running';
  await assert.rejects(runtime.api('POST', '/consolidate', query, {}), { code: 'CONVERSATION_BUSY' });
  agent.status = 'idle';
  const result = await runtime.api('POST', '/consolidate', query, {});
  assert.equal(result.localOrganization.inspected, 2);
  assert.equal(result.promoted, 1);
  assert.equal(store.dailyConsolidationStatus(), null);
  assert.equal(store.status().deepConsolidation.manual, true);
  const file = join(root, 'backups', 'shared', result.backup);
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  const before = unpackBackup(text);
  assert.ok(before.records.some(record => record.id === saved.id));
  assert.equal(before.records.some(record => record.layer === 'L3'), false);
  assert.equal(text.includes('PRIVATE_DEEP_CANARY'), false);
  const second = await runtime.api('POST', '/consolidate', query, {});
  assert.notEqual(result.backup, second.backup);
  assert.deepEqual(readdirSync(join(root, 'backups', 'shared')), [second.backup]);
  assert.deepEqual(store.privateDb.prepare('SELECT * FROM entries').all(), journal);
  assert.equal(modelCalls(), 0);
});

test('a failed daily run leaves no completion marker and retries with recovery after the failure', async t => {
  const now = new Date(2026, 2, 4, 4, 0);
  const { runtime } = fixture(t, {}, { clock: () => now });
  runtime.lastActivity -= 21 * 60000;
  const store = runtime.space('shared');
  for (const day of ['01', '02']) store.capture({ sessionId: 's', eventId: day,
    text: '我喜欢简短回答。', at: `2026-03-${day}T10:00:00Z` });
  store.failpoint = name => { if (name === 'after-consolidation-prepare') throw new Error('injected failure'); };
  assert.equal((await runtime.checkDailyConsolidation()).results[0].failed, true);
  assert.equal(store.dailyConsolidationStatus(), null);
  assert.equal(runtime.busy, false);
  store.failpoint = () => {};
  const retried = await runtime.checkDailyConsolidation();
  assert.equal(retried.results[0].day, '2026-03-04');
  assert.equal(store.all().filter(record => record.layer === 'L3').length, 1);
  assert.equal(runtime.lastError, null);
});

test('a failed recovery point prevents organizing pending records or marking a day complete', async t => {
  const { runtime, root } = fixture(t);
  const store = runtime.space('shared');
  const source = store.capture({ sessionId: 's', eventId: '1', text: '我喜欢简短回答。' });
  writeFileSync(join(root, 'backups'), 'synthetic obstruction');
  await assert.rejects(runtime.api('POST', '/consolidate', new URLSearchParams({ space: 'shared' }), {}));
  assert.equal(store.get(source.id, { admin: true }).status, 'pending');
  assert.equal(store.all().filter(record => record.layer !== 'L0').length, 0);
  assert.equal(store.dailyConsolidationStatus(), null);
  assert.equal(runtime.busy, false);
});

test('legacy selected model mode safely falls back to local rules and private route stays unavailable', async t => {
  const now = new Date(2026, 2, 4, 4, 0);
  const { runtime, modelCalls } = fixture(t, { deepOrganizationMode: 'selected',
    privateOrganizationMode: 'author', privateWriters: ['test-author'] }, { clock: () => now });
  runtime.lastActivity -= 21 * 60000;
  const store = runtime.space('shared');
  store.appendPrivate('test-author', 'PRIVATE_MODEL_ROUTE_CANARY');
  store.capture({ sessionId: 's', eventId: '1', text: '我喜欢简短回答。' });
  const result = (await runtime.checkDailyConsolidation()).results[0];
  assert.equal(result.privateOrganization.code, 'PRIVATE_MODEL_ROUTE_UNVERIFIED');
  assert.equal(result.modelExtraction.mode, 'local');
  assert.equal(result.modelExtraction.state, 'rules-only');
  assert.equal(result.localOrganization.organized, 1);
  assert.equal(modelCalls(), 0);
  const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
  assert.equal(status.organizationModels.private.authorAvailable, false);
  assert.equal(status.organizationModels.ordinary.state, 'rules-only');
  assert.equal(JSON.stringify(status).includes('PRIVATE_MODEL_ROUTE_CANARY'), false);
  await assert.rejects(runtime.api('POST', '/private/organize', new URLSearchParams({ space: 'shared' }), {}),
    { code: 'PRIVATE_MODEL_ROUTE_UNVERIFIED' });
});

test('private organization failure does not block ordinary consolidation and retry clears the error', async t => {
  const now = new Date(2026, 2, 4, 4, 0);
  const { runtime, modelCalls } = fixture(t, { privateWriters: ['test-author'] }, { clock: () => now });
  runtime.lastActivity -= 21 * 60000;
  const store = runtime.space('shared');
  store.appendPrivate('test-author', 'PRIVATE_FAILURE_CANARY');
  store.capture({ sessionId: 's', eventId: '1', text: '我喜欢简短回答。' });
  store.organizePrivateWindow = () => { throw new Error('PRIVATE_FAILURE_CANARY must not enter logs'); };
  const first = (await runtime.checkDailyConsolidation()).results[0];
  assert.equal(first.privateOrganization.state, 'failed');
  assert.equal(first.localOrganization.organized, 1);
  assert.equal(JSON.stringify(runtime.lastError).includes('PRIVATE_FAILURE_CANARY'), false);
  assert.equal(store.privateStatus().failure.code, 'PRIVATE_ORGANIZATION_FAILED');
  store.close();
  runtime.spaces.delete('shared');
  const persisted = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
  assert.equal(persisted.private.failure.code, 'PRIVATE_ORGANIZATION_FAILED');
  const retry = await runtime.api('POST', '/private/organize', new URLSearchParams({ space: 'shared' }), {});
  assert.equal(retry.state, 'completed');
  assert.equal(runtime.space('shared').privateStatus().failure, null);
  assert.equal(runtime.lastError, null);
  assert.equal(modelCalls(), 0);
});

test('status avoids reading WAL while another writer is active', async t => {
  const { runtime, root } = fixture(t);
  const owner = new MemorySpace(root, 'shared');
  try {
    const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
    assert.equal(status.unavailable, true);
    assert.equal(status.spaceError.code, 'SPACE_BUSY');
    assert.equal(runtime.spaces.has('shared'), false);
    assert.equal(status.dailyConsolidation, null);
    assert.equal(status.nextDailyConsolidationAt, null);
  } finally { owner.close(); }
  assert.equal((await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }))).space, 'shared');
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

test('exposed and inherited private sessions cannot write ordinary memory but still record private review receipts', t => {
  const { runtime, agent, agents, config } = fixture(t);
  config.privateMainSessions = [{ space: 'shared', sessionId: agent.id, provider: 'synthetic', model: 'test' }];
  runtime.syncConfig();
  runtime.privateAgentDisposers.set(agent.id, () => {});
  const store = runtime.space('shared');
  runtime.privateSessionRegistry().markExposed({ sessionId: agent.id, space: 'shared',
    lineageId: store.lineageId, provider: 'synthetic', model: 'test', now: new Date().toISOString() });
  let observed = 0;
  store.recordPrivateObservation = () => { observed++; return true; };
  runtime.pendingPrivateObservations.set(agent.id, { turn: 1, step: 1 });
  runtime.onEvent(agent.session, { type: 'assistant/message', seq: 1, time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_ASSISTANT' }] } } });
  runtime.onEvent(agent.session, { type: 'user/message', seq: 2, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：PRIVATE_USER' }] } });
  assert.equal(observed, 1);
  assert.equal(store.all().length, 0);
  const { actor } = runtime.forAgent(agent);
  assert.throws(() => store.create({ layer: 'L2', text: 'PRIVATE_PROPOSAL' }, actor),
    { code: 'PRIVATE_SESSION_QUARANTINED' });
  assert.throws(() => store.recordEvent({ text: 'PRIVATE_RESULT', operationId: '00000000-0000-0000-0000-000000000101' }, actor),
    { code: 'PRIVATE_SESSION_QUARANTINED' });
  assert.throws(() => store.createScene({ title: 'PRIVATE_SCENE', operationId: '00000000-0000-0000-0000-000000000102' }, actor),
    { code: 'PRIVATE_SESSION_QUARANTINED' });

  const child = { id: 'private-child', status: 'idle', session: {
    id: 'private-child', header: { cwd: agent.session.header.cwd, parentSession: agent.id }, snapshotEvents: () => [],
  } };
  agents.push(child);
  runtime.onEvent(child.session, { type: 'user/message', seq: 3, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：PRIVATE_CHILD' }] } });
  assert.equal(runtime.privateSessionRegistry().get(child.id).state, 'inherited');
  assert.equal(store.all().length, 0);
  assert.throws(() => runtime.forAgent(child), { code: 'PRIVATE_SESSION_UNAUTHORIZED' });
});

test('exposed sessions cannot change workspace or model route without a clean session', async t => {
  const { runtime, agent, config, cwd } = fixture(t);
  config.privateMainSessions = [{ space: 'shared', sessionId: agent.id, provider: 'synthetic', model: 'test' }];
  runtime.syncConfig();
  runtime.privateAgentDisposers.set(agent.id, () => {});
  const store = runtime.space('shared');
  runtime.privateSessionRegistry().markExposed({ sessionId: agent.id, space: 'shared', lineageId: store.lineageId,
    provider: 'synthetic', model: 'test', now: new Date().toISOString() });
  assert.equal(runtime.forAgent(agent).space, 'shared');
  config.privateMainSessions[0].model = 'different';
  agent.session.requestContext = () => ({ provider: 'synthetic', model: 'different' });
  assert.equal((await runtime.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))).kind, 'reject');
  config.bindings = [{ cwd, space: 'other' }];
  config.privateMainSessions = [{ space: 'other', sessionId: agent.id, provider: 'synthetic', model: 'test' }];
  agent.session.requestContext = () => ({ provider: 'synthetic', model: 'test' });
  assert.throws(() => runtime.forAgent(agent), { code: 'PRIVATE_SESSION_UNAUTHORIZED' });
});

test('newly quarantined records are removed from cached context and missing history checks fail closed', async t => {
  const { runtime, agent } = fixture(t);
  const store = runtime.space('shared');
  const record = store.create({ layer: 'L3', text: 'SYNTHETIC_CACHED_PRIVATE',
    sessionId: 'other-session', pinned: true }, { admin: true });
  assert.match(runtime.context({ agent }), /SYNTHETIC_CACHED_PRIVATE/);
  runtime.privateSessionRegistry().markExposed({ sessionId: 'other-session', space: 'shared', lineageId: store.lineageId,
    provider: 'synthetic', model: 'test', now: new Date().toISOString() });
  assert.equal(runtime.context({ agent }).includes(record.text), false);
  delete agent.session.snapshotEvents;
  runtime.onEvent(agent.session, { type: 'user/message', seq: 1, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：must not be captured' }] } });
  assert.equal(store.all().some(item => item.text.includes('must not be captured')), false);
  assert.equal((await runtime.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))).kind, 'reject');
  assert.equal(runtime.lastError.code, 'PRIVATE_LINEAGE_UNAVAILABLE');
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

test('registered subagent sessions share only their explicitly bound workspace memory', async t => {
  const { runtime, agent, agents, cwd } = fixture(t, { residentBudget: 0 });
  const workerSession = {
    id: 'worker-session',
    header: { cwd, origin: 'subagent' },
    snapshotEvents: () => [],
  };
  const worker = { id: workerSession.id, status: 'idle', session: workerSession };
  agents.push(worker);

  const shared = runtime.space('shared');
  const experience = shared.create({ layer: 'L2', text: 'shared worker experience' }, { admin: true });
  const access = runtime.forAgent(worker);
  assert.equal(access.space, 'shared');
  const task = shared.create({ layer: 'L1', category: 'task', text: 'worker task for cobalt build' }, { admin: true });
  shared.setSessionFocus({ taskRef: task.id }, access.actor);
  assert.equal(runtime.queryWindow({ query: '', recent: [] }, shared, access.actor).query, task.text);
  await runtime.preStep({ agent: worker }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'worker experience' }] }],
  }));
  assert.match(runtime.context({ agent: worker }), /shared worker experience/);
  const cursor = shared.changePage(access.actor, null, 200).cursor;
  runtime.onEvent(workerSession, {
    type: 'user/message', seq: 1, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：worker result persisted' }] },
  });
  assert.ok(shared.all().some(record => record.sessionId === worker.id && record.text === 'worker result persisted'));
  shared.forget(experience.id, { admin: true });
  assert.ok(shared.changePage(access.actor, cursor, 200).items.some(item =>
    item.id === experience.id && item.status === 'forgotten'));

  const otherWorkspaceSession = {
    id: 'unbound-worker',
    header: { cwd: `${cwd}-other`, origin: 'subagent' },
    snapshotEvents: () => [],
  };
  const unboundWorker = { id: otherWorkspaceSession.id, status: 'idle', session: otherWorkspaceSession };
  agents.push(unboundWorker);
  assert.throws(() => runtime.forAgent(unboundWorker), error => error.code === 'UNBOUND_WORKSPACE');
  assert.equal(runtime.context({ agent: unboundWorker }), '');
  runtime.onEvent({ ...workerSession, id: 'unregistered-session' }, {
    type: 'user/message', seq: 2, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'unregistered event' }] },
  });
  assert.equal(shared.all().some(record => record.text === 'unregistered event'), false);

  assert.equal(agents.includes(agent), true);
});

test('cached context is not returned when a same-lineage forget arrives during the read', t => {
  const { runtime, agent, root } = fixture(t);
  const store = runtime.space('shared');
  const record = store.create({ layer: 'L3', text: 'cached context forget canary' }, { admin: true });
  restoreBackup(root, 'context-copy', packBackup(store), '', store.config);
  const copy = new MemorySpace(root, 'context-copy', { config: store.config });
  try {
    assert.match(runtime.context({ agent }), /cached context forget canary/);
    const version = store.forgetVersion.bind(store);
    let reads = 0, injected = false;
    store.forgetVersion = () => {
      if (++reads === 3) { injected = true; copy.forget(record.id, { admin: true }); }
      return version();
    };
    assert.equal(runtime.context({ agent }).includes(record.text), false);
    assert.equal(injected, true);
    assert.equal(store.raw(record.id), undefined);
  } finally { copy.close(); }
});

test('cached context is reevaluated when the local clock moves backwards', t => {
  let now = Date.parse('2026-03-12T00:00:00Z');
  const { runtime, agent } = fixture(t, {}, { clock: () => new Date(now) });
  const store = runtime.space('shared');
  store.create({ layer: 'L3', text: 'future context canary', validFrom: '2026-03-11T00:00:00Z' }, { admin: true });
  assert.match(runtime.context({ agent }), /future context canary/);
  now = Date.parse('2026-03-10T00:00:00Z');
  assert.equal(runtime.context({ agent }).includes('future context canary'), false);
});

test('admission queries are transient and reinforcement waits for the real user event', async t => {
  const { runtime, agent } = fixture(t, { residentBudget: 0 });
  const store = runtime.space('shared');
  const record = store.create({ layer: 'L2', text: 'violet protocol' }, { admin: true });
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'violet protocol' }] };
  await runtime.preStep({ agent }, async () => ({ kind: 'reject' }));
  assert.equal(runtime.sessions.size, 0);
  await runtime.preStep({ agent }, async () => ({ kind: 'enter', messages: [message] }));
  assert.match(runtime.context({ agent }), /violet protocol/);
  assert.equal(store.all().filter(row => row.layer === 'L0').length, 0);
  assert.equal(store.get(record.id, { admin: true }).recallCount, 0);
  const event = { type: 'user/message', seq: 25, time: Date.now(), data: message };
  runtime.onEvent(agent.session, event);
  runtime.onEvent(agent.session, event);
  assert.equal(store.get(record.id, { admin: true }).recallCount, 1);
});

for (const length of [2000, 2001, 16000, 16001]) {
  test(`automatic recall bounds ${length}-character messages without truncating captured text`, t => {
    const { runtime, agent } = fixture(t);
    const store = runtime.space('shared');
    store.create({ layer: 'L3', text: 'omega protocol' }, { admin: true });
    const text = 'omega protocol '.repeat(Math.ceil(length / 15)).slice(0, length);
    const originalRecall = store.recall.bind(store);
    let query;
    store.recall = (input, ...args) => { query = input; return originalRecall(input, ...args); };
    runtime.sessions.set(agent.id, { query: 'previous unrelated request', context: 'stale', space: 'shared' });
    runtime.onEvent(agent.session, {
      type: 'user/message', seq: 1, time: Date.now(),
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    assert.match(runtime.context({ agent }), /omega protocol/);
    assert.equal(query, recallQuery(text));
    const buffers = store.all().filter(record => record.layer === 'L0');
    if (length <= 16000) {
      assert.equal(buffers.length, 1);
      assert.equal(buffers[0].text, text.trim());
      assert.equal(runtime.lastError, null);
    } else {
      assert.equal(buffers.length, 2);
      for (const record of buffers) assert.equal(record.text,
        text.slice(record.source.chunk.offset, record.source.chunk.offset + 16000).trim());
      assert.equal(new Set(buffers.map(record => record.source.eventId)).size, 1);
      assert.equal(runtime.lastError, null);
    }
  });
}

test('restored long user messages use bounded recall and preserve the source event', t => {
  const { runtime, agent } = fixture(t);
  const text = 'omega protocol '.repeat(10000);
  const events = [{ type: 'user/message', data: {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
  } }];
  agent.session.snapshotEvents = () => events;
  const store = runtime.space('shared');
  store.create({ layer: 'L3', text: 'omega protocol' }, { admin: true });
  assert.match(runtime.context({ agent }), /omega protocol/);
  assert.equal(runtime.lastError, null);
  assert.equal(events[0].data.content[0].text, text);
  assert.equal(store.all().filter(record => record.layer === 'L0').length, 0);
  assert.throws(() => store.recall(text, { sessionId: agent.id }), { code: 'INVALID_INPUT' });
});

test('automatic recall keeps a well-formed Unicode boundary', t => {
  const { runtime, agent } = fixture(t);
  const text = `${'a'.repeat(MAX_RECALL_QUERY_LENGTH - 1)}🐋tail`;
  agent.session.snapshotEvents = () => [{ type: 'user/message', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  } }];
  let query;
  runtime.space('shared').recall = input => { query = input; return { text: '' }; };
  assert.equal(runtime.context({ agent }), '');
  assert.equal(query.length, MAX_RECALL_QUERY_LENGTH);
  assert.equal(query.isWellFormed(), true);
});

test('recall errors explain validation failures, stay scoped, and clear after recovery', async t => {
  const { runtime, agent } = fixture(t);
  const store = runtime.space('shared');
  const originalRecall = store.recall.bind(store);
  store.recall = () => { throw new MemoryError('INVALID_INPUT', '查询超出允许长度。'); };
  assert.match(runtime.context({ agent }), /暂不可用/);
  const status = space => runtime.api('GET', '/status', new URLSearchParams({ space }));
  assert.match((await status('shared')).error.message, /查询超出允许长度/);
  assert.equal((await status('default')).error, null);
  store.recall = originalRecall;
  assert.equal(runtime.context({ agent }), '');
  assert.equal((await status('shared')).error, null);
  runtime.noteError('CAPTURE_TOO_LARGE', '捕获未完成。');
  runtime.invalidateSpace('shared');
  runtime.context({ agent });
  assert.equal(runtime.lastError.code, 'CAPTURE_TOO_LARGE');
});

test('recent user context survives acknowledgments, cold restore and 200 turns without crossing sessions', t => {
  const { runtime, agent, agents } = fixture(t, { residentMode: 'pinned' });
  const events = [];
  agent.session.snapshotEvents = () => events;
  const store = runtime.space('shared');
  const task = store.create({ layer: 'L1', text: 'orchid deployment staging' }, { admin: true });
  for (let seq = 1; seq <= 200; seq++) {
    const text = seq % 4 === 1 ? 'orchid deployment staging' : '嗯，继续。';
    const event = { seq, type: 'user/message', time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } };
    events.push(event);
    runtime.onEvent(agent.session, event);
    if (seq === 100) runtime.sessions.delete(agent.id);
    assert.match(runtime.context({ agent }), /orchid deployment staging/, `turn ${seq}`);
    const before = store.get(task.id, { admin: true }).recallCount;
    runtime.recallForAgent(agent, 'orchid deployment staging');
    assert.equal(store.get(task.id, { admin: true }).recallCount, before);
  }
  const other = { ...agent, id: 'other', session: { ...agent.session, id: 'other', snapshotEvents: () => [] } };
  agents.push(other);
  assert.equal(runtime.context({ agent: other }), '');
  assert.ok(runtime.sessions.get(agent.id).recent.length <= 5);
});
