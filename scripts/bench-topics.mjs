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
for (const count of counts) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-topic-bench-'));
  const now = Date.parse('2026-03-10T12:00:00Z');
  const store = new MemorySpace(root, 'shared', { clock: () => now,
    config: { residentBudget: 0, autoBackup: false } });
  try {
    const db = store.db('L2');
    const insert = db.prepare(`INSERT INTO memories(id,data,dedupe_key,status,scope,session_id,created_at,updated_at,fact_key,pinned,valid_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const search = db.prepare('INSERT INTO search(id,words) VALUES(?,?)');
    db.exec('BEGIN');
    try {
      for (let i = 0; i < count; i++) {
        const record = normalizeRecord({ layer: 'L2', text: `topic benchmark marker${String(i).padStart(6, '0')}`,
          topics: ['orchid'], status: 'active', kind: 'user_statement' }, new Date(now).toISOString());
        insert.run(record.id, JSON.stringify(record), record.dedupeKey, record.status, record.scope,
          record.sessionId, record.createdAt, record.updatedAt, record.factKey, 0, null);
        search.run(record.id, terms(memorySearchText(record), Infinity).join(' '));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const measure = () => {
      const start = performance.now();
      const result = store.recall('marker000042', { sessionId: 'reader' });
      return { ms: performance.now() - start, result };
    };
    const cards = store.topicCards.bind(store);
    store.topicCards = () => [];
    measure();
    const baseline = Array.from({ length: 10 }, measure);
    store.topicCards = cards;
    const cold = measure();
    const warm = Array.from({ length: 10 }, measure);
    assert.equal(cold.result.topicCards[0].count, count);
    assert.equal(cold.result.text, baseline[0].result.text);
    assert.deepEqual(cold.result.picked, baseline[0].result.picked);
    assert.ok(warm.every(value => value.result.topicCards[0].count === count));
    console.log(JSON.stringify({ records: count, topicMembers: count, baseline: distribution(baseline.map(value => value.ms)),
      firstWithIndexBuildMs: rounded(cold.ms), warmWithCards: distribution(warm.map(value => value.ms)),
      note: 'Synthetic records, one large topic, bulk setup excluded; not real-world latency or answer quality.' }));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
