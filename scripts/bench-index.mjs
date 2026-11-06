import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { corpus } from '../tests/fixtures/recall.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = fileURLToPath(import.meta.url);
const now = Date.parse('2026-11-04T04:00:00Z');
const rounded = value => Math.round(value * 1000) / 1000;
const distribution = samples => {
  const sorted = samples.toSorted((a, b) => a - b);
  return { samples: sorted.length, p50Ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
};
class SyntheticEmbedding {
  constructor() {
    this.key = 'synthetic-v1';
    this.pack = { fingerprint: 'synthetic-v1', modelId: 'synthetic-v1', dimension: 32, chunkSize: 384,
      minScore: 0.7, relativeFloor: 0.9 };
    this.documentInputs = 0;
  }
  async ready() { return this.pack; }
  async embed(texts, kind) {
    if (kind === 'document') this.documentInputs += texts.length;
    return texts.map(text => {
      const vector = new Float32Array(this.pack.dimension);
      vector[createHash('sha256').update(text).digest()[0] % vector.length] = 1;
      return vector;
    });
  }
}

async function worker(source, root, count) {
  const { MemorySpace } = await import(pathToFileURL(join(source, 'src', 'store.js')));
  const { SemanticIndex } = await import(pathToFileURL(join(source, 'src', 'semantic-index.js')));
  const model = await import(pathToFileURL(join(source, 'src', 'model.js')));
  const space = new MemorySpace(root, 'bench', { clock: () => now,
    config: { residentBudget: 0, autoBackup: false } });
  const embedding = new SyntheticEmbedding();
  const ids = [];
  try {
    const data = corpus(count);
    for (const layer of ['L1', 'L2', 'L3']) {
      const db = space.db(layer);
      const insert = db.prepare(`INSERT INTO memories(id,data,dedupe_key,status,scope,session_id,created_at,updated_at,fact_key,pinned,valid_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      const revision = db.prepare('INSERT INTO revisions VALUES(?,?,?)');
      const search = db.prepare('INSERT INTO search(id,words) VALUES(?,?)');
      db.exec('BEGIN');
      try {
        for (const item of data.filter(record => record.layer === layer)) {
          const record = model.normalizeRecord({ text: item.text, layer, kind: 'user_statement',
            occurredAt: new Date(now).toISOString(), source: { kind: 'synthetic-fixture' } }, new Date(now).toISOString());
          ids.push(record.id);
          insert.run(record.id, JSON.stringify(record), record.dedupeKey, record.status, record.scope,
            record.sessionId, record.createdAt, record.updatedAt, record.factKey, 0, null);
          revision.run(record.id, record.revision, JSON.stringify(record));
          search.run(record.id, model.terms(model.memorySearchText(record), Infinity).join(' '));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    space.semanticIndex = new SemanticIndex(space);
    let start = performance.now();
    await space.semanticIndex.sync(embedding);
    const initialMs = rounded(performance.now() - start);
    const db = space.semanticIndex.db;
    db.exec(`CREATE TEMP TABLE benchmark_counts (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO benchmark_counts VALUES('insert',0),('update',0),('delete',0);
      CREATE TEMP TRIGGER bench_insert AFTER INSERT ON main.documents BEGIN
        UPDATE benchmark_counts SET n=n+1 WHERE kind='insert'; END;
      CREATE TEMP TRIGGER bench_update AFTER UPDATE ON main.documents BEGIN
        UPDATE benchmark_counts SET n=n+1 WHERE kind='update'; END;
      CREATE TEMP TRIGGER bench_delete AFTER DELETE ON main.documents BEGIN
        UPDATE benchmark_counts SET n=n+1 WHERE kind='delete'; END;`);
    const counts = () => Object.fromEntries(db.prepare('SELECT kind,n FROM benchmark_counts').all().map(row => [row.kind, row.n]));
    const documentsBefore = embedding.documentInputs, timings = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      start = performance.now();
      await space.semanticIndex.sync(embedding);
      timings.push(performance.now() - start);
    }
    const warmWrites = counts(), warmDocumentInputs = embedding.documentInputs - documentsBefore;
    const record = space.raw(ids[0]), layerDb = space.db(record.layer);
    const historyBefore = layerDb.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get(record.id).n;
    const usage = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      start = performance.now();
      space.recordRetrieval(record.id, `benchmark-${iteration}`);
      usage.push(performance.now() - start);
    }
    const views = readdirSync(join(space.directory, model.LAYERS[record.layer].directory, 'views')).length;
    return { records: count, initialMs, indexed: space.semanticIndex.status().indexed,
      warmSync: distribution(timings), warmDocumentInputs, warmWrites,
      usage: distribution(usage), usageDocumentWrites: Object.fromEntries(
        Object.entries(counts()).map(([key, value]) => [key, value - warmWrites[key]])),
      usageNewFullRevisions: layerDb.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get(record.id).n - historyBefore,
      usageCreatedViewFiles: views, recallCount: space.raw(record.id).recallCount,
      peakRssMiB: rounded(process.resourceUsage().maxRSS / 1024) };
  } finally { space.close(); }
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(process.argv[3], process.argv[4], Number(process.argv[5]))));
} else {
  const counts = process.argv[2] ? [Number(process.argv[2])] : [1000, 10000];
  if (counts.some(count => !Number.isInteger(count) || count < 100 || count > 100000))
    throw new Error('Use a record count from 100 to 100000.');
  const temp = mkdtempSync(join(tmpdir(), 'tidal-index-bench-'));
  try {
    const ref = process.argv[3] ?? 'v0.4.2';
    const baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { cwd: repo, encoding: 'utf8' }).trim();
    const baseline = join(temp, 'baseline');
    mkdirSync(baseline, { recursive: true });
    writeFileSync(join(baseline, 'package.json'), '{"type":"module"}');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', baselineCommit, '--', 'src'],
      { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const file of files) {
      const target = join(baseline, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: repo }));
    }
    if (!existsSync(join(baseline, 'src', 'semantic-index.js'))) throw new Error('Baseline has no semantic index.');
    const run = (name, source, count) => {
      const child = spawnSync(process.execPath, [script, '--worker', source, join(temp, `${name}-${count}`), String(count)],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600000 });
      if (child.error || child.status !== 0) throw new Error(`${name} benchmark failed: ${child.error?.message ?? child.stderr}`);
      return JSON.parse(child.stdout);
    };
    mkdirSync(join(repo, '.preview'), { recursive: true });
    for (const count of counts) {
      const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
        arch: process.arch, baselineCommit, notes: [
          'Synthetic data and deterministic test vectors only; no real embedding model or personal memory.',
          'Separate processes; bulk fixture setup is excluded; five warm syncs and twenty unique usage events.',
          'Document write counts use SQLite triggers; full revision counts exclude the original fixture row.',
        ], baseline: run('baseline', baseline, count), current: run('current', repo, count) };
      writeFileSync(join(repo, '.preview', `index-benchmark-${count}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
