import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalEmbedding } from '../src/embedding.js';

for (const mode of ['cpu', 'enhanced']) {
  test(`installed ${mode} pack performs offline normalized retrieval`, {
    skip: !process.env.TIDAL_MODEL_ROOT, timeout: 180000,
  }, async t => {
    const model = new LocalEmbedding(process.env.TIDAL_MODEL_ROOT);
    let enginePid;
    model.configure({ embeddingMode: mode, embeddingModelPath: '', embeddingDevice: 'auto' });
    try {
      const started = performance.now();
      const documents = await model.embed(['这个项目使用 SQLite 数据库存储用户信息。', '周末去公园看樱花。']);
      const queries = await model.embed(['用户数据放在哪种数据库里？'], 'query');
      for (const vector of [...documents, ...queries]) {
        assert.equal(vector.length, mode === 'cpu' ? 512 : 1024);
        assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.00001);
      }
      const scores = documents.map(vector => vector.reduce((sum, value, i) => sum + value * queries[0][i], 0));
      assert.ok(scores[0] > scores[1], JSON.stringify(scores));
      t.diagnostic(JSON.stringify({ mode, coldAndQueryMs: Math.round(performance.now() - started), scores }));
      assert.equal(model.state.ready, true);
      const uncommon = await model.embed(['𠀀'.repeat(mode === 'cpu' ? 384 : 1024)], 'query');
      assert.equal(uncommon[0].length, documents[0].length);
      enginePid = model.worker.enginePid;
    } finally { await model.close(); }
    assert.equal(model.worker, null);
    if (enginePid) assert.throws(() => process.kill(enginePid, 0), { code: 'ESRCH' });
  });
}
