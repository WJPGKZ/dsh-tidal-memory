import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { localCandidates, LAYERS } from '../src/model.js';
import { automaticBackup, packBackup, unpackBackup } from '../src/transfer.js';
import { TidalRuntime } from '../src/runtime.js';
import { corpus, probes } from './fixtures/recall.mjs';

const admin = { admin: true };
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-review-'));
  const space = new MemorySpace(root, 'test', { config });
  t.after(() => { space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, space };
}
const create = (space, text, extra = {}) => space.create({ layer: 'L3', text, status: 'active', ...extra }, admin);
const capture = (space, text, eventId = 1) => space.capture({ sessionId: 'a', eventId, text, role: 'user' });

test('local rules grow recallable episodes and work memory without a remember prefix, approval or a model', t => {
  const { space } = fixture(t);
  capture(space, '我偏好简短回答。\n我们决定采用 SQLite。\n项目使用 pnpm。\n不对，我用的是 PowerShell。\n这次任务先保持接口不变。');
  assert.equal(space.organizePending().organized, 5);
  const candidates = space.all().filter(r => r.layer !== 'L0');
  assert.deepEqual(new Set(candidates.map(r => r.source.rule)), new Set(['preference', 'decision', 'fact', 'correction', 'active-topic']));
  assert.ok(candidates.every(r => r.status === 'active' && r.text === r.source.excerpt && r.kind === 'user_statement'));
  assert.ok(candidates.some(r => r.layer === 'L1' && r.horizon === 'task'));
  assert.ok(candidates.some(r => r.layer === 'L2'));
  assert.ok(space.recall('pnpm', admin).picked.length > 0);
  assert.match(space.recall('pnpm', admin).text, /未人工核实/);
  space.organizePending();
  assert.equal(space.all().filter(r => r.layer !== 'L0').length, 5);
});

test('examples, questions, quoted text, code and requests not to remember are not candidates', () => {
  for (const text of ['项目使用 pnpm？', '如果我偏好短句，就这么说。',
    '> 我喜欢长句。', '例如：项目使用 npm。', '以后不要记住这段话。',
    '```text\n我喜欢咖啡\n```', '“项目使用 npm。”', '今天天气不错。']) {
    assert.deepEqual(localCandidates(text), [], text);
  }
});

test('automatic tool memories remain unverified, correctable and never self-protected', t => {
  const { space } = fixture(t);
  const actor = { sessionId: 'writer' };
  const first = space.create({ layer: 'L3', text: 'violet protocol', status: 'active',
    pinned: true, kind: 'user_statement', source: { kind: 'manual' } }, actor);
  assert.equal(first.status, 'active');
  assert.equal(first.kind, 'inference');
  assert.equal(first.pinned, false);
  assert.match(space.recall('violet protocol', actor).text, /未人工核实/);
  const corrected = space.update(first.id, { text: 'violet protocol revision', pinned: true, kind: 'user_statement' },
    first.revision, { sessionId: 'second-writer' });
  assert.equal(corrected.status, 'active');
  assert.equal(corrected.kind, 'inference');
  assert.equal(corrected.pinned, false);
  assert.equal(corrected.source.sessionId, 'second-writer');
  assert.equal(corrected.sources.length, 2);
  assert.equal(space.revisions(first.id, admin).at(-1).text, first.text);
  assert.equal(corrected.stability, 1);
  const confirmed = space.reinforce(first.id, 'manual-confirmation', admin);
  assert.throws(() => space.update(first.id, { text: 'rewrite' }, confirmed.revision, actor), /不能改写/);
  assert.throws(() => space.create({ layer: 'L0', text: 'bypass' }, actor), /L1–L3/);
});

test('automatic correction protects manual corrections and merged user evidence', t => {
  const { space } = fixture(t), actor = { sessionId: 'writer' };
  const first = space.create({ layer: 'L3', text: 'manual correction target' }, actor);
  const corrected = space.update(first.id, { text: 'human corrected target' }, first.revision, admin);
  assert.equal(corrected.source.kind, 'manual');
  assert.throws(() => space.update(first.id, { text: 'rewrite' }, corrected.revision, actor), /不能改写/);
  const other = space.create({ layer: 'L2', text: '项目使用 pnpm。', occurredAt: space.now() }, actor);
  capture(space, '项目使用 pnpm。');
  space.organizePending();
  const merged = space.get(other.id, admin);
  assert.ok(merged.sources.some(source => source.kind === 'local-rule'));
  assert.throws(() => space.update(other.id, { text: 'rewrite' }, merged.revision, actor), /不能改写/);
});

test('automatic saving never overrides conflicting facts or revives historical candidates', t => {
  const { space } = fixture(t), actor = { sessionId: 'writer' };
  const first = create(space, 'violet protocol original', { factKey: 'protocol' });
  const conflict = space.create({ layer: 'L3', text: 'violet protocol changed', factKey: 'protocol' }, actor);
  assert.equal(conflict.status, 'review');
  assert.equal(space.get(first.id, admin).status, 'active');
  assert.equal(space.recall('violet protocol changed', actor).picked.some(r => r.id === conflict.id), false);
  const historical = create(space, 'historical candidate', { status: 'candidate' });
  assert.equal(space.create({ layer: 'L3', text: historical.text }, actor).status, 'candidate');
});

test('idle tasks do not acquire a mandatory review gate after seven days', t => {
  const { space } = fixture(t);
  const task = create(space, 'unfinished violet task', { layer: 'L1' });
  space.clock = () => Date.parse(task.createdAt) + 8 * 86400000;
  space.maintenance();
  assert.equal(space.get(task.id, admin).status, 'active');
  assert.ok(space.recall('unfinished violet task', admin).picked.some(r => r.id === task.id));
  capture(space, '记住：');
  space.organizePending();
  assert.equal(space.all().some(r => r.status === 'review'), false);
  assert.ok(space.errors.some(error => error.code === 'EMPTY_REMEMBER'));
});

test('partial candidate writes retry idempotently before processing their source', t => {
  const { space } = fixture(t);
  const source = capture(space, '我偏好简短回答。\n项目使用 pnpm。');
  const original = space.create.bind(space);
  let calls = 0;
  const stub = t.mock.method(space, 'create', (...args) => {
    if (++calls === 2) throw new Error('synthetic interruption');
    return original(...args);
  });
  assert.throws(() => space.organizePending(), /synthetic interruption/);
  assert.equal(space.get(source.id, admin).status, 'pending');
  stub.mock.restore();
  space.organizePending();
  const candidates = space.all().filter(r => r.layer !== 'L0');
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(r => r.revision === 1));
});

test('manual L0 entries do not starve the bounded session candidate queue', t => {
  const { space } = fixture(t);
  create(space, 'manually pending', { layer: 'L0', status: 'pending' });
  capture(space, '我偏好简短回答。');
  const result = space.organizePending(1);
  assert.equal(result.organized, 1);
});

test('L0 has no new views or revision copies and never enters new backups', t => {
  const { root, space } = fixture(t);
  const raw = 'RAW_BUFFER_CANARY_482';
  const source = capture(space, `我偏好简短回答。\n${raw}`);
  space.organizePending();
  assert.deepEqual(readdirSync(join(space.directory, LAYERS.L0.directory, 'views')), []);
  assert.equal(space.db('L0').prepare('SELECT count(*) AS n FROM revisions').get().n, 0);
  const candidate = space.all().find(r => r.layer === 'L2');
  // Simulate old derived provenance that copied the entire source message.
  space.update(candidate.id, { source: { kind: 'derived', parentId: source.id, excerpt: raw } }, candidate.revision, admin);
  for (const password of ['', 'synthetic-password-123']) {
    const snapshot = unpackBackup(packBackup(space, password), password);
    assert.ok(snapshot.records.every(r => r.layer !== 'L0'));
    assert.ok(snapshot.revisions.every(r => r.layer !== 'L0'));
    assert.equal(JSON.stringify(snapshot).includes(raw), false);
    assert.equal(snapshot.records[0].text, '我偏好简短回答。');
  }
  automaticBackup(space, root);
  const directory = join(root, 'backups', 'test');
  assert.equal(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8').includes(raw), false);
});

test('view rebuild removes generated L0 copies but preserves user-authored files', t => {
  const { space } = fixture(t);
  const source = capture(space, 'synthetic transient text');
  const dir = join(space.directory, LAYERS.L0.directory, 'views');
  const generated = join(dir, `${source.id}.md`);
  const authored = join(dir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md');
  writeFileSync(generated, '<!-- Generated read-only view. Edit through Tidal Memory UI. -->\nraw text');
  writeFileSync(authored, 'User-authored text');
  space.rebuildViews();
  assert.equal(existsSync(generated), false);
  assert.equal(readFileSync(authored, 'utf8'), 'User-authored text');
});

test('startup leaves existing projections untouched; maintenance does not scan all records', t => {
  const { root, space } = fixture(t);
  const record = create(space, 'startup projection');
  const view = join(space.directory, LAYERS.L3.directory, 'views', `${record.id}.md`);
  utimesSync(view, new Date('2000-01-01'), new Date('2000-01-01'));
  const stamp = statSync(view).mtimeMs;
  space.close();
  const next = new MemorySpace(root, 'test');
  try {
    assert.equal(statSync(view).mtimeMs, stamp);
    next.all = () => { throw new Error('unbounded scan'); };
    assert.equal(next.maintenance().expiredBuffers, 0);
  } finally { next.close(); }
});

test('absolute and relative recall gates exclude weak matches without losing exact ones', t => {
  const { space } = fixture(t, { relativeFloor: 0.95, residentMode: 'pinned' });
  const best = create(space, 'alpha beta gamma delta');
  const weak = create(space, 'alpha beta unrelated');
  const result = space.recall('alpha beta gamma delta', admin);
  assert.ok(result.picked.some(r => r.id === best.id));
  assert.ok(!result.picked.some(r => r.id === weak.id));
  assert.ok(result.excluded.some(r => r.id === weak.id && r.reason === '低于相关性门槛'));
  const none = space.recall('alpha ocean wallpaper audio typography', admin);
  assert.equal(none.text, '');
  assert.ok(space.recall('delta', admin).picked.some(r => r.id === best.id));
});

test('corpus-wide common words do not qualify solely by matching a one-word query', t => {
  const { space } = fixture(t, { residentMode: 'pinned' });
  for (let i = 0; i < 20; i++) create(space, `routine commonword record ${i}`);
  const distinctive = create(space, 'uniqueidentifier exceptional');
  assert.equal(space.recall('commonword', admin).picked.length, 0);
  assert.equal(space.recall('uniqueidentifier', admin).picked[0].id, distinctive.id);
});

test('labeled lexical and abstention fixtures remain reproducible on a small corpus', t => {
  const { space } = fixture(t, { residentMode: 'pinned' });
  const keys = new Map();
  for (const item of corpus(100)) keys.set(create(space, item.text, { layer: item.layer }).id, item.key);
  for (const [query, expected, group] of probes) {
    if (group === 'semantic') continue;
    const picked = space.recall(query, admin).picked.map(r => keys.get(r.id));
    assert.deepEqual(picked, expected, query);
  }
});

test('workspace aliases bridge explicit editor name variants in lexical recall', t => {
  const { space } = fixture(t);
  const editor = create(space, '我写代码用 neovim。', { aliases: ['nvim'] });
  assert.ok(space.recall('nvim', admin).picked.some(item => item.id === editor.id && item.matched));
});

test('strict and phrase search use local FTS and versioned rebuild repairs stale entries', t => {
  const { space } = fixture(t);
  const exact = create(space, 'alpha beta');
  create(space, 'beta alpha');
  create(space, 'alpha');
  assert.equal(space.searchRecords('alpha beta', { mode: 'all' }).length, 2);
  assert.deepEqual(space.searchRecords('alpha beta', { mode: 'phrase' }).map(r => r.id), [exact.id]);
  space.db('L3').exec("DELETE FROM search; DELETE FROM index_state;");
  assert.throws(() => space.recall('alpha', admin), e => e.code === 'INDEX_REBUILD_REQUIRED');
  assert.equal(space.searchIndexStatus().find(r => r.layer === 'L3').current, false);
  space.rebuildSearch();
  assert.equal(space.searchIndexStatus().every(r => r.current), true);
  assert.equal(space.searchRecords('alpha').length, 3);
  space.db('L3').exec('DROP TABLE search');
  space.rebuildSearch();
  assert.equal(space.searchRecords('alpha').length, 3);
});

test('record indexing is not truncated to the 64-term query limit', t => {
  const { space } = fixture(t);
  const record = create(space, Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + ' laterevidence');
  assert.equal(space.recall('laterevidence', admin).picked[0].id, record.id);
  space.rebuildSearch();
  assert.equal(space.recall('laterevidence', admin).picked[0].id, record.id);
});

test('index rebuild rolls back the current layer on failure', t => {
  const { space } = fixture(t);
  const source = capture(space, 'alpha buffer');
  space.failpoint = point => { if (point === 'before-index-commit') throw new Error('index interruption'); };
  assert.throws(() => space.rebuildSearch(), /index interruption/);
  assert.deepEqual(space.searchRecords('alpha', { layer: 'L0' }).map(r => r.id), [source.id]);
});

test('runtime opens spaces lazily, skips assistant capture and isolates lock contention', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tidal-runtime-review-'));
  const cwd = join(root, 'workspace');
  const config = { dataRoot: root, autoBackup: false, bindings: [{ cwd, space: 'test' }] };
  const session = { id: 'session', header: { cwd } };
  const agent = { id: session.id, session, status: 'idle' };
  const ctx = { agents: { list: () => [agent], get: () => agent },
    settings: { describe: () => [] }, logger: { warn() {} } };
  const runtime = new TidalRuntime(ctx, config, root);
  let owner;
  t.after(async () => { owner?.close(); await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(runtime.spaces.size, 0);
  assert.equal(existsSync(join(root, 'spaces', 'default')), false);
  owner = new MemorySpace(root, 'test');
  const status = await runtime.api('GET', '/status', new URLSearchParams('space=test'));
  assert.equal(status.unavailable, true);
  assert.equal(status.spaceError.code, 'SPACE_BUSY');
  assert.equal(runtime.spaces.has('test'), false);
  const maintenance = await runtime.requestMaintenance(true, 'test');
  assert.equal(maintenance.results[0].unavailable, true);
  assert.throws(() => runtime.forAgent(agent), e => e.code === 'SPACE_BUSY');
  owner.close();
  const available = await runtime.api('GET', '/status', new URLSearchParams('space=test'));
  assert.equal(available.unavailable, undefined);
  assert.equal(runtime.spaceErrors.size, 1);
  runtime.onEvent(session, { type: 'assistant/message', seq: 1, time: Date.now(),
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '我喜欢自动编造偏好。' }] } } });
  assert.equal(runtime.space('test').all().length, 0);
  assert.equal(runtime.spaceErrors.size, 0);
  runtime.onEvent(session, { type: 'user/message', seq: 2, time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我偏好简短回答。' }] } });
  assert.equal(runtime.space('test').all().filter(r => r.status === 'active').length, 1);
});
