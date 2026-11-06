import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { encodeCandidates, splitCapture, technicalClaim } from '../src/model.js';
import { TidalRuntime } from '../src/runtime.js';

const admin = { admin: true };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-encoding-'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const space = new MemorySpace(root, 'shared', { clock: () => now, config: { residentBudget: 0 } });
  t.after(() => { space.close(); rmSync(root, { recursive: true, force: true }); });
  let seq = 0;
  const capture = (text, sessionId = 'a') => {
    now += 60000;
    const source = space.capture({ text, sessionId, eventId: ++seq, at: new Date(now).toISOString() });
    space.organizePending(1, source.id);
    return source;
  };
  return { space, root, capture, advance: ms => { now += ms; } };
}

test('colloquial capture keeps tasks, facts, mixed clauses and negative statements distinct', () => {
  for (const text of ['把问题写进验收整合', '帮我把这段拆成两句', '明天下午三点开会'])
    assert.equal(encodeCandidates(text)[0]?.layer, 'L1', text);
  for (const text of ['以后默认用 pnpm', '这个项目用 SQLite 存储', '我用的是 PowerShell', '以后不要再用 npm，改成 pnpm'])
    assert.equal(encodeCandidates(text)[0]?.layer, 'L2', text);
  assert.deepEqual(encodeCandidates('项目用 SQLite，帮我修复迁移').map(item => item.layer), ['L2', 'L1']);
  assert.equal(technicalClaim('项目目前不使用 SQLite').polarity, 'negative');
  assert.equal(technicalClaim('项目 A 使用 npm'), null);
  assert.equal(technicalClaim('这个项目的前端使用 pnpm'), null);
  assert.equal(encodeCandidates('我今天完成了迁移')[0].category, 'event');
  for (const text of ['如果这个项目用 SQLite 会怎样？', '这个项目用 SQLite 吗？', '他说这个项目用 SQLite。',
    '“以后默认用 pnpm”', '不要记：以后默认用 pnpm', '```js\n项目使用 SQLite。\n```'])
    assert.deepEqual(encodeCandidates(text), [], text);
});

test('contextual changes require a unique explicit subject and preserve temporal versions', t => {
  const { space, capture } = fixture(t);
  capture('这个项目使用 npm。');
  const old = space.all().find(record => record.layer === 'L2');
  capture('改成 pnpm。');
  const current = space.all().find(record => record.claim?.value === 'pnpm');
  assert.ok(current);
  assert.equal(space.get(old.id, admin).status, 'superseded');
  assert.equal(space.get(old.id, admin).validUntil, current.validFrom);
  assert.equal(current.source.excerpt, '改成 pnpm。');
  assert.ok(current.source.contextSourceId);
  assert.equal(space.recall('npm', admin).picked.some(row => row.id === old.id), false);
  assert.ok(space.recall('npm', admin, { mode: 'as-of', asOf: old.validFrom }).picked.some(row => row.id === old.id));
  assert.ok(space.recall('npm', admin, { mode: 'history' }).picked.some(row => row.id === old.id));
  assert.throws(() => space.recall('npm', admin, { mode: 'as-of' }), { code: 'INVALID_TIME' });
  assert.deepEqual(encodeCandidates('改成 pnpm。', [
    { id: 'a', text: '这个项目使用 npm。' }, { id: 'b', text: '以后默认用 yarn。' },
  ]), []);
});

test('context does not cross sessions or silently overwrite protected knowledge', t => {
  const { space, capture } = fixture(t);
  capture('这个项目使用 npm。', 'a');
  capture('改成 pnpm。', 'b');
  assert.equal(space.all().filter(row => row.claim?.value === 'pnpm').length, 0);
  const old = space.all().find(row => row.layer === 'L2');
  space.update(old.id, { pinned: true }, old.revision, admin);
  capture('这个项目不要再用 npm，改成 pnpm。', 'a');
  assert.equal(space.get(old.id, admin).status, 'active');
  assert.equal(space.all().find(row => row.claim?.value === 'pnpm').status, 'review');
});

test('aliases survive rebuild and remain scoped; editing text invalidates old structured claims', t => {
  const { space, root, capture } = fixture(t);
  capture('这个项目使用 SQLite。');
  let record = space.all().find(row => row.layer === 'L2');
  record = space.update(record.id, { aliases: ['海蓝存储'] }, record.revision, admin);
  space.rebuildSearch();
  assert.ok(space.recall('海蓝存储', { sessionId: 'another' }).picked.some(row => row.id === record.id));
  const separate = new MemorySpace(root, 'separate');
  try { assert.equal(separate.recall('海蓝存储', admin).picked.length, 0); }
  finally { separate.close(); }
  record = space.update(record.id, { text: '不相关的新正文' }, record.revision, admin);
  assert.equal(record.claim, null);
});

test('exact workspace aliases retrieve mixed editor rewrites without equating vim and neovim', t => {
  const { root } = fixture(t);
  for (const [index, item] of [
    { text: '我写代码用 neovim。', alias: 'nvim', query: '编辑器是 nvim' },
    { text: '我的编辑器是 nvim。', alias: 'neovim', query: '写代码用 neovim' },
  ].entries()) {
    const space = new MemorySpace(root, `editor-${index}`, { config: { residentBudget: 0 } });
    try {
      const record = space.create({ layer: 'L2', text: item.text, aliases: [item.alias],
        kind: 'user_statement' }, admin);
      const unrelated = space.create({ layer: 'L2', text: '他以前使用 Vim。', aliases: ['vim'],
        kind: 'user_statement' }, admin);
      const result = space.recall(item.query, { sessionId: 'other' });
      assert.ok(result.picked.some(row => row.id === record.id && row.channel === 'query' &&
        row.reason === '工作区别名精确匹配'));
      assert.equal(result.picked.some(row => row.id === unrelated.id), false);
      assert.equal(space.get(record.id, admin).text, item.text);
    } finally { space.close(); }
  }
});

test('explicit task completion records an episode; expiration never fabricates completion', t => {
  const { space, capture, advance } = fixture(t);
  capture('请完成数据库迁移。');
  const task = space.all().find(row => row.layer === 'L1');
  capture('我今天完成了数据库迁移。');
  assert.equal(space.get(task.id, admin).status, 'completed');
  assert.ok(space.all().some(row => row.layer === 'L2' && row.parents.includes(task.id)));
  capture('请检查网络配置。');
  advance(25 * 3600000);
  space.maintenance();
  assert.equal(space.all().find(row => row.layer === 'L1' && row.text.includes('网络')).status, 'archived');
  assert.equal(space.all().some(row => row.layer === 'L2' && row.text.includes('网络')), false);
});

test('timeline counts stored scenes separately from records and filters each evidence time', t => {
  const { space, capture } = fixture(t);
  capture('我今天完成了迁移。');
  const from = space.now();
  capture('我今天完成了迁移。');
  const result = space.timeline({ query: '迁移', from }, { sessionId: 'b' });
  assert.equal(result.totalScenes, 2);
  assert.equal(result.totalRecords, 1);
  assert.equal(space.timeline({ query: '迁移', from: space.now() }, admin).totalScenes, 1);
  assert.match(result.coverage, /不能视作实际发生总次数/);
});

test('organization reports provenance eligibility without manufacturing L3', t => {
  const { space, capture } = fixture(t);
  space.create({ layer: 'L2', text: 'archived source knowledge', kind: 'historical', category: 'knowledge' }, admin);
  capture('今天天气不错');
  assert.equal(space.encodingStatus().reasons['no-explicit-rule'], 1);
  const result = space.consolidate(200, { deep: true });
  assert.equal(result.promoted, 0);
  assert.equal(result.eligibility.historicalOrInferred, 1);
  assert.equal(result.eligibility.accepted, 0);
});

test('long-message chunks preserve Unicode, code-fence exclusion and one event identity', async t => {
  const { root, space } = fixture(t);
  const cwd = join(root, 'workspace');
  const agent = { id: 'agent', session: { id: 'agent', header: { cwd }, snapshotEvents: () => [] } };
  const runtime = new TidalRuntime({ agents: { get: () => agent, list: () => [agent] }, logger: { warn() {} } },
    { dataRoot: root, bindings: [{ cwd, space: 'other' }] }, root);
  t.after(() => runtime.close());
  const text = '```\n' + '项目使用 MongoDB。\n'.repeat(1600) + '```\n这个项目用 SQLite 存储。';
  const chunks = splitCapture(text);
  assert.equal(chunks.map(chunk => chunk.text).join(''), text);
  assert.ok(chunks.every(chunk => chunk.text.isWellFormed()));
  assert.ok(splitCapture('`'.repeat(17000)).length > 1);
  runtime.onEvent(agent.session, { type: 'user/message', seq: 1, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  const saved = runtime.space('other').all().filter(row => row.layer === 'L2');
  assert.deepEqual(saved.map(row => row.text), ['这个项目用 SQLite 存储。']);
  assert.equal(runtime.lastError, null);
  assert.equal(space.all().length, 0);
  await runtime.close();
});
