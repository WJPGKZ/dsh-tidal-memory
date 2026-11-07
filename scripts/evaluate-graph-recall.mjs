import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemorySpace } from '../src/store.js';
import { LocalEmbedding } from '../src/embedding.js';
import { SemanticIndex } from '../src/semantic-index.js';
import { normalizeRecord } from '../src/model.js';
import { semanticCases, semanticNegatives } from '../tests/semantic-fixtures.mjs';
import { documentPairs } from '../tests/graph-semantic-fixtures.mjs';

if (!process.env.TIDAL_MODEL_ROOT) throw new Error('Set TIDAL_MODEL_ROOT to the installed local model data root.');
const split = process.env.TIDAL_GRAPH_SPLIT || 'heldout';
if (!['development', 'heldout', 'challenge'].includes(split))
  throw new Error('TIDAL_GRAPH_SPLIT must be development, heldout or challenge.');
const baselineCommit = 'ab433ff697d8d5279037a126595e59a7e57ce80d';
const temporary = mkdtempSync(join(tmpdir(), 'tidal-graph-evaluation-'));
const baselineSource = join(temporary, 'baseline'), archive = join(temporary, 'baseline.tar');
const now = Date.parse('2026-03-10T12:00:00Z'), admin = { admin: true }, reader = { sessionId: 'synthetic-evaluator' };
const modes = ['off', 'cpu', 'enhanced'];
let failed = false;
try {
  mkdirSync(baselineSource);
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, baselineCommit], { stdio: 'pipe' });
  execFileSync('tar', ['-xf', archive, '-C', baselineSource], { stdio: 'pipe' });
  const { MemorySpace: BaselineSpace } = await import(pathToFileURL(join(baselineSource, 'src', 'store.js')).href);
  for (const mode of modes) {
    const root = join(temporary, mode), config = { autoBackup: false, embeddingMode: mode };
    const baseline = new BaselineSpace(join(root, 'baseline-data'), 'shared', { clock: () => now, config });
    const current = new MemorySpace(join(root, 'current-data'), 'shared', { clock: () => now, config });
    const embedding = mode === 'off' ? null : new LocalEmbedding(root);
    try {
      const add = input => {
        const record = normalizeRecord({ status: 'active', kind: 'user_statement',
          source: { kind: 'synthetic-fixture' }, ...input }, new Date(now).toISOString());
        baseline.persist(record);
        current.persist(record);
        return record;
      };
      const cases = [];
      for (let i = 0; i < 40; i++) {
        const number = String(i).padStart(3, '0');
        const code = `${split === 'development' ? 'GX' : split === 'heldout' ? 'HZ' : 'CZ'}${number}`;
        const project = `${split === 'development' ? '合成主题' : split === 'heldout' ? '虚构专题' : '模拟议题'}${number}`;
        const topics = i % 2 ? [] : [project];
        const seed = add({ layer: 'L3', text: `合成项目的识别码为 ${code}，名称是${project}。`, topics });
        const target = add({ layer: 'L2', text: split === 'development' ?
          `${project}的虚构背景是测试材料 ${number}，用于说明关联资料。` :
          split === 'heldout' ? `${project}的阶段约定是执行虚构步骤 ${number}。` :
            `${project}的补充说明为合成步骤 ${number}。`, topics });
        current.graphDecision({ id: seed.id, otherId: target.id, decision: 'confirmed' }, admin);
        const query = split === 'development' ? code :
          [code, `记录 ${code}`, `${code} 的关联资料`, `请回顾 ${code}`][Math.floor(i / 10)];
        cases.push({ kind: 'applicable', query, target: target.id, seed: seed.id });
      }
      for (let i = 0; i < 40; i++) {
        const [text, rewrite] = split === 'development' ?
          [semanticCases[i][0], semanticCases[i][1][2 + i % 2]] :
          split === 'heldout' ? documentPairs[20 + i] :
            [`模拟直接记录 DY${i} 的执行方案是本机处理。`, `DY${i} 的执行方案是什么？`];
        const target = add({ layer: 'L2', text: split === 'development' ? `合成：${text}` : text });
        cases.push({ kind: 'direct', query: rewrite, target: target.id });
      }
      for (let i = 0; i < 20; i++) {
        const number = String(i).padStart(3, '0');
        const code = `${split === 'development' ? 'NX' : split === 'heldout' ? 'NY' : 'NC'}${number}`;
        const seed = add({ layer: split === 'challenge' ? 'L3' : 'L2',
          text: `合成主体甲 ${code} 在 2024 年不使用工具 ${number}。` });
        const distractor = add({ layer: split === 'challenge' ? 'L2' : 'L3',
          text: `合成主体乙在 2025 年使用工具 ${number}。`,
          topics: i % 2 ? [] : [`共同话题${number}`] });
        if (split === 'challenge')
          current.graphDecision({ id: seed.id, otherId: distractor.id, decision: 'confirmed' }, admin);
        cases.push({ kind: 'hard-negative', query: `${code} 主体甲在 2024 年不用什么？`, target: seed.id,
          prohibited: split === 'challenge' ? distractor.id : null });
      }
      for (const query of semanticNegatives.slice(split === 'development' ? 20 : 0, split === 'development' ? 40 : 20))
        cases.push({ kind: 'hard-negative', query, target: null });
      assert.equal(cases.length, 120);
      await current.graph().sync();
      const semantic = new Map();
      if (embedding) {
        embedding.configure({ embeddingMode: mode, embeddingDevice: process.env.TIDAL_BENCH_DEVICE || 'auto',
          embeddingModelPath: join(process.env.TIDAL_MODEL_ROOT, 'models',
            mode === 'cpu' ? 'bge-small-zh-v1.5' : 'qwen3-embedding-0.6b') });
        current.semanticIndex = new SemanticIndex(current);
        await current.semanticIndex.sync(embedding);
        const pack = embedding.pack, queries = cases.map(item => item.query), vectors = [];
        for (let offset = 0; offset < queries.length; offset += 16)
          vectors.push(...await embedding.embed(queries.slice(offset, offset + 16), 'query'));
        const scope = current.recallScope(reader, {});
        cases.forEach((item, index) => semantic.set(item.query, current.semanticIndex.search(
          [{ vector: vectors[index], contextIndex: 0 }], pack, { accept: scope.accept })));
      }
      for (const residentBudget of [0, 16000]) {
        baseline.setConfig({ ...baseline.config, residentBudget });
        current.setConfig({ ...current.config, residentBudget, graphRecall: false });
        const stats = { queries: cases.length, applicable: 0, applicableBaselineHits: 0, applicableGraphHits: 0,
          baselineTargetHits: 0, graphTargetHits: 0, additions: 0, relevantAdditions: 0,
          hardNegatives: 0, hardNegativeAdditions: 0, hardNegativesWithEdge: 0,
          hardNegativeSeedHits: 0, hardNegativeEdgeAdditions: 0 };
        for (const item of cases) {
          const options = { semantic: semantic.get(item.query) ?? [] };
          const old = baseline.recall(item.query, reader, options);
          const before = current.recall(item.query, reader, options);
          assert.equal(before.text, old.text, `${mode}/${residentBudget}: baseline text changed`);
          assert.deepEqual(before.picked.map(value => value.id), old.picked.map(value => value.id),
            `${mode}/${residentBudget}: baseline order changed`);
          current.setConfig({ ...current.config, graphRecall: true });
          const after = current.recall(item.query, reader, options);
          current.setConfig({ ...current.config, graphRecall: false });
          assert.equal(after.text.slice(0, before.text.length), before.text);
          assert.deepEqual(after.picked.slice(0, before.picked.length).map(value => value.id),
            before.picked.map(value => value.id));
          assert.ok(after.estimatedTokens <= after.budget);
          const added = after.picked.slice(before.picked.length);
          const beforeHit = item.target && before.picked.some(value => value.id === item.target);
          const afterHit = item.target && after.picked.some(value => value.id === item.target);
          stats.baselineTargetHits += Number(Boolean(beforeHit));
          stats.graphTargetHits += Number(Boolean(afterHit));
          stats.additions += added.length;
          stats.relevantAdditions += added.filter(value => item.target && value.id === item.target).length;
          if (item.kind === 'applicable') {
            stats.applicable++;
            stats.applicableBaselineHits += Number(Boolean(beforeHit));
            stats.applicableGraphHits += Number(Boolean(afterHit));
          }
          if (item.kind === 'hard-negative') {
            stats.hardNegatives++;
            stats.hardNegativeAdditions += added.length;
            if (item.prohibited) {
              stats.hardNegativesWithEdge++;
              stats.hardNegativeSeedHits += Number(before.picked.some(value => value.id === item.target));
              stats.hardNegativeEdgeAdditions += Number(added.some(value => value.id === item.prohibited));
            }
          }
        }
        const improvementPoints = 100 * (stats.applicableGraphHits - stats.applicableBaselineHits) / stats.applicable;
        const additionPrecision = stats.additions ? stats.relevantAdditions / stats.additions : null;
        const passed = improvementPoints >= 10 && additionPrecision !== null && additionPrecision >= 0.95 &&
          stats.hardNegativeAdditions === 0;
        if (!passed) failed = true;
        console.log(JSON.stringify({ split, mode, residentBudget, ...stats, improvementPoints, additionPrecision, passed,
          note: 'Synthetic queries and manually confirmed edges; not a claim about real conversations.' }));
      }
    } finally {
      if (embedding) await embedding.close();
      baseline.close();
      current.close();
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
