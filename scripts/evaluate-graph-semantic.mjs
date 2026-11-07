import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEmbedding } from '../src/embedding.js';
import { graphSemanticThreshold } from '../src/graph-semantic.js';
import { memorySearchText } from '../src/model.js';
import { documentEvaluation } from '../tests/graph-semantic-fixtures.mjs';

if (!process.env.TIDAL_MODEL_ROOT) throw new Error('Set TIDAL_MODEL_ROOT to the installed local model data root.');
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const measure = (rows, threshold) => {
  const selected = rows.filter(row => row.score >= threshold);
  const hits = selected.filter(row => row.relevant).length;
  return { pairs: rows.length, relevant: rows.filter(row => row.relevant).length, selected: selected.length,
    hits, falsePositives: selected.length - hits, precision: selected.length ? hits / selected.length : null,
    recall: hits / rows.filter(row => row.relevant).length };
};
for (const mode of ['cpu', 'enhanced']) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-graph-semantic-eval-'));
  const embedding = new LocalEmbedding(root);
  try {
    embedding.configure({ embeddingMode: mode, embeddingDevice: process.env.TIDAL_BENCH_DEVICE || 'auto',
      embeddingModelPath: join(process.env.TIDAL_MODEL_ROOT, 'models',
        mode === 'cpu' ? 'bge-small-zh-v1.5' : 'qwen3-embedding-0.6b') });
    const pack = await embedding.ready();
    const sets = Object.fromEntries(['development', 'validation', 'heldout'].map(split => [split, documentEvaluation(split)]));
    const texts = [...new Set(Object.values(sets).flatMap(rows => rows.flatMap(row => [row.left, row.right])))];
    const vectors = new Map();
    for (let offset = 0; offset < texts.length; offset += 16) {
      const batch = texts.slice(offset, offset + 16);
      const result = await embedding.embed(batch.map(text => memorySearchText({ text })), 'document');
      batch.forEach((text, index) => vectors.set(text, result[index]));
    }
    const scored = Object.fromEntries(Object.entries(sets).map(([split, rows]) => [split,
      rows.map(row => ({ ...row, score: dot(vectors.get(row.left), vectors.get(row.right)) }))]));
    const candidates = [...new Set(scored.development.map(row => row.score))].sort((a, b) => a - b);
    const developmentThreshold = candidates.find(value => {
      const result = measure(scored.development, value);
      return result.hits >= 4 && result.falsePositives === 0;
    });
    const threshold = graphSemanticThreshold(mode, pack);
    assert.notEqual(threshold, null, `Installed ${mode} pack is not calibrated for graph suggestions.`);
    const report = { mode, modelId: pack.modelId, threshold, developmentThreshold: developmentThreshold ?? null,
      development: measure(scored.development, threshold),
      validation: measure(scored.validation, threshold),
      heldout: measure(scored.heldout, threshold),
      note: 'Synthetic document-pair navigation labels; similarity is not factual equivalence or final answer quality.' };
    console.log(JSON.stringify(report));
    assert.ok(report.heldout.hits >= 4 && report.heldout.precision >= 0.95,
      `${mode} graph suggestion threshold did not meet the synthetic held-out precision check.`);
  } finally { await embedding.close(); rmSync(root, { recursive: true, force: true }); }
}
