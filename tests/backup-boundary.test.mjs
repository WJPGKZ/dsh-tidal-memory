import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRecord } from '../src/model.js';
import { TidalRuntime } from '../src/runtime.js';
import { MAX_BACKUP_FILE_BYTES, MAX_RESTORE_BODY_BYTES, packBackup, unpackBackup } from '../src/transfer.js';

test('backup bounds are UTF-8 bytes and accept a valid envelope beyond the former 50 MiB character limit', () => {
  const padding = 'a'.repeat(50 * 1024 * 1024 + 1);
  const fake = { snapshot: () => ({ schema: 'tidal-memory', version: 1, records: [], revisions: [], tombstones: [], padding }) };
  const backup = packBackup(fake);
  assert.ok(backup.length > 50 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ name: 'restore', text: backup, password: '' })) <= MAX_RESTORE_BODY_BYTES);
  assert.equal(unpackBackup(backup).padding.length, padding.length);
  assert.throws(() => unpackBackup('中'.repeat(Math.floor(MAX_BACKUP_FILE_BYTES / 3) + 1)),
    { code: 'BACKUP_TOO_LARGE' });
  assert.equal(MAX_RESTORE_BODY_BYTES, MAX_BACKUP_FILE_BYTES * 2 + 8192);
});

test('a valid backup larger than 50 MiB restores actual records and provenance through HTTP', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tidal-large-http-'));
  const ctx = { agents: { list: () => [] }, settings: { describe: () => [] },
    connection: { requestRejection: () => undefined }, logger: { warn() {} } };
  const runtime = new TidalRuntime(ctx, { dataRoot: root, autoBackup: false }, root);
  const server = createServer((req, res) => runtime.handle(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const padding = 'x'.repeat(5000);
  const sources = Array.from({ length: 2700 }, (_, index) => ({ kind: 'fixture', detail: `${index}:${padding}` }));
  const records = ['first', 'second'].map(name => {
    const record = normalizeRecord({ layer: 'L2', text: `large backup ${name}`,
      kind: 'user_statement', source: { kind: 'fixture' } }, '2026-03-01T00:00:00.000Z');
    record.sources = sources;
    return record;
  });
  const backup = packBackup({ snapshot: () => ({
    schema: 'tidal-memory', version: 1, space: 'source', records,
    revisions: records.map(record => ({ layer: 'L2', record })), tombstones: [],
  }) });
  assert.ok(Buffer.byteLength(backup) > 50 * 1024 * 1024);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/tidal-memory/restore?space=source`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tidal-request': '1' },
    body: JSON.stringify({ name: 'large-restored', text: backup, password: '' }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.data.records, 2);
  assert.equal(result.data.forgetCoverage, 'backup-only');
  const restored = runtime.space('large-restored');
  for (const original of records) {
    const record = restored.get(original.id, { admin: true });
    assert.equal(record.text, original.text);
    assert.equal(record.sources.length, 2700);
    assert.equal(record.sources[2699].detail, sources[2699].detail);
    assert.equal(restored.revisions(record.id, { admin: true }).length, 1);
  }
});

test('the restore HTTP reader rejects a streamed byte count above its limit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tidal-http-limit-'));
  const runtime = new TidalRuntime({ agents: { list: () => [] }, settings: { describe: () => [] },
    connection: { requestRejection: () => undefined } }, { dataRoot: root }, root);
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const req = { method: 'POST', url: '/tidal-memory/restore', headers: {
    'content-type': 'application/json', 'x-tidal-request': '1',
  }, async *[Symbol.asyncIterator]() { yield { length: MAX_RESTORE_BODY_BYTES + 1 }; } };
  const res = { writableEnded: false, setHeader() {}, end(body) { this.body = body; this.writableEnded = true; } };
  await runtime.handle(req, res);
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).error.code, 'BODY_TOO_LARGE');
});
