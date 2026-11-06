import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { importPreview, applyImport, packBackup, restoreBackup } from '../src/transfer.js';
import { configOf, defaultImportance, localCandidates, classifyRememberDirective, normalizeRecord,
  consolidationSimilarity, consolidationConflict } from '../src/model.js';

const admin = { admin: true };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-effectiveness-'));
  const space = new MemorySpace(root, 'test', options);
  t.after(() => { space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, space };
}
const create = (space, text, extra = {}) => space.create({
  text, layer: 'L2', kind: 'user_statement', status: 'active', ...extra,
}, admin);

test('effective L3 residency has independent capacity and does not masquerade as evidence', t => {
  const { space } = fixture(t, { config: { maxRecall: 1 } });
  for (let i = 0; i < 10; i++) create(space, `stable preference ${i}`, { layer: 'L3' });
  for (const status of ['review', 'candidate', 'superseded', 'archived']) {
    create(space, `excluded ${status}`, { layer: 'L3', status });
  }
  create(space, 'expired', { layer: 'L3', validUntil: '2000-01-01' });
  const query = create(space, 'violet protocol');
  const result = space.recall('violet protocol', { sessionId: 's' }, { evidenceId: 'turn1' });
  assert.equal(result.picked.filter(item => item.channel === 'resident').length, 10);
  assert.ok(result.picked.some(item => item.id === query.id));
  assert.ok(result.estimatedTokens <= result.budget);
  assert.ok(space.all().filter(item => item.layer === 'L3').every(item => item.recallCount === 0));
  space.setConfig({ ...space.config, residentBudget: 0 });
  assert.equal(space.recall('unrelated seashell', admin).text, '');
  assert.ok(space.recall('stable preference 7', admin).picked.length);
});

test('evidence retrieval is turn-idempotent, crash-recoverable and distinct from confirmation', t => {
  const { root, space } = fixture(t);
  const record = create(space, 'violet protocol');
  const call = () => space.recall('violet protocol', { sessionId: 's' }, { evidenceId: 'turn1' });
  call(); call();
  let saved = space.get(record.id, admin);
  assert.equal(saved.recallCount, 1);
  assert.equal(saved.stability, 1.1);
  assert.equal(saved.reinforcedAt, null);
  assert.match(call().text, /未人工核实/);
  space.failpoint = name => { if (name === 'after-reinforcement-write') throw new Error('simulated interruption'); };
  assert.throws(() => space.recall('violet protocol', { sessionId: 's' }, { evidenceId: 'turn2' }), /interruption/);
  space.failpoint = () => {};
  space.recover();
  space.recall('violet protocol', { sessionId: 's' }, { evidenceId: 'turn2' });
  saved = space.get(record.id, admin);
  assert.equal(saved.recallCount, 2);
  assert.ok(saved.lastRecalledAt);
  restoreBackup(root, 'restored', packBackup(space), '', space.config);
  const restored = new MemorySpace(root, 'restored');
  try { assert.equal(restored.get(record.id, admin).recallCount, 2); }
  finally { restored.close(); }
});

test('explicit provenance supports two hops without admitting unrelated or private content', t => {
  const { space } = fixture(t, { config: { maxRecall: 1 } });
  const seed = create(space, 'violet protocol');
  const child = create(space, 'second evidence', { parents: [seed.id] });
  const grandchild = create(space, 'third evidence', { parents: [child.id] });
  create(space, 'unrelated filler');
  create(space, 'unverified descendant', { parents: [seed.id], status: 'review' });
  const result = space.recall('violet protocol', admin);
  assert.deepEqual(new Set(result.picked.map(item => item.id)), new Set([seed.id, child.id, grandchild.id]));
  assert.equal(result.picked.filter(item => item.channel === 'association').length, 2);
});

test('heading imports group paragraphs, preserve all content, separate topics and assign category weights', t => {
  const body = '鲸鱼资料。'.repeat(800);
  const plan = importPreview([{ name: 'notes.md',
    text: `# 偏好\n\n喜欢蓝色。\n\n偏好简短回答。\n# 知识\n\n${body}\n# 日常\n\n今天散步。` }]);
  assert.equal(plan.candidates[0].text, '喜欢蓝色。\n\n偏好简短回答。');
  assert.equal(plan.candidates[0].category, 'preference');
  const knowledge = plan.candidates.filter(item => item.category === 'knowledge');
  assert.equal(knowledge.map(item => item.text).join(''), body);
  assert.ok(knowledge.every(item => Buffer.byteLength(item.text) <= 4000));
  assert.equal(plan.candidates.at(-1).layer, 'L2');
  const { space } = fixture(t);
  applyImport(space, plan, plan.candidates.map(item => item.importId));
  const imported = space.all().find(item => item.category === 'preference');
  assert.equal(imported.importance, defaultImportance('preference'));
  assert.equal(imported.status, 'candidate');
  assert.equal(imported.pinned, false);
  assert.equal(space.recall('喜欢蓝色', admin).text, '');
});

test('idle consolidation needs independent dated user evidence, never upgrades mere repeated reads', t => {
  const { space } = fixture(t);
  const extra = { category: 'agreement', horizon: 'long_term' };
  const a = create(space, 'default orchid convention', { ...extra, occurredAt: '2026-01-01',
    source: { kind: 'session', role: 'user', sessionId: 'a', eventId: '1' } });
  const b = create(space, 'default orchid convention', { ...extra, occurredAt: '2026-01-02',
    source: { kind: 'session', role: 'user', sessionId: 'b', eventId: '2' } });
  create(space, 'hypothetical orchid convention', { ...extra, kind: 'inference' });
  create(space, 'daily backup happened', { occurredAt: '2026-01-01' });
  create(space, 'daily backup happened', { occurredAt: '2026-01-02' });
  assert.equal(space.consolidate().promoted, 1);
  const target = space.all().find(item => item.layer === 'L3');
  assert.ok(target.parents.includes(a.id) && target.parents.includes(b.id));
  assert.equal(space.consolidate().promoted, 0);
  assert.equal(space.all().filter(item => item.text === 'daily backup happened').length, 2);
  assert.equal(space.all().filter(item => item.layer === 'L3').length, 1);
});

test('forgetting archives only long-held low-use episodes and protects newly imported old history', t => {
  let now = Date.parse('2026-01-01');
  const { space } = fixture(t, { clock: () => now, config: { autoArchive: true } });
  const old = create(space, 'old unused episode');
  const important = create(space, 'important episode', { importance: 0.9 });
  const used = create(space, 'orchid protocol');
  space.recall('orchid protocol', { sessionId: 'a' }, { evidenceId: '1' });
  now += 241 * 86400000;
  const imported = create(space, 'newly imported old episode', { occurredAt: '2000-01-01' });
  assert.equal(space.maintenance().forgottenEpisodes, 1);
  assert.equal(space.get(old.id, admin).status, 'archived');
  for (const item of [important, used, imported]) assert.equal(space.get(item.id, admin).status, 'active');
});

test('repeated unspecified remember directives consolidate only when a whole-statement stable rule applies', t => {
  const { space } = fixture(t);
  for (const day of ['01', '02']) {
    space.capture({ sessionId: 's', eventId: day, role: 'user', at: `2026-01-${day}T12:00:00Z`,
      text: '记住：项目使用 pnpm。' });
    space.organizePending();
  }
  assert.equal(space.all().filter(item => item.layer === 'L2').length, 2);
  assert.equal(space.consolidate().promoted, 1);
  const target = space.all().find(item => item.layer === 'L3');
  assert.equal(target.text, '项目使用 pnpm。');
  assert.equal(target.category, 'knowledge');
  assert.equal(target.reinforcedAt, null);
});

test('ordinary user statements create long-term memory and expiring work memory without a model', t => {
  let now = Date.parse('2026-01-01T12:00:00Z');
  const { space } = fixture(t, { clock: () => now });
  const capture = (eventId, text) => space.capture({
    sessionId: 's', eventId, role: 'user', at: new Date(now).toISOString(), text,
  });
  capture('1', '我更喜欢简洁的回答。');
  capture('2', '我现在正在处理记忆插件的数据迁移。');
  capture('3', '请帮我检查一下数据导入。');
  capture('4', '你喜欢什么样的回答？');
  assert.equal(space.organizePending().organized, 3);
  const memories = space.all().filter(item => item.layer !== 'L0');
  const preference = memories.find(item => item.text === '我更喜欢简洁的回答。');
  assert.equal(preference.category, 'preference');
  assert.equal(preference.horizon, 'long_term');
  const activeTopic = memories.find(item => item.text === '我现在正在处理记忆插件的数据迁移。');
  assert.equal(activeTopic.layer, 'L1');
  const requestedTask = memories.find(item => item.text === '请帮我检查一下数据导入。');
  assert.equal(requestedTask.layer, 'L1');
  assert.equal(Date.parse(requestedTask.validUntil), now + 24 * 3600000);
  assert.equal(memories.some(item => item.text.includes('你喜欢什么样')), false);
  now += 25 * 3600000;
  space.maintenance();
  assert.equal(space.get(activeTopic.id, admin).status, 'archived');
  assert.equal(space.get(requestedTask.id, admin).status, 'archived');
});

test('daily deep consolidation groups paraphrased preferences and sends contradictory claims to review', t => {
  const { space } = fixture(t);
  const capture = (eventId, day, text) => {
    space.capture({ sessionId: 's', eventId, role: 'user', at: `2026-01-${day}T12:00:00Z`, text });
    space.organizePending();
  };
  capture('1', '01', '我更喜欢简洁的回答。');
  capture('2', '02', '我偏好简明的答复。');
  capture('3', '03', '我不喜欢简洁的回答。');
  const result = space.consolidate(5000, { deep: true });
  assert.equal(result.promoted, 0);
  assert.ok(result.conflicts >= 2);
  assert.ok(space.all().filter(item => item.layer === 'L2').every(item => item.status === 'review'));
  assert.equal(space.all().filter(item => item.layer === 'L3').length, 0);
});

test('deep consolidation is idempotent and preserves distinct dated evidence', t => {
  const { space } = fixture(t);
  for (const [eventId, day, text] of [
    ['1', '01', '我更喜欢简洁的回答。'],
    ['2', '02', '我偏好简明的答复。'],
  ]) {
    space.capture({ sessionId: 's', eventId, role: 'user', at: `2026-01-${day}T12:00:00Z`, text });
    space.organizePending();
  }
  assert.equal(space.consolidate(5000, { deep: true }).promoted, 1);
  const target = space.all().find(item => item.layer === 'L3');
  assert.equal(target.category, 'preference');
  assert.ok(target.parents.length >= 2);
  assert.deepEqual(new Set(target.sources.map(source => source.original?.eventId).filter(Boolean)), new Set(['1', '2']));
  assert.equal(space.consolidate(5000, { deep: true }).promoted, 0);
});

test('effectiveness defaults are configurable without overwriting explicit existing settings', () => {
  assert.equal(configOf().tokenBudget, 48000);
  assert.equal(configOf().maxRecall, 30);
  assert.equal(configOf().dailyConsolidateAt, '03:00');
  assert.equal(configOf().workingHours, 24);
  assert.equal(configOf({ tokenBudget: 12000 }).tokenBudget, 12000);
  assert.equal(configOf({ tokenBudget: 192000, maxRecall: 100 }).maxRecall, 100);
  assert.equal(configOf({ workingHours: 0 }).workingHours, 0);
  for (const dailyConsolidateAt of ['3:00', '24:00', '00:60', null]) {
    assert.throws(() => configOf({ dailyConsolidateAt }), { code: 'INVALID_CONFIG' });
  }
});

test('capture keeps all qualifying sentences and distinguishes ongoing work from standing instructions', () => {
  const statements = Array.from({ length: 40 }, (_, i) => `我喜欢第${i}种花。`).join('');
  assert.equal(localCandidates(statements).length, 40);
  for (const text of ['请以后回答保持简洁。', '我现在更喜欢简洁的回答。']) {
    const [item] = localCandidates(text);
    assert.equal(item.layer, 'L2', text);
    assert.equal(item.horizon, 'long_term', text);
  }
  assert.equal(localCandidates('我希望你先检查数据。')[0].layer, 'L1');
  assert.equal(localCandidates('然后检查构建错误。')[0].layer, 'L1');
  assert.equal(localCandidates('以后周报发到邮箱，不要发群里。')[0].rule, 'agreement');
  assert.equal(localCandidates('我写代码用 neovim。')[0].rule, 'fact');
  assert.equal(localCandidates('编辑器是 nvim。')[0].rule, 'fact');
  assert.equal(localCandidates('我昨天完成了这个任务。')[0].category, 'event');
  assert.equal(classifyRememberDirective('记住：昨天完成了这个任务。').layer, 'L2');
  for (const text of ['我不知道你喜欢什么。', '我不确定项目使用 pnpm。', '我喜欢咖啡吗']) {
    assert.deepEqual(localCandidates(text), [], text);
  }
});

test('working lifetime renews on new evidence only, can be disabled, and never reopens completed tasks', t => {
  let now = Date.parse('2026-03-01T12:00:00Z');
  const { space } = fixture(t, { clock: () => now, config: { workingHours: 1 } });
  const capture = eventId => {
    space.capture({ sessionId: 's', eventId, text: '请检查迁移。', at: new Date(now).toISOString() });
    space.organizePending();
    return space.all().find(item => item.layer === 'L1');
  };
  let item = capture('1');
  const expiry = item.validUntil;
  assert.equal(capture('1').revision, item.revision);
  now += 30 * 60000;
  item = capture('2');
  assert.ok(item.validUntil > expiry);
  now += 2 * 3600000;
  space.maintenance();
  assert.ok(space.get(item.id, admin).expiredAt);
  item = capture('3');
  assert.equal(item.status, 'active');
  assert.equal(item.expiredAt, null);
  space.update(item.id, { status: 'completed' }, item.revision, admin);
  now += 2 * 3600000;
  assert.equal(capture('4').status, 'completed');
  space.setConfig({ ...space.config, workingHours: 0 });
  space.capture({ sessionId: 's', eventId: '5', text: '请整理索引。' });
  space.organizePending();
  assert.equal(space.all().find(record => record.text === '请整理索引。' && record.layer === 'L1').validUntil, null);
});

test('deep equivalence preserves order, subjects, qualifiers, alternatives and programming-language symbols', () => {
  assert.equal(consolidationSimilarity('我更喜欢简洁的回答。', '我偏好简明的答复。'), 1);
  for (const [a, b] of [
    ['我习惯简短回答', '我喜欢简短回答'],
    ['我喜欢苹果', '我喜欢苹果和梨'],
    ['我们喜欢简短回答', '我喜欢简短回答'],
    ['项目使用 C++', '项目使用 C#'],
    ['Alice helps Bob', 'Bob helps Alice'],
    ['项目可能使用 SQLite', '项目使用 SQLite'],
    ['项目使用甲方案', '项目使用乙方案'],
  ]) assert.equal(consolidationSimilarity(a, b), 0, `${a} / ${b}`);
  assert.ok(consolidationConflict('项目端口是3000', '项目端口是4000'));
  assert.ok(consolidationConflict('我喜欢简短回答', '我不喜欢简短回答'));
  assert.equal(consolidationConflict('红色项目端口是3000', '蓝色项目端口是4000'), false);
});

test('deep conflicts include current L3 and remain blocked until conflicting review records are resolved', t => {
  const { space } = fixture(t);
  const old = create(space, '项目端口是3000', { layer: 'L3', category: 'knowledge' });
  const incoming = create(space, '项目端口是4000', { category: 'knowledge', horizon: 'unspecified' });
  const result = space.consolidate(1, { deep: true });
  assert.equal(result.conflicts, 2);
  assert.equal(space.get(old.id, admin).status, 'review');
  assert.equal(space.get(incoming.id, admin).status, 'review');
  assert.equal(space.recall('项目端口', admin).text, '');
  const next = create(space, '项目端口是4000', { category: 'knowledge', horizon: 'long_term', occurredAt: '2026-03-02' });
  assert.equal(space.consolidate(1, { deep: true }).conflicts, 1);
  assert.equal(space.get(next.id, admin).status, 'review');
});

test('light consolidation cannot publish an exact repeated claim contradicting existing L3', t => {
  const { space } = fixture(t);
  const old = create(space, '项目端口是3000', { layer: 'L3', category: 'knowledge' });
  for (const day of ['01', '02']) create(space, '项目端口是4000', {
    category: 'knowledge', horizon: 'unspecified', occurredAt: `2026-03-${day}`,
    source: { kind: 'session', role: 'user', sessionId: 's', eventId: day },
  });
  const result = space.consolidate(1);
  assert.equal(result.promoted, 0);
  assert.equal(result.conflicts, 3);
  assert.equal(space.get(old.id, admin).status, 'review');
});

test('light consolidation advances the cursor and sees exact corroboration across batch boundaries', t => {
  const { space } = fixture(t);
  const seed = (id, text, day) => space.persist({
    ...normalizeRecord({ layer: 'L2', text, category: 'knowledge', kind: 'user_statement',
      status: 'active', horizon: 'unspecified', occurredAt: `2026-03-${day}`,
      source: { kind: 'session', role: 'user', sessionId: 's', eventId: id } }, space.now()),
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  });
  seed('1', 'project uses orchid', '01');
  seed('2', 'unrelated item', '01');
  seed('3', 'project uses orchid', '02');
  assert.equal(space.consolidate(1).promoted, 1);
  const firstCursor = space.system.prepare("SELECT value FROM metadata WHERE key='consolidation-cursor'").get().value;
  space.consolidate(1);
  assert.notEqual(space.system.prepare("SELECT value FROM metadata WHERE key='consolidation-cursor'").get().value, firstCursor);
  space.consolidate(1);
  assert.equal(space.system.prepare("SELECT value FROM metadata WHERE key='consolidation-cursor'").get().value, '');
});

test('deep consolidation visits records beyond 5000 and preserves more than 40 provenance links', t => {
  const { space } = fixture(t);
  for (let i = 0; i < 5065; i++) {
    const eligible = i >= 5000;
    space.persist({
      ...normalizeRecord({ layer: 'L2', text: eligible ? 'project uses orchid' : `filler ${i}`,
        kind: 'user_statement', status: 'active', category: eligible ? 'knowledge' : 'event',
        horizon: eligible ? 'unspecified' : 'event',
        occurredAt: new Date(Date.UTC(2026, 0, 1 + (eligible ? i - 5000 : 0))).toISOString(),
        source: { kind: 'session', role: 'user', sessionId: 's', eventId: String(i) } }, space.now()),
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    });
  }
  const result = space.consolidate(5000, { deep: true });
  assert.equal(result.inspected, 5065);
  assert.equal(result.truncated, false);
  assert.equal(result.promoted, 1);
  assert.equal(space.all().find(item => item.layer === 'L3').parents.length, 65);
  assert.equal(space.consolidate(5000, { deep: true }).promoted, 0);
});

for (const stage of ['after-consolidation-prepare', 'after-consolidation-write']) {
  test(`consolidation recovers all evidence after ${stage} without duplicate promotion`, t => {
    const { space } = fixture(t);
    for (const day of ['01', '02']) create(space, 'project uses orchid', {
      category: 'knowledge', horizon: 'unspecified', occurredAt: `2026-03-${day}`,
      source: { kind: 'session', role: 'user', sessionId: 's', eventId: day },
    });
    space.failpoint = name => { if (name === stage) throw new Error('interrupted'); };
    assert.throws(() => space.consolidate(200, { deep: true }), /interrupted/);
    space.failpoint = () => {};
    space.recover();
    const promoted = space.all().filter(item => item.layer === 'L3');
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].parents.length, 2);
    assert.ok(promoted[0].sources.some(source => source.eventId === '02'));
    assert.equal(space.consolidate(200, { deep: true }).promoted, 0);
  });
}

test('derived expiry and forgotten provenance are respected by deep consolidation and restored copies', t => {
  const { root, space } = fixture(t);
  const expiry = '2099-01-01T00:00:00.000Z';
  for (const day of ['01', '02']) create(space, 'project uses orchid', {
    category: 'knowledge', horizon: 'unspecified', occurredAt: `2026-03-${day}`, validUntil: expiry,
    source: { kind: 'session', role: 'user', sessionId: 's', eventId: day },
  });
  const before = packBackup(space);
  space.consolidate(200, { deep: true });
  const target = space.all().find(item => item.layer === 'L3');
  assert.equal(target.validUntil, expiry);
  space.forget(target.id, admin);
  assert.equal(space.consolidate(200, { deep: true }).skipped, 1);
  assert.equal(space.all().filter(item => item.layer === 'L3').length, 0);
  restoreBackup(root, 'copy', before, '', space.config);
  const copy = new MemorySpace(root, 'copy');
  try { assert.equal(copy.consolidate(200, { deep: true }).promoted, 1); }
  finally { copy.close(); }
});
