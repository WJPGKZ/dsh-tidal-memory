import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime, recallQuery } from '../src/runtime.js';
import { MAX_RECALL_QUERY_LENGTH, MemoryError } from '../src/model.js';
import { MemorySpace } from '../src/store.js';
import { automaticBackup, unpackBackup } from '../src/transfer.js';

function fixture(t, overrides = {}, runtimeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-runtime-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoExtract: true, autoBackup: false,
    bindings: [{ cwd, space: 'shared' }], ...overrides };
  const agent = { id: 'new-session', status: 'idle', session: {
    id: 'new-session', header: { cwd }, requestHeader: () => ({ config: { provider: 'synthetic', model: 'test' } }), snapshotEvents: () => [],
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

test('status remains available under writer contention without opening the space a second time', async t => {
  const { runtime, root } = fixture(t);
  const owner = new MemorySpace(root, 'shared');
  try {
    const status = await runtime.api('GET', '/status', new URLSearchParams({ space: 'shared' }));
    assert.equal(status.unavailable, true);
    assert.equal(status.spaceError.code, 'SPACE_BUSY');
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
      assert.equal(buffers.length, 0);
      assert.equal(runtime.lastError.code, 'CAPTURE_TOO_LARGE');
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
