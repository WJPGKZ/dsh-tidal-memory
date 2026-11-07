import { graphDecisionHash, graphPair, graphReferences } from './graph-index.js';
import { choice, MemoryError, number, requireValue, string } from './model.js';

const relationLabels = {
  source: '来源关联', topic: '同一主题', tag: '同一标签', fact: '同一事实键',
  task: '同一任务键', alias: '同一别名', scene: '同一情景',
  confirmed: '人工确认关联', excluded: '人工排除关联', stale: '人工确认已过期',
};
const relationTypes = Object.keys(relationLabels);
const normalized = value => value.toWellFormed().normalize('NFKC').trim().toLowerCase();
const idValue = id => {
  requireValue(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'INVALID_ID', '记忆 ID 无效。');
  return id;
};
export const graphNode = record => ({
  id: record.id, layer: record.layer, text: [...record.text].slice(0, 180).join(''),
  truncated: [...record.text].length > 180, status: record.status, kind: record.kind,
  category: record.category, topics: record.topics ?? [], tags: record.tags ?? [],
  occurredAt: record.occurredAt ?? null, updatedAt: record.updatedAt, revision: record.revision,
});

function recordInScope(store, id, scope) {
  const record = store.rawOrdinary(idValue(id));
  requireValue(record && scope.accept(record), 'NOT_FOUND', '找不到此范围和时间内的普通记忆。', 404);
  return record;
}

function decisionFor(store, a, b) {
  const [left, right] = graphPair(a.id, b.id);
  return store.system.prepare('SELECT * FROM graph_relations WHERE left_id=? AND right_id=?').get(left, right) ?? null;
}

function relationFor(store, center, other, reasons) {
  const decision = decisionFor(store, center, other);
  if (decision?.state === 'excluded') return { kind: 'excluded', label: relationLabels.excluded,
    evidence: null, decision: 'excluded', stale: false };
  if (decision?.state === 'confirmed') {
    const [left, right] = graphPair(center.id, other.id);
    const leftRecord = left === center.id ? center : other;
    const rightRecord = right === center.id ? center : other;
    const stale = graphDecisionHash(leftRecord) !== decision.left_hash ||
      graphDecisionHash(rightRecord) !== decision.right_hash;
    return { kind: stale ? 'stale' : 'confirmed', label: relationLabels[stale ? 'stale' : 'confirmed'],
      evidence: null, decision: 'confirmed', stale };
  }
  const actual = new Set(graphReferences(other).map(ref => ref.id));
  for (const reason of reasons) {
    if (reason.kind === 'source' &&
      ((center.parents ?? []).includes(other.id) || (other.parents ?? []).includes(center.id)))
      return { kind: 'source', label: relationLabels.source, evidence: null, decision: null, stale: false };
    if (reason.id && actual.has(reason.id)) return { kind: reason.kind, label: relationLabels[reason.kind],
      evidence: reason.label, decision: null, stale: false };
  }
  return null;
}

function neighborsOnce(store, { id, cursor = '', limit = 50, mode = 'current', asOf,
  includeArchived = false } = {}, actor) {
  idValue(id);
  if (cursor) idValue(cursor);
  number(limit, 1, 50, '关联每页条数', true);
  requireValue(typeof includeArchived === 'boolean', 'INVALID_INPUT', '归档选项必须是布尔值。');
  const scope = store.recallScope(actor, { mode, asOf, includeArchived });
  const center = recordInScope(store, id, scope);
  const index = store.graph();
  const candidates = index.candidates(center, { cursor, limit: 200 });
  const items = [];
  let last = cursor, stopped = false;
  for (let i = 0; i < candidates.items.length; i++) {
    const candidate = candidates.items[i];
    last = candidate.id;
    const other = store.rawOrdinary(candidate.id);
    if (!other || !scope.accept(other) || center.layer !== 'L3' && other.layer !== 'L3') continue;
    const relation = relationFor(store, center, other, candidate.reasons);
    if (!relation) continue;
    items.push({ ...graphNode(other), relation });
    if (items.length >= limit) {
      stopped = i < candidates.items.length - 1 || candidates.nextCursor !== null;
      break;
    }
  }
  return { center: graphNode(center), items,
    nextCursor: stopped ? last : candidates.nextCursor, mode, asOf: scope.at, index: index.status() };
}

export function graphNeighbors(store, options, actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    store.reconcileForgetLedger();
    const version = store.reconciledForgetVersion;
    const result = neighborsOnce(store, options, actor);
    if (version === store.forgetVersion()) return result;
  }
  throw new MemoryError('FORGET_CONFLICT', '读取图谱期间遗忘标记持续变化，请稍后重试。', 409);
}

function matchesRelation(store, id, filter, scopeOptions, actor) {
  let cursor = '';
  for (let page = 0; page < 4; page++) {
    const result = neighborsOnce(store, { id, cursor, limit: 50, ...scopeOptions }, actor);
    const relevant = result.items.filter(item => !['excluded', 'stale'].includes(item.relation.kind));
    if (filter === 'isolated' && relevant.length) return { matches: false, incomplete: false };
    if (filter !== 'isolated' && result.items.some(item => item.relation.kind === filter))
      return { matches: true, incomplete: false };
    if (!result.nextCursor) return { matches: filter === 'isolated', incomplete: false };
    cursor = result.nextCursor;
  }
  return { matches: false, incomplete: true };
}

function listOnce(store, { layer = 'L3', status = 'active', query = '', topic = '',
  relation = 'all', cursor = '', limit = 50 } = {}, actor) {
  choice(layer, ['L1', 'L2', 'L3'], '图谱层级');
  choice(status, ['active', 'archived', 'superseded', 'completed', 'cancelled'], '图谱状态');
  choice(relation, ['all', 'isolated', ...relationTypes], '图谱关系类型');
  number(limit, 1, 50, '图谱每页条数', true);
  if (cursor) idValue(cursor);
  const q = normalized(string(query, '图谱搜索', 1000, true));
  const label = normalized(string(topic, '主题或标签', 60, true));
  const scopeOptions = status === 'active' ? { mode: 'current' } : { mode: 'history' };
  const scope = store.recallScope(actor, scopeOptions);
  const index = store.graph();
  const statement = store.db(layer).prepare('SELECT data FROM memories WHERE status=? AND id>? ORDER BY id LIMIT 100');
  const items = [];
  let last = cursor, scanned = 0, more = false, incomplete = false;
  while (scanned < 1000 && items.length < limit) {
    const rows = statement.all(status, last);
    if (!rows.length) { more = false; break; }
    more = rows.length === 100;
    for (let i = 0; i < rows.length; i++) {
      const record = JSON.parse(rows[i].data);
      last = record.id;
      scanned++;
      if (!scope.accept(record)) continue;
      const labels = [...(record.topics ?? []), ...(record.tags ?? [])];
      if (q && ![record.text, ...labels, ...(record.aliases ?? [])].some(value => normalized(value).includes(q))) continue;
      if (label && !labels.some(value => normalized(value) === label)) continue;
      if (relation !== 'all') {
        const match = matchesRelation(store, record.id, relation, scopeOptions, actor);
        incomplete ||= match.incomplete;
        if (!match.matches) continue;
      }
      items.push(graphNode(record));
      if (items.length >= limit || scanned >= 1000) {
        more = i < rows.length - 1 || more;
        break;
      }
    }
    if (rows.length < 100) break;
  }
  return { items, nextCursor: more ? last : null, scanned, incomplete, index: index.status() };
}

export function graphList(store, options, actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    store.reconcileForgetLedger();
    const version = store.reconciledForgetVersion;
    const result = listOnce(store, options, actor);
    if (version === store.forgetVersion()) return result;
  }
  throw new MemoryError('FORGET_CONFLICT', '读取图谱期间遗忘标记持续变化，请稍后重试。', 409);
}

export function graphDecision(store, { id, otherId, decision, revision, otherRevision } = {}, actor) {
  requireValue(actor?.admin === true, 'FORBIDDEN', '图谱修正仅限管理界面。', 403);
  idValue(id);
  idValue(otherId);
  requireValue(id !== otherId, 'INVALID_INPUT', '不能关联同一条记忆。');
  choice(decision, ['confirmed', 'excluded', 'reset'], '图谱修正');
  store.reconcileForgetLedger();
  const version = store.reconciledForgetVersion;
  const scope = store.recallScope(actor, { mode: 'history' });
  const first = recordInScope(store, id, scope), second = recordInScope(store, otherId, scope);
  if (revision !== undefined) number(revision, 1, Number.MAX_SAFE_INTEGER, '中心记忆版本', true);
  if (otherRevision !== undefined) number(otherRevision, 1, Number.MAX_SAFE_INTEGER, '关联记忆版本', true);
  requireValue((revision === undefined || revision === first.revision) &&
    (otherRevision === undefined || otherRevision === second.revision),
  'REVISION_CONFLICT', '记忆已变化，请刷新节点后重新修正关联。', 409);
  requireValue(first.layer === 'L3' || second.layer === 'L3', 'INVALID_RELATION',
    '图谱关联至少需要一条 L3 记忆。');
  const [left, right] = graphPair(first.id, second.id);
  if (decision === 'reset') store.system.prepare('DELETE FROM graph_relations WHERE left_id=? AND right_id=?').run(left, right);
  else {
    const leftRecord = left === first.id ? first : second;
    const rightRecord = right === first.id ? first : second;
    store.system.prepare(`INSERT OR REPLACE INTO graph_relations
      (left_id,right_id,state,left_hash,right_hash,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(left, right, decision, graphDecisionHash(leftRecord), graphDecisionHash(rightRecord), store.now());
  }
  store.generation++;
  if (version !== store.forgetVersion()) {
    store.reconciledForgetVersion = null;
    store.reconcileForgetLedger();
    throw new MemoryError('FORGET_CONFLICT', '图谱修正期间遗忘标记发生变化，请刷新后重试。', 409);
  }
  return { leftId: left, rightId: right, decision };
}

export function confirmedGraphNeighbors(store, center, scope) {
  const forward = store.system.prepare(`SELECT * FROM graph_relations
    WHERE left_id=? AND state='confirmed' ORDER BY right_id LIMIT 30`).all(center.id);
  const reverse = store.system.prepare(`SELECT * FROM graph_relations
    WHERE right_id=? AND state='confirmed' ORDER BY left_id LIMIT 30`).all(center.id);
  const rows = [...forward, ...reverse].sort((a, b) =>
    (a.left_id === center.id ? a.right_id : a.left_id).localeCompare(
      b.left_id === center.id ? b.right_id : b.left_id)).slice(0, 30);
  const result = [];
  for (const row of rows) {
    const other = store.rawOrdinary(row.left_id === center.id ? row.right_id : row.left_id);
    if (!other || !scope.accept(other) || center.layer !== 'L3' && other.layer !== 'L3') continue;
    const left = row.left_id === center.id ? center : other;
    const right = row.right_id === center.id ? center : other;
    if (graphDecisionHash(left) !== row.left_hash || graphDecisionHash(right) !== row.right_hash) continue;
    result.push(other);
  }
  return result;
}
