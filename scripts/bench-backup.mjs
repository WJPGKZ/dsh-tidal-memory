import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicFile } from '../src/database.js';
import { memorySearchText, normalizeRecord, terms } from '../src/model.js';
import { MemorySpace } from '../src/store.js';
import { packBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const counts = process.argv[2] ? [Number(process.argv[2])] : [1000, 10000];
if (counts.some(count => !Number.isInteger(count) || count < 100 || count > 100000))
  throw new Error('Use a record count from 100 to 100000.');
const rounded = value => Math.round(value * 1000) / 1000;
const password = 'synthetic-benchmark-password-123';
for (const count of counts) {
  const directory = mkdtempSync(join(tmpdir(), 'tidal-backup-bench-'));
  const source = new MemorySpace(join(directory, 'source'), 'shared',
    { config: { autoBackup: false, privateWriters: ['bench-author'] } });
  let restored;
  try {
    const now = '2026-03-10T12:00:00.000Z', db = source.db('L2');
    const insert = db.prepare(`INSERT INTO memories(id,data,dedupe_key,status,scope,session_id,created_at,updated_at,fact_key,pinned,valid_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const revision = db.prepare('INSERT INTO revisions VALUES(?,?,?)');
    const search = db.prepare('INSERT INTO search(id,words) VALUES(?,?)');
    db.exec('BEGIN');
    try {
      for (let i = 0; i < count; i++) {
        const record = normalizeRecord({ layer: 'L2', text: `Synthetic record ${i}: local evidence for benchmark only.`,
          kind: 'user_statement', status: 'active', topics: ['benchmark'],
          source: { kind: 'manual', eventId: `event-${i}` } }, now);
        const data = JSON.stringify(record);
        insert.run(record.id, data, record.dedupeKey, record.status, record.scope, record.sessionId,
          record.createdAt, record.updatedAt, record.factKey, 0, null);
        revision.run(record.id, record.revision, data);
        search.run(record.id, terms(memorySearchText(record), Infinity).join(' '));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    source.appendPrivate('bench-author', 'PRIVATE_SYNTHETIC_BENCHMARK');
    const files = {};
    for (const [mode, secret] of [['plain', ''], ['encrypted-private', password]]) {
      const start = performance.now();
      const text = packBackup(source, secret, { includePrivate: Boolean(secret) });
      const path = join(directory, `${mode}.json`);
      atomicFile(path, text);
      files[mode] = { path, bytes: statSync(path).size, writeMs: rounded(performance.now() - start) };
    }
    assert.equal(unpackBackup(readFileSync(files.plain.path, 'utf8')).privateEntries, undefined);
    const start = performance.now();
    const result = restoreBackup(join(directory, 'target'), 'restored',
      readFileSync(files['encrypted-private'].path, 'utf8'), password, source.config);
    const restoreMs = rounded(performance.now() - start);
    restored = new MemorySpace(join(directory, 'target'), 'restored', { config: source.config });
    const expected = source.snapshot({ includePrivate: true }), actual = restored.snapshot({ includePrivate: true });
    const fields = snapshot => snapshot.records.map(({ id, text, status, sources, topics, revision }) =>
      ({ id, text, status, sources, topics, revision })).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(result.records, count);
    assert.equal(result.privateCount, 1);
    assert.deepEqual(fields(actual), fields(expected));
    const versions = snapshot => snapshot.revisions.map(({ layer, record }) =>
      ({ layer, id: record.id, revision: record.revision, text: record.text, sources: record.sources }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
    assert.deepEqual(versions(actual), versions(expected));
    assert.equal(actual.privateEntries[0].content, 'PRIVATE_SYNTHETIC_BENCHMARK');
    console.log(JSON.stringify({ records: count, revisions: expected.revisions.length,
      plain: { bytes: files.plain.bytes, writeMs: files.plain.writeMs },
      encryptedPrivate: { bytes: files['encrypted-private'].bytes, writeMs: files['encrypted-private'].writeMs },
      restoreMs, note: 'One synthetic run; bulk setup excluded, restore includes rebuilding views.' }));
  } finally {
    restored?.close();
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
