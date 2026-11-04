import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { corpus, probes } from '../tests/fixtures/recall.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = fileURLToPath(import.meta.url);
const now = Date.parse('2026-11-04T04:00:00Z');
const elapsed = action => { const start = performance.now(); action(); return performance.now() - start; };
const rounded = n => Math.round(n * 1000) / 1000;
const distribution = samples => {
  const ordered = samples.toSorted((a, b) => a - b);
  return { samples: ordered.length, p50Ms: rounded(ordered[Math.ceil(ordered.length * 0.5) - 1]),
    p95Ms: rounded(ordered[Math.ceil(ordered.length * 0.95) - 1]) };
};

async function worker(source, root, count) {
  const { MemorySpace } = await import(pathToFileURL(join(source, 'src', 'store.js')));
  const model = await import(pathToFileURL(join(source, 'src', 'model.js')));
  const keys = new Map();
  const options = { clock: () => now, config: { residentMode: 'pinned', maxRecall: 6 } };
  let space = new MemorySpace(root, 'bench', options);
  try {
    const data = corpus(count);
    // Bulk seed is setup, NOT a measurement of the production write pipeline.
    for (const layer of Object.keys(model.LAYERS)) {
      const db = space.db(layer);
      const columns = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
      const fields = ['id', 'data', 'dedupe_key', 'status', 'scope', 'session_id', 'created_at', 'updated_at', 'fact_key'];
      if (columns.includes('pinned')) fields.push('pinned');
      if (columns.includes('valid_until')) fields.push('valid_until');
      const insert = db.prepare(`INSERT INTO memories(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`);
      const search = db.prepare('INSERT INTO search(id,words) VALUES(?,?)');
      const revision = db.prepare('INSERT INTO revisions VALUES(?,?,?)');
      db.exec('BEGIN');
      try {
        for (const item of data.filter(r => r.layer === layer)) {
          const record = model.normalizeRecord({ text: item.text, layer, status: 'active', kind: 'user_statement',
            occurredAt: new Date(now).toISOString(), source: { kind: 'manual' } }, new Date(now).toISOString());
          const hex = model.hash(item.key).slice(0, 32);
          record.id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          keys.set(record.id, item.key);
          const values = [record.id, JSON.stringify(record), record.dedupeKey, record.status, record.scope,
            record.sessionId, record.createdAt, record.updatedAt, record.factKey];
          if (columns.includes('pinned')) values.push(0);
          if (columns.includes('valid_until')) values.push(null);
          insert.run(...values);
          revision.run(record.id, 1, JSON.stringify(record));
          search.run(record.id, model.terms(record.text, Infinity).join(' '));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    space.close();
    const startupMs = elapsed(() => { space = new MemorySpace(root, 'bench', options); });
    const captureMs = Array.from({ length: 20 }, (_, i) => elapsed(() =>
      space.capture({ sessionId: 'bench', eventId: i, text: `合成普通会话 ${i}`, role: 'user' })));
    const maintenanceMs = Array.from({ length: 5 }, () => elapsed(() => space.maintenance()));
    const results = [];
    const latencies = [];
    let firstQueryMs;
    for (let round = 0; round < 3; round++) {
      for (const [query, expected, group = expected.length ? 'lexical' : 'unrelated'] of probes) {
        let result;
        const duration = elapsed(() => { result = space.recall(query, { sessionId: 'bench' }); });
        firstQueryMs ??= duration;
        if (round > 0) latencies.push(duration);
        if (round > 0) continue;
        const picked = result.picked.map(r => keys.get(r.id));
        const hits = picked.filter(key => expected.includes(key)).length;
        results.push({ query, group, expected, picked, estimatedBytes: result.estimatedTokens,
          recallAt6: expected.length ? hits / expected.length : null,
          precisionReturned: picked.length ? hits / picked.length : 0 });
      }
    }
    const groupMetrics = group => {
      const rows = results.filter(r => r.group === group);
      const mean = key => rounded(rows.reduce((sum, r) => sum + r[key], 0) / rows.length);
      return { queries: rows.length, recallAt6: mean('recallAt6'), precisionReturned: mean('precisionReturned') };
    };
    const negative = results.filter(r => r.group === 'unrelated');
    const projections = Object.values(model.LAYERS).reduce((n, info) =>
      n + readdirSync(join(space.directory, info.directory, 'views')).filter(f => f.endsWith('.md')).length, 0);
    return { records: count, startupMs: rounded(startupMs), capture: distribution(captureMs),
      maintenance: distribution(maintenanceMs), firstQueryMs: rounded(firstQueryMs), warmRecall: distribution(latencies),
      peakRssMiB: rounded(process.resourceUsage().maxRSS / 1024), projectionFiles: projections,
      lexical: groupMetrics('lexical'), semantic: groupMetrics('semantic'),
      unrelatedQueries: negative.length,
      unrelatedInjectionRate: rounded(negative.filter(r => r.picked.length).length / negative.length),
      results };
  } finally { space.close(); }
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(process.argv[3], process.argv[4], Number(process.argv[5]))));
} else {
  const count = Number(process.argv[2] ?? 10000);
  if (!Number.isInteger(count) || count < 100 || count > 100000) throw new Error('Use a record count from 100 to 100000.');
  const temp = mkdtempSync(join(tmpdir(), 'tidal-bench-'));
  try {
    const baseline = join(temp, 'baseline');
    mkdirSync(join(baseline, 'src'), { recursive: true });
    writeFileSync(join(baseline, 'package.json'), '{"type":"module"}');
    const ref = process.argv[3] ?? 'e389bcd6adbb4a4c3a93efb386f089edfd08bd2a';
    const baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { cwd: repo, encoding: 'utf8' }).trim();
    for (const file of ['store.js', 'database.js', 'model.js']) {
      writeFileSync(join(baseline, 'src', file),
        execFileSync('git', ['show', `${baselineCommit}:src/${file}`], { cwd: repo }));
    }
    const run = (name, source) => {
      const child = spawnSync(process.execPath, [script, '--worker', source, join(temp, name), String(count)],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000 });
      if (child.error || child.status !== 0) throw new Error(`${name} benchmark failed: ${child.error?.message ?? child.stderr}`);
      return JSON.parse(child.stdout);
    };
    const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      arch: process.arch, baselineCommit, notes: [
        'Synthetic labeled data only; not a fish-memory comparison or desktop acceptance.',
        'Separate processes; warm p95 from two rounds after one warmup; startup is one measurement.',
        'precisionReturned uses the number returned, not a fixed denominator of six; empty results score zero.',
        'Default baseline is the original 0.1.0 commit; current is the working tree. Bulk fixture loading is excluded.',
        'Lexical benchmark uses pinned-only residency and maxRecall=6, not the new all-L3/30-item product defaults.',
      ], baseline: run('old-data', baseline), current: run('new-data', repo) };
    mkdirSync(join(repo, '.preview'), { recursive: true });
    writeFileSync(join(repo, '.preview', 'benchmark.json'), JSON.stringify(report, null, 2));
    const compact = ({ results, ...metrics }) => metrics;
    console.log(JSON.stringify({ baselineCommit, baseline: compact(report.baseline), current: compact(report.current) }, null, 2));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
