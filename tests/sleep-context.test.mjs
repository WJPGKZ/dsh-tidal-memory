import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { contextualSleepCandidate } from '../src/sleep-context.js';
import { encodeCandidates } from '../src/model.js';
import { packBackup } from '../src/transfer.js';

const admin = { admin: true };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-sleep-context-'));
  let now = options.now ?? Date.parse('2026-03-04T12:00:00Z');
  let event = 0;
  const space = new MemorySpace(root, 'shared', { clock: () => now,
    config: { residentBudget: 0, ...options.config }, failpoint: options.failpoint });
  t.after(() => { space.close(); rmSync(root, { recursive: true, force: true }); });
  const capture = (text, sessionId = 'a', extras = {}) => {
    now += 1000;
    const source = space.capture({ text, sessionId, eventId: ++event, at: new Date(now).toISOString(), ...extras });
    space.organizePending(1, source.id);
    return source;
  };
  return { root, space, capture, get now() { return now; }, set now(value) { now = value; } };
}
const run = f => f.space.reencodeRecent({ from: new Date(f.now - 3600000).toISOString(), until: new Date(f.now).toISOString() });

test('bounded synthetic question-answer cases increase reviewable coverage without accepting ambiguous statements', () => {
  const positives = [
    ['这个项目的包管理器是什么？', 'pnpm', 'package-manager', 'workspace.project'],
    ['本项目使用哪个数据库？', '使用 SQLite。', 'storage', 'workspace.project'],
    ['当前项目的终端用什么？', '用 PowerShell。', 'shell', 'workspace.project'],
    ['我的编辑器是什么？', 'nvim', 'editor', 'user'],
    ['我写代码的编辑器用什么？', '选择 Neovim。', 'editor', 'user'],
  ];
  const negatives = [
    ['他说这个项目的包管理器是什么？', 'pnpm'],
    ['这个项目的包管理器是什么？', '不要用 npm'],
    ['这个项目的包管理器是什么？', 'pnpm 或 npm'],
    ['这个项目的数据库是什么？', 'pnpm'],
    ['某个项目的包管理器是什么？', 'pnpm'],
    ['这个项目的数据库是什么？', 'SQLite 还是 PostgreSQL？'],
    ['这个项目的数据库是什么？', '比如 SQLite'],
    ['这个项目的数据库是什么？', '使用 SQLite，暂时先这样'],
  ];
  for (const [question, answer, predicate, subject] of positives) {
    assert.deepEqual(encodeCandidates(answer), [], `baseline must not already encode ${answer}`);
    const found = contextualSleepCandidate(answer, { id: 'source', text: question });
    assert.equal(found?.claim.predicate, predicate);
    assert.equal(found?.claim.subject, subject);
    assert.equal(found?.status, 'candidate');
    assert.equal(found?.kind, 'inference');
  }
  for (const [question, answer] of negatives)
    assert.equal(contextualSleepCandidate(answer, { id: 'source', text: question }), null);
});

test('sleep candidates preserve sources, remain out of ordinary recall and never promote themselves', t => {
  const f = fixture(t), question = f.capture('这个项目的包管理器是什么？'), answer = f.capture('pnpm');
  const first = run(f);
  assert.equal(first.candidates, 1);
  const candidate = f.space.all().find(row => row.source.kind === 'local-context');
  assert.ok(candidate);
  assert.equal(candidate.text, 'pnpm');
  assert.equal(candidate.kind, 'inference');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.source.excerpt, answer.text);
  assert.equal(candidate.source.context.excerpt, question.text);
  assert.equal(packBackup(f.space).includes(question.text), false);
  assert.deepEqual(candidate.parents, [answer.id, question.id]);
  assert.equal(f.space.recall('pnpm', admin).picked.length, 0);
  assert.equal(f.space.consolidate(200, { deep: true }).promoted, 0);
  assert.equal(run(f).candidates, 0);
  assert.equal(f.space.all().filter(row => row.source.kind === 'local-context').length, 1);
});

test('reencoding does not cross sessions, event chunks, time gaps or retention', t => {
  const f = fixture(t, { config: { bufferHours: 1 } });
  f.capture('这个项目的数据库是什么？', 'a');
  f.capture('SQLite', 'b');
  f.capture('这个项目的包管理器是什么？', 'c', { eventId: 'same' });
  f.capture('pnpm', 'c', { eventId: 'same' });
  f.capture('我的编辑器是什么？', 'd');
  f.now += 31 * 60000;
  f.capture('nvim', 'd');
  f.capture('本项目的数据库是什么？', 'e');
  f.capture('SQLite', 'e');
  f.now += 2 * 3600000;
  const result = f.space.reencodeRecent({ from: new Date(f.now - 4 * 3600000).toISOString(),
    until: new Date(f.now).toISOString() });
  assert.equal(result.candidates, 0);
  assert.equal(f.space.all().some(row => row.source.kind === 'local-context'), false);
  const maintenance = f.space.maintenance();
  assert.ok(maintenance.expiredUnencoded >= 1);
  assert.equal(f.space.encodingStatus().expiredBeforeSleep, maintenance.expiredUnencoded);
});

test('partial failure is idempotent and forgotten candidates cannot reappear', t => {
  let fail = true;
  const f = fixture(t, { failpoint: phase => {
    if (phase === 'after-sleep-encoding-save' && fail) { fail = false; throw new Error('injected failure'); }
  } });
  f.capture('这个项目的包管理器是什么？');
  const answer = f.capture('pnpm');
  assert.throws(() => run(f), /injected failure/);
  assert.equal(f.space.all().filter(row => row.source.kind === 'local-context').length, 1);
  run(f);
  const candidates = f.space.all().filter(row => row.source.kind === 'local-context');
  assert.equal(candidates.length, 1);
  f.space.forget(candidates[0].id, admin);
  f.space.system.prepare('DELETE FROM sleep_encodings WHERE source_id=?').run(answer.id);
  run(f);
  assert.equal(f.space.all().some(row => row.source.kind === 'local-context'), false);
});

test('a candidate remains editable after its short-lived source buffers expire', t => {
  const f = fixture(t, { config: { bufferHours: 1 } });
  f.capture('这个项目的包管理器是什么？');
  f.capture('pnpm');
  run(f);
  const candidate = f.space.all().find(row => row.source.kind === 'local-context');
  f.now += 2 * 3600000;
  f.space.maintenance();
  assert.equal(f.space.db('L0').prepare('SELECT count(*) AS n FROM memories').get().n, 0);
  const approved = f.space.update(candidate.id, { status: 'active' }, candidate.revision, admin);
  assert.equal(approved.status, 'active');
  assert.equal(approved.kind, 'inference');
  assert.equal(f.space.consolidate(200, { deep: true }).promoted, 0);
});

test('independent evidence uses local calendar days even across one UTC date', t => {
  const oldTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz; });
  const f = fixture(t, { now: new Date(2026, 0, 1, 23, 58).getTime() });
  const first = f.capture('我喜欢简短回答。');
  f.now += 3 * 60000;
  const second = f.capture('我喜欢简短回答。');
  assert.equal(first.occurredAt.slice(0, 10), second.occurredAt.slice(0, 10));
  assert.equal(f.space.consolidate(200, { deep: true }).promoted, 1);
});
