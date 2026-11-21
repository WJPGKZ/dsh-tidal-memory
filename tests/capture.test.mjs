import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime } from '../src/runtime.js';

const admin = { admin: true };
const time = Date.parse('2026-03-03T12:00:00Z');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-capture-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoBackup: false, bindings: [{ cwd, space: 'shared' }], ...overrides };
  const agent = { id: 'session-a', status: 'idle', session: { id: 'session-a',
    header: { cwd }, snapshotEvents: () => [] } };
  const agents = [agent];
  const ctx = { agents: { get: id => agents.find(item => item.id === id), list: () => agents },
    settings: { describe: () => [] }, logger: { warn() {} } };
  const runtime = new TidalRuntime(ctx, config, root);
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, config, agent, agents, runtime, store: runtime.space('shared') };
}

function user(seq, text) {
  return { type: 'user/message', seq, time: time + seq,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
}
function call(seq, callId, name = 'write') {
  return { type: 'tool/call', seq, time: time + seq, data: { callId, name, turn: 1, step: 1,
    arguments: '{"file_path":"ignored","content":"SECRET_TOOL_INPUT_CANARY"}' } };
}
function result(seq, invocation, path, patch = {}) {
  return { type: 'tool/result', seq, time: time + seq, sourceEventSeqs: [invocation.seq],
    data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: invocation.data.callId },
      toolCallId: invocation.data.callId, isError: false,
      content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT_CANARY' }] },
    meta: { operation: 'create', path, diffs: [{ before: 'SECRET_TOOL_DIFF_CANARY' }] }, ...patch } };
}

test('batch receipts follow their own calls and original task focus without saving tool bodies', t => {
  const { runtime, store, agent, cwd } = fixture(t);
  const actor = { sessionId: agent.id };
  const firstTask = store.create({ layer: 'L1', text: 'first task', status: 'active' }, admin);
  const secondTask = store.create({ layer: 'L1', text: 'second task', status: 'active' }, admin);
  const first = call(1, 'call-first'), second = call(2, 'call-second');
  const firstResult = result(4, first, join(cwd, 'report.md'));
  const secondResult = result(3, second, join(cwd, 'report.md'));
  store.setSessionFocus({ taskRef: firstTask.id }, actor);
  runtime.onEvent(agent.session, first);
  store.setSessionFocus({ taskRef: secondTask.id }, actor);
  runtime.onEvent(agent.session, second);
  for (const event of [secondResult, firstResult, firstResult, secondResult]) runtime.onEvent(agent.session, event);

  const receipts = store.all().filter(record => record.source.kind === 'host-tool-receipt');
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.find(record => record.source.callId === 'call-first').parents, [firstTask.id]);
  assert.deepEqual(receipts.find(record => record.source.callId === 'call-second').parents, [secondTask.id]);
  assert.ok(receipts.every(record => record.kind === 'observation' && /未验证/.test(record.text)));
  assert.equal(store.raw(firstTask.id).status, 'active');
  assert.equal(store.raw(secondTask.id).status, 'active');
  const ordinary = JSON.stringify({ records: store.all(), receipts: store.system.prepare('SELECT * FROM capture_receipts').all(),
    calls: store.system.prepare('SELECT * FROM capture_calls').all(), snapshot: store.snapshot() });
  assert.equal(ordinary.includes('SECRET_TOOL_'), false);
  const pointer = store.get(receipts[0].id, actor).source;
  assert.equal(pointer.kind, 'host-tool-receipt');
  assert.ok(pointer.callId);
  assert.equal(pointer.operation, 'create');
  assert.equal(store.eventCapture.status().sessionsWithGaps, 0);
});

test('an out-of-order result waits for its own call and is replayed without duplication', t => {
  const { runtime, store, agent, cwd } = fixture(t);
  const invocation = call(1, 'late-call');
  const receipt = result(2, invocation, join(cwd, 'file.txt'));
  agent.session.snapshotEvents = () => [invocation, receipt];
  runtime.onEvent(agent.session, receipt);
  assert.equal(store.eventCapture.status().counts.waiting, 1);
  assert.equal(store.all().filter(record => record.source.kind === 'host-tool-receipt').length, 0);
  runtime.onEvent(agent.session, invocation);
  runtime.onEvent(agent.session, receipt);
  assert.equal(store.all().filter(record => record.source.kind === 'host-tool-receipt').length, 1);
  assert.equal(store.eventCapture.status().counts.saved, 1);
  assert.equal(store.eventCapture.status().sessionsWithGaps, 0);
});

test('duplicate unpaired results do not exhaust retries before a late call arrives', t => {
  const { runtime, store, agent, cwd } = fixture(t);
  const invocation = call(1, 'eventually-seen');
  const receipt = result(2, invocation, join(cwd, 'file.txt'));
  agent.session.snapshotEvents = () => [invocation, receipt];
  for (let index = 0; index < 8; index++) runtime.onEvent(agent.session, receipt);
  assert.equal(store.system.prepare('SELECT attempts FROM capture_receipts WHERE session_id=? AND event_seq=?')
    .get(agent.id, receipt.seq).attempts, 1);
  runtime.onEvent(agent.session, invocation);
  assert.equal(store.eventCapture.status().counts.saved, 1);
});

test('a saved user event interrupted before its receipt is safely retried after reopening', t => {
  const { runtime, agent } = fixture(t);
  let store = runtime.space('shared');
  const event = user(1, '记住：以后回答保持简洁');
  agent.session.snapshotEvents = () => [event];
  let interrupted = false;
  store.failpoint = stage => {
    if (stage === 'after-capture-write' && !interrupted) {
      interrupted = true;
      throw new Error('synthetic capture interruption');
    }
  };
  runtime.onEvent(agent.session, event);
  assert.equal(interrupted, true);
  assert.equal(store.eventCapture.status().counts.failed, 1);
  const record = store.all().find(item => item.layer === 'L3');
  assert.ok(record);
  store.close();
  runtime.spaces.delete('shared');
  store = runtime.space('shared');
  assert.deepEqual(runtime.retryLiveCaptures(store, { force: true }), { retried: 1, unavailable: 0, failed: 0 });
  assert.equal(store.all().filter(item => item.layer === 'L3').length, 1);
  assert.equal(store.raw(record.id).revision, record.revision);
  assert.equal(store.eventCapture.status().counts.saved, 1);
  assert.equal(store.eventCapture.status().sessionsWithGaps, 0);
});

test('unknown, mismatched, cross-workspace and sensitive tool targets are never treated as completed work', t => {
  const base = mkdtempSync(join(tmpdir(), 'tidal-capture-other-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { runtime, store, agent, cwd, config } = fixture(t);
  config.bindings.push({ cwd: base, space: 'other' });
  const shell = call(1, 'shell', 'pwsh');
  const failed = call(3, 'failed');
  const mismatched = call(5, 'mismatched');
  const outside = call(7, 'outside');
  const sensitive = call(9, 'sensitive');
  const failedResult = result(4, failed, join(cwd, 'unknown.txt'), {
    message: { role: 'tool', source: { kind: 'tool', callId: 'failed' }, toolCallId: 'failed',
      isError: true, content: [{ type: 'text', text: 'SECRET_TOOL_ERROR_CANARY' }] },
  });
  for (const event of [shell, result(2, shell, join(cwd, 'ignored.txt')), failed, failedResult,
    mismatched, result(6, mismatched, join(cwd, 'wrong.txt'), { turn: 2 }),
    outside, result(8, outside, join(base, 'other.md')),
    sensitive, result(10, sensitive, join(cwd, '.env.local'))]) runtime.onEvent(agent.session, event);
  const receipts = store.all().filter(record => record.source.kind === 'host-tool-receipt');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].source.operation, 'error');
  assert.match(receipts[0].text, /调用失败/);
  assert.match(receipts[0].text, /是否变化.*未确认/);
  assert.equal(JSON.stringify(receipts).includes('SECRET_TOOL_'), false);
  const status = store.eventCapture.status();
  assert.equal(status.reasons['unsupported-tool'], 1);
  assert.equal(status.reasons['unpaired-tool-result'], 1);
  assert.equal(status.reasons['unverified-or-excluded-target'], 2);
});

test('assistant completion claims stay in review and ordinary replies are not captured', t => {
  const { runtime, store, agent } = fixture(t, { captureAssistant: true });
  const send = (seq, text) => runtime.onEvent(agent.session, { type: 'assistant/message', seq, time: time + seq,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  send(1, '仅供参考的普通回复。');
  send(2, '我已经完成文档迁移。\n后续还需要验证。');
  const records = store.all().filter(record => record.source.role === 'assistant');
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'review');
  assert.equal(records[0].kind, 'inference');
  assert.equal(records[0].text.includes('后续还需要验证'), false);
  assert.equal(store.db('L0').prepare('SELECT count(*) AS n FROM memories').get().n, 0);
  assert.equal(store.recall('文档迁移', { sessionId: 'other' }).picked.length, 0);
});

test('another session can distinguish an export plan, a config write, and a later directory correction', t => {
  const { runtime, store, agent, cwd } = fixture(t, { captureAssistant: true, residentBudget: 0, workingHours: 0 });
  const send = event => runtime.onEvent(agent.session, event);
  send(user(1, '报告导出目录目前是 C:\\reports。'));
  send(user(2, '准备把报告导出目录改到 D:\\reports。'));
  const plan = store.all().find(record => record.source.rule === 'plan');
  assert.equal(plan?.layer, 'L1');
  assert.equal(plan.claim, null);
  store.setSessionFocus({ taskRef: plan.id }, { sessionId: agent.id });
  const invocation = call(3, 'write-export-config');
  send(invocation);
  send(result(4, invocation, join(cwd, 'export-config.json')));
  send({ type: 'assistant/message', seq: 5, time: time + 5,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '我已经完成了报告导出。' }] } } });
  send(user(6, '更正：报告导出目录由 C:\\reports 改为 E:\\reports。'));

  const old = store.all().find(record => record.claim?.value === 'C:\\reports');
  const current = store.all().find(record => record.claim?.value === 'E:\\reports');
  const receipt = store.all().find(record => record.source.kind === 'host-tool-receipt');
  assert.equal(old.status, 'superseded');
  assert.equal(old.validUntil, current.validFrom);
  assert.equal(store.raw(plan.id).status, 'active');
  assert.deepEqual(receipt.parents, [plan.id]);
  assert.equal(store.all().find(record => record.source.role === 'assistant').status, 'review');

  const reader = { sessionId: 'another-session' };
  const now = store.recall('报告 导出 目录', reader);
  assert.ok(now.picked.some(record => record.id === current.id));
  assert.ok(now.picked.every(record => record.id !== old.id));
  assert.match(now.text, /计划，不是已完成/);
  assert.match(now.text, /用户陈述的导出目录：E:\\reports/);
  assert.ok(store.recall('报告 导出 目录', reader, { mode: 'as-of', asOf: old.validFrom })
    .picked.some(record => record.id === old.id));
  const detail = store.readEvidence({ id: receipt.id }, reader);
  assert.match(detail.evidence, /仅证明工具报告的文件操作/);
  assert.match(detail.text, /export-config\.json；未验证文件内容或任务目标/);
  assert.equal(detail.sources[0].eventId, '4');
});

test('pending source material is not organized after the forget state changes', t => {
  const { runtime, store, agent } = fixture(t);
  const forgotten = store.create({ layer: 'L3', text: 'a different old fact' }, admin);
  const original = store.organizePending.bind(store);
  store.organizePending = () => { throw new Error('injected failure before encoding'); };
  const event = user(1, '记住：this pending item must be reviewed');
  agent.session.snapshotEvents = () => [event];
  runtime.onEvent(agent.session, event);
  store.organizePending = original;
  assert.equal(store.eventCapture.status().counts.failed, 1);
  store.forget(forgotten.id, admin);
  const organized = store.organizePending();
  assert.equal(organized.organized, 0);
  assert.equal(organized.needsReview, 1);
  assert.equal(store.all().some(record => record.layer === 'L3' && record.text.includes('pending item')), false);
  assert.equal(store.eventCapture.status().reasons.FORGET_CHANGED, 1);
  runtime.retryLiveCaptures(store, { force: true });
  assert.equal(store.all().some(record => record.layer === 'L3' && record.text.includes('pending item')), false);
});

test('forgetting an event removes its buffer and blocks resegmented or replayed source material', t => {
  const { runtime, store, agent } = fixture(t);
  const event = user(1, '记住：以后回答保持简洁');
  agent.session.snapshotEvents = () => [event];
  runtime.onEvent(agent.session, event);
  const record = store.all().find(item => item.layer === 'L3');
  assert.ok(record);
  store.forget(record.id, admin);
  assert.equal(store.all().length, 0);
  const coverage = store.forgetLedger.state(store.lineageId);
  assert.equal(coverage.unknownEventCoverage, false);
  assert.ok(coverage.eventAnchors.some(anchor => anchor.sessionId === agent.id && anchor.eventSeq === event.seq));
  assert.throws(() => store.capture({ sessionId: agent.id, eventId: event.seq,
    text: 'a differently segmented source', role: 'user' }), { code: 'FORGOTTEN' });
  runtime.sessions.delete(agent.id);
  assert.equal(runtime.sessionState(agent.session, 'shared').query, '');
  runtime.onEvent(agent.session, event);
  assert.equal(store.all().length, 0);
  assert.equal(runtime.sessionState(agent.session, 'shared').query, '');
  assert.equal(store.eventCapture.status().reasons['forgotten-source'], 1);
});

test('private-session events are excluded from capture and its diagnostics', t => {
  const { runtime, store, agent, cwd } = fixture(t);
  runtime.privateSessionRegistry().markExposed({ sessionId: agent.id, space: 'shared',
    lineageId: store.lineageId, provider: 'synthetic', model: 'test', now: new Date().toISOString() });
  const invocation = call(1, 'private-call');
  runtime.onEvent(agent.session, user(0, '记住：SYNTHETIC_PRIVATE_TEXT'));
  runtime.onEvent(agent.session, invocation);
  runtime.onEvent(agent.session, result(2, invocation, join(cwd, 'private-output.txt')));
  assert.equal(store.system.prepare('SELECT count(*) AS n FROM capture_receipts').get().n, 0);
  assert.equal(JSON.stringify(store.snapshot()).includes('SYNTHETIC_PRIVATE_TEXT'), false);
  assert.equal(store.eventCapture.status().sessions, 0);
});
