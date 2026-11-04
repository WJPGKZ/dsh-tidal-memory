import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { importPreview, applyImport, packBackup, restoreBackup } from '../src/transfer.js';
import { configOf, defaultImportance } from '../src/model.js';

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

test('effectiveness defaults are configurable without overwriting explicit existing settings', () => {
  assert.equal(configOf().tokenBudget, 48000);
  assert.equal(configOf().maxRecall, 30);
  assert.equal(configOf({ tokenBudget: 12000 }).tokenBudget, 12000);
  assert.equal(configOf({ tokenBudget: 192000, maxRecall: 100 }).maxRecall, 100);
});
