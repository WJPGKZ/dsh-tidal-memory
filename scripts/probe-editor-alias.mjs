import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TidalRuntime, ADMIN } from '../src/runtime.js';

if (!process.env.TIDAL_MODEL_ROOT) throw new Error('Set TIDAL_MODEL_ROOT to the installed local model data root.');
const cases = [
  { memory: '我写代码用 neovim。', query: '编辑器是 nvim', alias: 'nvim' },
  { memory: '我的编辑器是 nvim。', query: '写代码用 neovim', alias: 'neovim' },
];
const report = { generatedAt: new Date().toISOString(), cases, modes: {} };
for (const mode of ['off', 'cpu', 'enhanced']) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-editor-probe-'));
  const config = { dataRoot: root, embeddingMode: mode, residentBudget: 0, autoBackup: false,
    ...(mode === 'off' ? {} : { embeddingModelPath: join(process.env.TIDAL_MODEL_ROOT, 'models',
      mode === 'cpu' ? 'bge-small-zh-v1.5' : 'qwen3-embedding-0.6b') }) };
  const runtime = new TidalRuntime({ agents: { list: () => [] }, logger: { warn: line => console.error(line) } }, config, root);
  try {
    report.modes[mode] = [];
    for (const [index, item] of cases.entries()) {
      const store = runtime.space(`case-${index}`);
      let record = store.create({ layer: 'L2', text: item.memory, kind: 'user_statement',
        source: { kind: 'synthetic-fixture' } }, ADMIN);
      const probe = async () => {
        const result = await runtime.recallAsync(store, ADMIN, item.query);
        const hit = result.picked.find(row => row.id === record.id);
        return { matched: Boolean(hit?.matched), channel: hit?.channel ?? null,
          semanticScore: hit?.semanticScore ?? null, state: result.semanticStatus.state,
          code: result.semanticStatus.code ?? null };
      };
      const withoutAlias = await probe();
      record = store.update(record.id, { aliases: [item.alias] }, record.revision, ADMIN);
      const withAlias = await probe();
      report.modes[mode].push({ withoutAlias, withAlias });
    }
    console.log(JSON.stringify({ mode, results: report.modes[mode] }));
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
}
mkdirSync('.preview', { recursive: true });
writeFileSync(join('.preview', 'editor-alias-probe.json'), JSON.stringify(report, null, 2));
