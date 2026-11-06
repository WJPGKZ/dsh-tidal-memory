import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { packBackup, restoreBackup } from '../src/transfer.js';

const admin = { admin: true };
const reader = { sessionId: 'reader' };
const day = 86400000;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-lifecycle-'));
  let now = Date.parse('2026-01-01T12:00:00Z');
  const options = { clock: () => now, config: { halfLifeDays: 30, residentBudget: 0 } };
  const spaces = [];
  const open = name => { const space = new MemorySpace(root, name, options); spaces.push(space); return space; };
  t.after(() => { for (const space of spaces) space.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, open, space: open('shared'), advance: days => { now += days * day; } };
}
const create = (space, text, fields = {}) => space.create({
  layer: 'L2', text, category: 'knowledge', kind: 'user_statement', horizon: 'long_term', ...fields,
}, admin);

test('activation uses the same decay as ranking and recall does not assert credibility', t => {
  const f = fixture(t), record = create(f.space, 'exact lavender protocol');
  f.advance(240);
  const aged = f.space.lifecycle(record.id, admin);
  assert.equal(aged.activation.anchorKind, 'creation');
  assert.equal(aged.activation.ageDays, 240);
  assert.equal(aged.activation.effectiveHalfLifeDays, 30);
  assert.equal(aged.activation.freshness, 2 ** -8);
  assert.equal(aged.consolidation.state, 'accepted');
  assert.match(aged.consolidation.message, /两个独立用户事件、两个本机日期/);
  assert.equal(aged.archive.autoArchiveEnabled, false);
  assert.equal(aged.archive.inactivityEligible, false);
  assert.ok(f.space.recall('exact lavender protocol', reader).picked.some(item => item.id === record.id));
  f.space.recordRetrieval(record.id, 'first-query');
  const recalled = f.space.lifecycle(record.id, admin);
  assert.equal(recalled.activation.anchorKind, 'recall');
  assert.equal(recalled.activation.freshness, 1);
  assert.equal(recalled.activation.recallCount, 1);
  assert.equal(recalled.activation.stability, 1.1);
  assert.match(recalled.activation.confidence, /不是事实可信度/);
  assert.equal(f.space.get(record.id, admin).reinforcedAt, null);
});

test('ineligibility reasons match the consolidation predicate', t => {
  const { space } = fixture(t);
  const cases = [
    [{ layer: 'L1', category: 'task' }, 'otherLayer'],
    [{ status: 'candidate' }, 'inactive'],
    [{ kind: 'inference' }, 'historicalOrInferred'],
    [{ category: 'event' }, 'episodicCategory'],
    [{ horizon: 'event' }, 'horizon'],
    [{ validFrom: '2027-01-01T00:00:00Z' }, 'validity'],
    [{ validUntil: '2025-01-01T00:00:00Z' }, 'validity'],
    [{}, 'accepted'],
  ];
  for (const [fields, expected] of cases) {
    const record = create(space, `reason-${expected}-${JSON.stringify(fields)}`, fields);
    assert.equal(space.lifecycle(record.id, admin).consolidation.state, expected);
  }
});

test('manual, expiry and inactivity archives are distinguishable, reversible, and survive backup', t => {
  const f = fixture(t);
  let manual = create(f.space, 'manual archive', { importance: 0.4 });
  manual = f.space.update(manual.id, { status: 'archived' }, manual.revision, admin);
  const lowUse = create(f.space, 'old unused episode', { importance: 0.4 });
  const expired = create(f.space, 'expired despite protection', {
    pinned: true, validUntil: '2026-01-02T12:00:00Z',
  });
  const completed = create(f.space, 'completed task', { layer: 'L1', status: 'completed', category: 'task' });
  const cancelled = create(f.space, 'cancelled task', { layer: 'L1', status: 'cancelled', category: 'task' });
  f.advance(241);
  assert.equal(f.space.lifecycle(lowUse.id, admin).archive.inactivityEligible, true);
  assert.equal(f.space.lifecycle(expired.id, admin).archive.expiryDue, true);
  f.space.maintenance();
  assert.equal(f.space.get(lowUse.id, admin).status, 'active');
  assert.equal(f.space.get(expired.id, admin).archiveReason, 'expired');
  f.space.setConfig({ ...f.space.config, autoArchive: true });
  f.space.maintenance();
  assert.equal(f.space.get(lowUse.id, admin).archiveReason, 'inactivity');
  assert.equal(f.space.lifecycle(manual.id, admin).archiveReason, 'manual');
  assert.notEqual(f.space.lifecycle(completed.id, admin).statusMessage,
    f.space.lifecycle(cancelled.id, admin).statusMessage);
  const backup = packBackup(f.space);
  restoreBackup(f.root, 'restored', backup, '', f.options.config);
  const restored = f.open('restored');
  assert.equal(restored.get(lowUse.id, admin).archiveReason, 'inactivity');
  assert.equal(restored.get(expired.id, admin).archiveReason, 'expired');
  let renewed = f.space.get(expired.id, admin);
  const archivedAt = renewed.archivedAt;
  renewed = f.space.update(renewed.id, { text: 'expired and revised', status: 'archived' }, renewed.revision, admin);
  assert.equal(renewed.archiveReason, 'expired');
  assert.equal(renewed.archivedAt, archivedAt);
  assert.ok(renewed.expiredAt);
  renewed = f.space.update(renewed.id, { status: 'active', validUntil: null }, renewed.revision, admin);
  assert.equal(renewed.archiveReason, null);
  assert.equal(renewed.archivedAt, null);
  assert.equal(renewed.expiredAt, null);
  assert.equal(f.space.revisions(renewed.id, admin).some(row => row.archiveReason === 'expired'), true);
  const promoted = f.space.promote(manual.id, { layer: 'L3', status: 'active' }, admin);
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.archiveReason, null);
});
