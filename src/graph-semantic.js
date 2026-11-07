import { setImmediate as yieldTurn } from 'node:timers/promises';
import { graphPair, graphReferences } from './graph-index.js';
import { graphNode } from './graph.js';
import { MODEL_PACKS } from './model-packs.js';
import { memoryContentHash, MemoryError, number, requireValue } from './model.js';

const THRESHOLDS = Object.freeze({ cpu: 0.753836, enhanced: 0.688293 });
const BATCH_SIZE = 64;
const MAX_DOCUMENTS = 2000;
const MAX_COMPARISONS = 50000;

export function graphSemanticThreshold(mode, pack) {
  const expected = MODEL_PACKS[mode], threshold = THRESHOLDS[mode];
  if (!expected || !threshold || !pack?.files) return null;
  const weights = Object.entries(pack.files).find(([name]) =>
    name.replaceAll('\\', '/').endsWith(mode === 'cpu' ? '/onnx/model.onnx' : `/${expected.model}`) ||
      name === expected.model);
  return pack.modelId === expected.modelId && pack.dimension === expected.dimension &&
    pack.chunkSize === expected.chunkSize && pack.driver === expected.driver &&
    pack.pooling === expected.pooling && pack.runtimeVersion === expected.runtimeVersion &&
    pack.revision === expected.revision && weights?.[1] === expected.weightHash ? threshold : null;
}

function vectors(index, row, dimension) {
  requireValue(Number.isInteger(row.chunks) && row.chunks > 0 && row.chunks <= 256,
    'SEMANTIC_INDEX_INVALID', '语义索引分块无效，请重建。', 409);
  const rows = index.db.prepare('SELECT vector FROM vectors WHERE id=? ORDER BY part').all(row.id);
  requireValue(rows.length === row.chunks, 'SEMANTIC_INDEX_INVALID', '语义索引分块不完整，请重建。', 409);
  return rows.map(({ vector }) => {
    requireValue(vector.byteLength === dimension * 4, 'SEMANTIC_INDEX_INVALID', '语义索引维数无效，请重建。', 409);
    const values = new Float32Array(Uint8Array.from(vector).buffer);
    requireValue(values.every(Number.isFinite), 'SEMANTIC_INDEX_INVALID', '语义索引数值无效，请重建。', 409);
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    requireValue(Number.isFinite(norm) && Math.abs(norm - 1) <= 0.001,
      'SEMANTIC_INDEX_INVALID', '语义索引向量未归一化，请重建。', 409);
    return values;
  });
}

function similarity(left, right) {
  let score = -1;
  for (const a of left) for (const b of right) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    score = Math.max(score, Math.min(1, dot));
  }
  return score;
}

export async function graphSemanticSuggestions(store, index, pack, options, actor, {
  signal, shouldPause = () => false, validateModel = () => true,
} = {}) {
  const { id, cursor = '', limit = 10, mode = 'current', asOf } = options ?? {};
  requireValue(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) &&
    (!cursor || typeof cursor === 'string' && /^[a-f0-9-]{36}$/.test(cursor)),
  'INVALID_ID', '记忆 ID 或分页游标无效。');
  number(limit, 1, 10, '语义候选每页条数', true);
  const threshold = graphSemanticThreshold(store.config.embeddingMode, pack);
  requireValue(threshold !== null, 'GRAPH_MODEL_UNCALIBRATED', '当前模型未经过图谱文档相似度标定，不能生成语义候选。', 409);
  requireValue(index && !index.closed && index.state === 'ready' && index.status().pending === 0 &&
    index.db.prepare("SELECT value FROM metadata WHERE key='model'").get()?.value === pack.fingerprint,
  'SEMANTIC_NOT_PREPARED', '请先完成当前空间的本地语义索引准备。', 409);
  const scopeOptions = { mode, asOf };
  let scope = store.recallScope(actor, scopeOptions);
  const center = store.rawOrdinary(id);
  requireValue(center && scope.accept(center), 'NOT_FOUND', '找不到此范围和时间内的普通记忆。', 404);
  const centerHash = memoryContentHash(center);
  const document = index.db.prepare('SELECT id,content_hash,chunks FROM documents WHERE id=?').get(id);
  requireValue(document && document.content_hash === centerHash, 'SEMANTIC_NOT_PREPARED',
    '当前记忆的本地语义索引尚未准备，请重新准备。', 409);
  const centerVectors = vectors(index, document, pack.dimension);
  const references = new Set(graphReferences(center).map(ref => ref.id));
  const ignored = store.system.prepare('SELECT state FROM graph_relations WHERE left_id=? AND right_id=?');
  const findDocuments = index.db.prepare('SELECT id,content_hash,chunks FROM documents WHERE id>? ORDER BY id LIMIT ?');
  const startVersion = store.reconciledForgetVersion;
  const check = () => {
    if (signal?.aborted || shouldPause()) throw new MemoryError('GRAPH_PAUSED', '语义候选已让出，请在空闲时重试。', 409);
    requireValue(validateModel() && !index.closed && index.state === 'ready', 'GRAPH_MODEL_CHANGED',
      '模型或语义索引已变化，请重新准备。', 409);
    store.reconcileForgetLedger();
    requireValue(startVersion === store.reconciledForgetVersion && startVersion === store.forgetVersion(),
      'FORGET_CONFLICT', '候选计算期间遗忘标记发生变化，请重试。', 409);
    const current = store.rawOrdinary(id);
    const currentScope = store.recallScope(actor, scopeOptions);
    requireValue(current && currentScope.accept(current) && memoryContentHash(current) === centerHash,
      'GRAPH_OBSOLETE', '中心记忆或有效范围已变化，请重新计算。', 409);
  };
  let last = cursor, scanned = 0, comparisons = 0, done = false;
  const selected = [];
  check();
  while (scanned < MAX_DOCUMENTS && comparisons < MAX_COMPARISONS) {
    const rows = findDocuments.all(last, Math.min(BATCH_SIZE, MAX_DOCUMENTS - scanned));
    if (!rows.length) { done = true; break; }
    let stopped = false;
    for (const row of rows) {
      if (row.id === id) { last = row.id; scanned++; continue; }
      const other = store.rawOrdinary(row.id);
      if (!other || !scope.accept(other) || center.layer !== 'L3' && other.layer !== 'L3' ||
          row.content_hash !== memoryContentHash(other) ||
          ignored.get(...graphPair(id, row.id)) ||
          (center.parents ?? []).includes(row.id) || (other.parents ?? []).includes(id) ||
          graphReferences(other).some(ref => references.has(ref.id))) {
        last = row.id;
        scanned++;
        continue;
      }
      requireValue(Number.isInteger(row.chunks) && row.chunks > 0 && row.chunks <= 256,
        'SEMANTIC_INDEX_INVALID', '语义索引分块无效，请重建。', 409);
      const cost = centerVectors.length * row.chunks;
      requireValue(cost <= MAX_COMPARISONS, 'GRAPH_NODE_TOO_LARGE',
        '这两条记忆的分块过多，无法在有界任务中比较；可使用明确关联。', 409);
      if (comparisons + cost > MAX_COMPARISONS && scanned) { stopped = true; break; }
      const otherVectors = vectors(index, row, pack.dimension);
      const score = similarity(centerVectors, otherVectors);
      comparisons += cost;
      last = row.id;
      scanned++;
      if (score >= threshold) {
        selected.push({ id: row.id, contentHash: row.content_hash, score });
        selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (selected.length > limit) selected.pop();
      }
    }
    if (stopped) break;
    if (rows.length < BATCH_SIZE && scanned < MAX_DOCUMENTS) { done = true; break; }
    await yieldTurn();
    check();
  }
  check();
  scope = store.recallScope(actor, scopeOptions);
  const items = [];
  for (const item of selected) {
    const current = store.rawOrdinary(item.id);
    if (!current || !scope.accept(current) || memoryContentHash(current) !== item.contentHash ||
        ignored.get(...graphPair(id, item.id))) continue;
    items.push({ ...graphNode(current), relation: { kind: 'semantic', label: '可能相关（本地语义）',
      score: Number(item.score.toFixed(4)) } });
  }
  const result = { center: graphNode(store.rawOrdinary(id)), items, nextCursor: done ? null : last,
    scanned, comparisons, threshold, model: pack.modelId,
    note: '语义相似仅供导航，不代表事实相同或已核实；多分块取最高相似度，可能产生误报。' };
  check();
  return result;
}
