import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemorySpace } from '../src/store.js';
import { classifyRememberDirective, configOf, hash, LAYERS } from '../src/model.js';
import { applyImport, importPreview, packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const admin = { admin: true };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-test-'));
  let space = new MemorySpace(root, 'test', options);
  const owned = [];
  t.after(() => { for (const item of owned) item.close(); space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, space, own(item) { owned.push(item); return item; }, replace(next) { space.close(); space = next; } };
}
function create(space, text, extra = {}) {
  return space.create({ layer: 'L3', text, scope: 'space', status: 'active', kind: 'user_statement',
    source: { kind: 'manual' }, ...extra }, admin);
}

test('four independent SQLite stores and a private store persist across restart', t => {
  const f = fixture(t);
  for (const layer of Object.keys(LAYERS)) {
    create(f.space, `synthetic ${layer}`, { layer });
    assert.ok(existsSync(join(f.space.directory, LAYERS[layer].directory, LAYERS[layer].file)));
  }
  f.space.close();
  const next = new MemorySpace(f.root, 'test');
  f.replace(next);
  assert.equal(next.all().length, 4);
});
test('legacy layer schemas migrate pinned records into an indexed resident field', t => {
  const f = fixture(t);
  const record = create(f.space, 'fixed long-term rule', { layer: 'L3', pinned: true });
  f.space.db('L3').exec('DROP INDEX by_status_pinned; ALTER TABLE memories DROP COLUMN pinned; PRAGMA user_version=1;');
  f.space.close();
  const next = new MemorySpace(f.root, 'test');
  f.replace(next);
  assert.equal(next.get(record.id, admin).pinned, true);
  assert.equal(next.db('L3').prepare('SELECT pinned FROM memories WHERE id=?').get(record.id).pinned, 1);
});
test('same workspace shares across sessions and merges duplicate provenance, without reinforcement', t => {
  const { space } = fixture(t);
  const first = space.create({ layer: 'L3', text: '使用蓝色主题' }, { sessionId: 'session-a' });
  const second = space.create({ layer: 'L3', text: '使用蓝色主题' }, { sessionId: 'session-b' });
  assert.equal(first.id, second.id);
  assert.equal(space.all().length, 1);
  assert.equal(second.sources.length, 2);
  assert.equal(second.stability, 1);
  assert.equal(space.get(first.id, { sessionId: 'session-b' }).text, first.text);
  assert.equal(second.status, 'active');
});
test('different workspaces have independent stores and configuration disallows shared binding', t => {
  const { root, space, own } = fixture(t);
  const record = create(space, 'workspace alpha only');
  const other = own(new MemorySpace(root, 'other'));
  assert.throws(() => other.get(record.id, { sessionId: 'session-b' }), /找不到/);
  assert.throws(() => configOf({ bindings: [{ cwd: resolveTest('a'), space: 'one' }, { cwd: resolveTest('b'), space: 'one' }] }), /只能绑定一个/);
});
function resolveTest(name) { return join(tmpdir(), `tidal-workspace-${name}`); }
test('different-day events are not collapsed as duplicate facts', t => {
  const { space } = fixture(t);
  const a = create(space, '执行了每日备份', { layer: 'L2', occurredAt: '2026-01-01T10:00:00Z' });
  const b = create(space, '执行了每日备份', { layer: 'L2', occurredAt: '2026-01-02T10:00:00Z' });
  assert.notEqual(a.id, b.id);
});
test('optimistic revision checks reject stale edits and preserve history', t => {
  const { space } = fixture(t);
  const a = create(space, '主题是蓝色');
  const b = space.update(a.id, { text: '主题是绿色' }, a.revision, admin);
  assert.equal(b.revision, 2);
  assert.throws(() => space.update(a.id, { text: '不应覆盖' }, 1, admin), /已被修改/);
  assert.equal(space.revisions(a.id, admin).length, 2);
});
test('passive previews never reinforce; manual confirmation is idempotent', t => {
  const { space } = fixture(t);
  const a = create(space, '蓝色主题');
  space.recall('蓝色主题', { sessionId: 'a' });
  space.recall('蓝色主题', { sessionId: 'b' });
  assert.equal(space.get(a.id, admin).stability, 1);
  space.reinforce(a.id, 'confirmation-1', admin);
  space.reinforce(a.id, 'confirmation-1', admin);
  assert.equal(space.get(a.id, admin).stability, 1.25);
});
test('reinforcement recovers if the layer write succeeds before its idempotency marker', t => {
  const root = mkdtempSync(join(tmpdir(), 'tidal-reinforcement-recovery-'));
  let fail = true;
  let space = new MemorySpace(root, 'test', {
    failpoint: point => { if (point === 'after-reinforcement-write' && fail) { fail = false; throw new Error('injected crash'); } },
  });
  t.after(() => { space.close(); rmSync(root, { recursive: true, force: true }); });
  const candidate = space.create({ layer: 'L3', text: 'local recovery candidate' }, admin);
  assert.throws(() => space.reinforce(candidate.id, 'evidence-1', admin), /injected crash/);
  assert.equal(space.get(candidate.id, admin).stability, 1.25);
  assert.equal(space.system.prepare('SELECT count(*) AS n FROM reinforcements').get().n, 0);
  space.close();
  space = new MemorySpace(root, 'test');
  const recovered = space.get(candidate.id, admin);
  assert.equal(recovered.stability, 1.25);
  assert.equal(recovered.status, 'active');
  assert.equal(space.system.prepare('SELECT count(*) AS n FROM reinforcements').get().n, 1);
  assert.equal(space.system.prepare("SELECT count(*) AS n FROM operations WHERE state='pending'").get().n, 0);
  assert.equal(space.reinforce(candidate.id, 'evidence-1', admin).revision, recovered.revision);
});
test('recall respects status, effective dates and exact budget including headers', t => {
  const { space } = fixture(t, { clock: () => Date.parse('2026-02-01T00:00:00Z') });
  create(space, '蓝色主题的说明');
  const future = create(space, '蓝色未来主题', { validFrom: '2027-01-01T00:00:00Z' });
  const expired = create(space, '蓝色旧主题', { validUntil: '2025-01-01T00:00:00Z' });
  const pending = create(space, '蓝色待确认主题', { status: 'candidate' });
  const result = space.recall('蓝色', { sessionId: 'anything' }, { budget: 256 });
  assert.ok(result.estimatedTokens <= 256);
  for (const item of [future, expired, pending]) assert.ok(!result.picked.some(row => row.id === item.id));
  assert.equal(result.text.includes('待确认主题'), false);
});
test('FTS recall is local, honors query terms, and excludes unrelated shared tasks', t => {
  const { space } = fixture(t);
  const fact = create(space, 'blue theme preference', { layer: 'L3', status: 'active' });
  create(space, 'unrelated database migration task', { layer: 'L1', category: 'task', status: 'active' });
  const result = space.recall('blue theme', { sessionId: 'session' });
  assert.deepEqual(result.picked.map(item => item.id), [fact.id]);
  assert.equal(space.list({ query: 'blue' }, admin).total, 1);
  const chinese = create(space, '偏好使用蓝色主题', { layer: 'L3', status: 'active' });
  assert.ok(space.recall('蓝色主题', { sessionId: 'session' }).picked.some(item => item.id === chinese.id));
  assert.equal(space.list({ query: '的' }, admin).total, 0);
});
test('cross-layer journal resumes after target write without duplicating target', t => {
  const f = fixture(t, { failpoint: point => { if (point === 'after-target') throw new Error('injected crash'); } });
  const source = create(f.space, '准备部署测试', { layer: 'L0', status: 'pending' });
  assert.throws(() => f.space.promote(source.id, { layer: 'L2', status: 'candidate' }, admin), /injected crash/);
  f.space.close();
  const next = new MemorySpace(f.root, 'test');
  f.replace(next);
  assert.equal(next.all().filter(r => r.layer === 'L2').length, 1);
  assert.equal(next.get(source.id, admin).status, 'processed');
  assert.equal(next.system.prepare("SELECT count(*) AS n FROM operations WHERE state='pending'").get().n, 0);
});
test('a second writer fails closed and never steals the first writer lock', t => {
  const { root, space } = fixture(t);
  assert.throws(() => new MemorySpace(root, 'test'), error => error.code === 'SPACE_BUSY');
  assert.equal(create(space, 'still writable').text, 'still writable');
});
test('forget deletes derivations, history, views and prevents exact reimport', t => {
  const { space } = fixture(t);
  const source = create(space, '临时测试知识', { layer: 'L2' });
  const child = space.promote(source.id, { layer: 'L3' }, admin);
  const result = space.forget(source.id, admin);
  assert.equal(result.deleted, 2);
  assert.throws(() => space.get(child.id, admin), /找不到/);
  assert.equal(space.db('L3').prepare('SELECT count(*) AS n FROM revisions').get().n, 0);
  assert.throws(() => create(space, '临时测试知识', { layer: 'L2' }), /已被遗忘/);
});
test('private text never occurs in ordinary search, views, traces, or plain backups', t => {
  const { space } = fixture(t, { config: { privateWriters: ['test-author'] } });
  const secret = 'synthetic-private-canary-691';
  space.appendPrivate('test-author', secret);
  create(space, 'ordinary record');
  assert.equal(space.list({ query: secret }, admin).total, 0);
  const recalled = space.recall(secret, admin);
  assert.equal(recalled.text.includes(secret), false);
  assert.ok(recalled.picked.every(item => item.channel === 'resident'));
  assert.equal(packBackup(space).includes(secret), false);
  assert.equal(JSON.stringify(space.status()).includes(secret), false);
  assert.equal(JSON.stringify(space.traces(admin)).includes(secret), false);
  assert.throws(() => space.appendPrivate('not-enabled', 'test'), /未被用户启用/);
  for (const info of Object.values(LAYERS)) {
    for (const file of readdirSync(join(space.directory, info.directory, 'views'))) {
      assert.equal(readFileSync(join(space.directory, info.directory, 'views', file), 'utf8').includes(secret), false);
    }
  }
});
test('encrypted backup authenticates and restores private content into a new space', t => {
  const { root, space, own } = fixture(t, { config: { privateWriters: ['test-author'] } });
  create(space, 'normal record');
  space.appendPrivate('test-author', 'synthetic private record');
  const text = packBackup(space, 'synthetic-password-123');
  assert.equal(text.includes('synthetic private record'), false);
  assert.throws(() => unpackBackup(text, 'incorrect-password-123'));
  const result = restoreBackup(root, 'restored', text, 'synthetic-password-123', {});
  assert.equal(result.privateCount, 1);
  assert.throws(() => restoreBackup(root, 'test', text, 'synthetic-password-123', {}), /新空间/);
  const restored = own(new MemorySpace(root, 'restored'));
  assert.equal(restored.all().length, 1);
  assert.equal(restored.privateStatus().count, 1);
});
test('malformed restore never publishes a partially restored space', t => {
  const { root, space } = fixture(t);
  create(space, 'normal');
  const envelope = JSON.parse(packBackup(space));
  envelope.sha256 = '0'.repeat(64);
  assert.throws(() => restoreBackup(root, 'bad', JSON.stringify(envelope), '', {}), /校验失败/);
  assert.equal(existsSync(join(root, 'spaces', 'bad')), false);
});
test('legacy preview separates private files; repeated public import merges', t => {
  const { space } = fixture(t);
  const plan = importPreview([
    { name: 'notes.md', text: '# 工具经验\n\n测试命令必须先确认目录。' },
    { name: 'diary-private.md', text: 'synthetic-private-diary' },
  ]);
  assert.equal(plan.privateFiles.length, 1);
  const selected = plan.candidates.map(c => c.importId);
  applyImport(space, plan, selected);
  applyImport(space, plan, selected);
  assert.equal(space.all().length, plan.candidates.length);
  assert.equal(space.privateStatus().count, 1);
  assert.throws(() => importPreview([{ name: '.credentials.yaml', text: 'not-a-real-secret' }]), /凭据/);
});
test('explicit remember directives are automatic; unknown horizons remain dated episodes, not permanent facts', t => {
  const { space } = fixture(t);
  const task = space.capture({ sessionId: 'a', eventId: 1, text: '记住：这次任务先不改数据库', role: 'user' });
  const preference = space.capture({ sessionId: 'b', eventId: 2, text: '记住：以后回答保持简洁', role: 'user' });
  const ambiguous = space.capture({ sessionId: 'c', eventId: 3, text: '记住：项目名称是潮汐', role: 'user' });
  const result = space.organizePending();
  assert.deepEqual(result, { inspected: 3, organized: 3, needsReview: 0 });
  const taskRecord = space.all().find(r => r.text === '这次任务先不改数据库');
  const preferenceRecord = space.all().find(r => r.text === '以后回答保持简洁');
  assert.deepEqual([taskRecord.layer, taskRecord.horizon, taskRecord.status], ['L1', 'task', 'active']);
  assert.deepEqual([preferenceRecord.layer, preferenceRecord.horizon, preferenceRecord.status], ['L3', 'long_term', 'active']);
  assert.equal(space.get(task.id, admin).status, 'processed');
  assert.equal(space.get(preference.id, admin).status, 'processed');
  assert.equal(space.get(ambiguous.id, admin).status, 'processed');
  assert.equal(classifyRememberDirective('记住：项目名称是潮汐').horizon, 'unspecified');
  const episode = space.all().find(r => r.text === '项目名称是潮汐');
  assert.deepEqual([episode.layer, episode.status, episode.horizon], ['L2', 'active', 'unspecified']);
  assert.ok(space.recall('项目名称潮汐', admin).picked.some(r => r.id === episode.id));
});
test('maintenance keeps pending buffers and does not silently lose failed work', t => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const { space } = fixture(t, { clock: () => now });
  const pending = create(space, 'pending', { layer: 'L0', status: 'pending' });
  const processed = create(space, 'processed', { layer: 'L0', status: 'processed' });
  now += 100 * 3600000;
  space.maintenance();
  assert.ok(space.get(pending.id, admin));
  assert.throws(() => space.get(processed.id, admin), /找不到/);
});
test('replaying the same evidence does not create another revision', t => {
  const { space } = fixture(t);
  const a = create(space, 'idempotent');
  const b = create(space, 'idempotent');
  assert.equal(a.revision, b.revision);
  assert.equal(space.revisions(a.id, admin).length, 1);
});
test('expiry can be cleared and conflicting facts cannot both be activated', t => {
  const { space } = fixture(t);
  const a = create(space, 'blue', { factKey: 'theme', validUntil: '2030-01-01T00:00:00Z' });
  assert.equal(space.update(a.id, { validUntil: null }, a.revision, admin).validUntil, null);
  const b = create(space, 'green', { factKey: 'theme' });
  assert.equal(b.status, 'review');
  assert.throws(() => space.update(b.id, { status: 'active' }, b.revision, admin), /事实键/);
  assert.throws(() => space.reinforce(b.id, 'confirm-conflict', admin), /冲突/);
  const candidate = space.create({ layer: 'L3', text: 'unconfirmed' }, { sessionId: 'a' });
  assert.equal(space.reinforce(candidate.id, 'confirm-candidate', admin).status, 'active');
});
test('forget blocks earlier revisions and promotion reintroducing forgotten content', t => {
  const { space } = fixture(t);
  const a = create(space, 'first version');
  space.update(a.id, { text: 'second version' }, a.revision, admin);
  space.forget(a.id, admin);
  assert.throws(() => create(space, 'first version'), /已被遗忘/);
  const source = create(space, 'first version', { layer: 'L2' });
  assert.throws(() => space.promote(source.id, { layer: 'L3' }, admin), /已被遗忘/);
});
test('manual edits cannot revive forgotten text or create duplicate content', t => {
  const { space } = fixture(t);
  const forgotten = create(space, 'remembered then forgotten');
  const editable = create(space, 'a different active memory');
  const duplicate = create(space, 'yet another memory');
  space.forget(forgotten.id, admin);
  assert.throws(() => space.update(editable.id, { text: forgotten.text }, editable.revision, admin), /已被遗忘/);
  assert.throws(() => space.update(duplicate.id, { text: editable.text }, duplicate.revision, admin), /相同内容已存在/);
});
test('space close continues releasing every database after one resource fails', t => {
  const { root, space } = fixture(t);
  space.semanticIndex = { close() { throw new Error('injected close failure'); } };
  assert.throws(() => space.close(), AggregateError);
  const reopened = new MemorySpace(root, 'test');
  reopened.close();
});
test('restore rejects private provenance hidden in a secondary source', t => {
  const { root, space } = fixture(t);
  create(space, 'public');
  const envelope = JSON.parse(packBackup(space));
  const doc = JSON.parse(envelope.payload);
  doc.records[0].sources.push({ nested: { private: true, text: 'synthetic private' } });
  envelope.payload = JSON.stringify(doc); envelope.sha256 = hash(envelope.payload);
  assert.throws(() => restoreBackup(root, 'invalid', JSON.stringify(envelope), '', {}), /私人来源/);
  assert.equal(existsSync(join(root, 'spaces', 'invalid')), false);
});
