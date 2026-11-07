import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { memorySearchText, normalizeRecord, terms } from '../src/model.js';

const counts = process.argv[2] ? [Number(process.argv[2])] : [1000, 10000];
if (counts.some(count => !Number.isInteger(count) || count < 100 || count > 100000))
  throw new Error('Use a record count from 100 to 100000.');
const rounded = value => Math.round(value * 1000) / 1000;
const distribution = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { samples: sorted.length, p50Ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
};
const reader = { sessionId: 'synthetic-benchmark' }, admin = { admin: true };
for (const count of counts) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-graph-bench-'));
  const now = Date.parse('2026-03-10T12:00:00Z');
  const store = new MemorySpace(root, 'shared', { clock: () => now, config: { autoBackup: false } });
  try {
    let seed, target;
    for (const layer of ['L2', 'L3']) {
      const db = store.db(layer);
      const insert = db.prepare(`INSERT INTO memories(id,data,dedupe_key,status,scope,session_id,created_at,updated_at,fact_key,pinned,valid_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      const search = db.prepare('INSERT INTO search(id,words) VALUES(?,?)');
      db.exec('BEGIN');
      try {
        for (let i = 0; i < count; i++) {
          if ((i % 10 === 2 ? 'L3' : 'L2') !== layer) continue;
          const record = normalizeRecord({ layer, text: `synthetic graph benchmark marker${String(i).padStart(6, '0')}`,
            topics: [`group-${i % 200}`], status: 'active', kind: 'user_statement' }, new Date(now).toISOString());
          insert.run(record.id, JSON.stringify(record), record.dedupeKey, record.status, record.scope,
            record.sessionId, record.createdAt, record.updatedAt, record.factKey, 0, null);
          search.run(record.id, terms(memorySearchText(record), Infinity).join(' '));
          if (i === 42) seed = record;
          if (i === 43) target = record;
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    store.graphDecision({ id: seed.id, otherId: target.id, decision: 'confirmed' }, admin);
    const started = performance.now();
    await store.graph().sync();
    const buildMs = performance.now() - started;
    assert.equal(store.graph().status().indexed, count);
    const updateStart = performance.now();
    const changed = store.update(seed.id, { tags: ['synthetic-incremental'] }, seed.revision, admin);
    const updateMs = performance.now() - updateStart;
    const unchangedStart = performance.now();
    store.graph().invalidate(changed);
    const unchangedUpdateMs = performance.now() - unchangedStart;
    const pageTimes = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(), page = store.graphList({ limit: 50 }, reader);
      pageTimes.push(performance.now() - start);
      assert.equal(page.items.length, Math.min(50, Math.ceil(count / 10)));
      assert.ok(page.nextCursor || count < 500);
    }
    const recall = {};
    for (const residentBudget of [0, 16000]) {
      const baseline = [], graph = [];
      for (let sample = 0; sample < 35; sample++) {
        for (const enabled of sample % 2 ? [true, false] : [false, true]) {
          store.setConfig({ ...store.config, residentBudget, graphRecall: enabled });
          const start = performance.now(), result = store.recall('marker000042', reader);
          const elapsed = performance.now() - start;
          assert.ok(result.picked.some(item => item.id === seed.id));
          if (enabled) assert.ok(result.picked.some(item => item.id === target.id && item.graphRelation));
          if (sample >= 5) (enabled ? graph : baseline).push(elapsed);
        }
      }
      const before = distribution(baseline), after = distribution(graph);
      const overheadMs = rounded(after.p95Ms - before.p95Ms);
      recall[residentBudget ? 'residentAll' : 'noResident'] = { baseline: before, graph: after, overheadMs,
        limitMs: rounded(Math.max(20, before.p95Ms * 0.2)), passed: overheadMs <= Math.max(20, before.p95Ms * 0.2) };
    }
    console.log(JSON.stringify({ records: count, buildMs: rounded(buildMs), updateMs: rounded(updateMs),
      unchangedUpdateMs: rounded(unchangedUpdateMs),
      listPage: distribution(pageTimes), recall,
      note: 'Synthetic data only; timings include local host load and are not a latency guarantee.' }));
    assert.ok(Object.values(recall).every(item => item.passed), 'Graph recall exceeded the planned P95 overhead gate.');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
