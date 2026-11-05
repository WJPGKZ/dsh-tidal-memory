import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime, ADMIN } from '../src/runtime.js';
import { semanticCases, semanticNegatives } from '../tests/semantic-fixtures.mjs';

if (!process.env.TIDAL_MODEL_ROOT) throw new Error('Set TIDAL_MODEL_ROOT to the installed local model data root.');
const report = { corpus: 'synthetic-40-v1', labels: 200, metrics: {}, failures: {} };
for (const mode of ['off', 'cpu', 'enhanced']) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-semantic-bench-'));
  const config = { dataRoot: root, embeddingMode: mode, residentBudget: 0, autoBackup: false,
    ...(mode === 'off' ? {} : { embeddingModelPath: join(process.env.TIDAL_MODEL_ROOT, 'models',
      mode === 'cpu' ? 'bge-small-zh-v1.5' : 'qwen3-embedding-0.6b') }) };
  const runtime = new TidalRuntime({ agents: { list: () => [] }, logger: { warn: line => console.error(line) } }, config, root);
  try {
    const store = runtime.space('benchmark');
    const records = semanticCases.map(([text]) => store.create({ layer: 'L2', text, kind: 'user_statement',
      source: { kind: 'synthetic-fixture' } }, ADMIN));
    const started = performance.now();
    if (mode !== 'off') {
      const ready = await runtime.prepareSemantic(store, ADMIN, '');
      if (ready.status.state !== 'ready') throw new Error(JSON.stringify(ready.status));
    }
    const preparedMs = Math.round(performance.now() - started), failures = [], summary = {};
    for (const split of ['development', 'heldout']) {
      let hits = 0, reciprocal = 0, negativesRejected = 0;
      const latencies = [];
      for (let i = 0; i < semanticCases.length; i++) {
        const queries = semanticCases[i][1].slice(split === 'development' ? 0 : 2, split === 'development' ? 2 : 4);
        for (const query of queries) {
          const start = performance.now();
          const result = await runtime.recallAsync(store, ADMIN, query);
          latencies.push(performance.now() - start);
          if (mode !== 'off' && result.semanticStatus.state !== 'ready') throw new Error(JSON.stringify(result.semanticStatus));
          const picked = result.picked.filter(item => item.channel === 'query').slice(0, 5);
          const rank = picked.findIndex(item => item.id === records[i].id);
          if (rank >= 0) { hits++; reciprocal += 1 / (rank + 1); }
          else failures.push({ split, case: i, query, expected: records[i].text,
            found: picked.map(item => store.raw(item.id).text) });
        }
      }
      for (const query of semanticNegatives.slice(split === 'development' ? 0 : 20, split === 'development' ? 20 : 40)) {
        const result = await runtime.recallAsync(store, ADMIN, query);
        if (!result.picked.some(item => item.channel === 'query')) negativesRejected++;
        else failures.push({ split, negative: query, found: result.picked.map(item => store.raw(item.id).text) });
      }
      latencies.sort((a, b) => a - b);
      summary[split] = { positives: 80, hitAt5: hits / 80, hits, mrrAt5: reciprocal / 80,
        negatives: 20, negativesRejected, negativeRejection: negativesRejected / 20,
        warmP50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]),
        warmP95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]) };
    }
    report.metrics[mode] = { preparedMs, ...summary };
    report.failures[mode] = failures;
    console.log(JSON.stringify({ mode, ...report.metrics[mode] }));
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
}
mkdirSync('.preview', { recursive: true });
writeFileSync(join('.preview', 'semantic-benchmark.json'), JSON.stringify(report, null, 2));
