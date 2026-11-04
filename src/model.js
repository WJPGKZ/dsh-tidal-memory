import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const LAYERS = Object.freeze({
  L0: { name: '感知缓冲', directory: 'L0-buffer', file: 'buffer.sqlite3' },
  L1: { name: '工作记忆', directory: 'L1-working', file: 'working.sqlite3' },
  L2: { name: '情景记忆', directory: 'L2-episodes', file: 'episodes.sqlite3' },
  L3: { name: '长期知识', directory: 'L3-long-term', file: 'long-term.sqlite3' },
});
export const DEFAULTS = Object.freeze({
  enabled: true, dataRoot: '', bindings: [], tokenBudget: 3072, maxRecall: 6,
  halfLifeDays: 30, bufferHours: 72, idleMinutes: 20,
  autoCandidates: true, captureAssistant: false, minScore: 0.45, relativeFloor: 0.6,
  injectContext: true, autoBackup: true, backupKeep: 14, privateWriters: [],
});
export class MemoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.status = status;
  }
}
export function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new MemoryError(code, message, status);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export function slug(value) {
  requireValue(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value), 'INVALID_SPACE', '空间名仅允许小写字母、数字、短横线和下划线，最多 64 字符。');
  return value;
}
export function string(value, name, max = 16000, empty = false) {
  requireValue(typeof value === 'string', 'INVALID_INPUT', `${name} 必须是文本。`);
  const clean = value.toWellFormed().trim();
  requireValue((empty || clean.length > 0) && clean.length <= max, 'INVALID_INPUT', `${name} 的长度必须为 ${empty ? 0 : 1}–${max}。`);
  return clean;
}
export function timestamp(value, name) {
  if (value === null || value === undefined || value === '') return null;
  requireValue(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'INVALID_TIME', `${name} 不是有效日期。`);
  return new Date(value).toISOString();
}
export function choice(value, allowed, name) {
  requireValue(allowed.includes(value), 'INVALID_INPUT', `${name} 不受支持。`);
  return value;
}
export function number(value, min, max, name, integer = false) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), 'INVALID_INPUT', `${name} 必须在 ${min}–${max} 之间。`);
  return value;
}
export function configOf(raw = {}) {
  const result = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw).map(([key, value]) =>
    [key, value && typeof value.get === 'function' ? value.get() : value])) };
  delete result.autoExtract;
  delete result.captureBatch;
  delete result.maxModelCallsPerDay;
  delete result.maxModelOutputTokens;
  for (const key of ['enabled', 'injectContext', 'autoBackup', 'autoCandidates', 'captureAssistant']) requireValue(typeof result[key] === 'boolean', 'INVALID_CONFIG', `${key} 必须是布尔值。`);
  for (const key of ['minScore', 'relativeFloor']) number(result[key], 0, 1, key);
  for (const [key, min, max] of [
    ['tokenBudget', 256, 12000], ['maxRecall', 1, 20], ['halfLifeDays', 1, 3650],
    ['bufferHours', 1, 720], ['idleMinutes', 1, 1440], ['backupKeep', 1, 90],
  ]) number(result[key], min, max, key, true);
  requireValue(typeof result.dataRoot === 'string' && (result.dataRoot === '' || isAbsolute(result.dataRoot)), 'INVALID_CONFIG', '数据根目录必须是绝对路径。');
  requireValue(Array.isArray(result.bindings) && result.bindings.length <= 100, 'INVALID_CONFIG', '工作区绑定无效。');
  const seen = new Set(), spaces = new Set();
  result.bindings = result.bindings.map(binding => {
    const cwd = string(binding.cwd, '工作区目录', 2048);
    requireValue(isAbsolute(cwd), 'INVALID_CONFIG', '工作区必须是绝对路径。');
    const key = canonicalCwd(cwd);
    requireValue(!seen.has(key), 'INVALID_CONFIG', '同一工作区不能重复绑定。');
    requireValue(!spaces.has(binding.space), 'INVALID_CONFIG', '一个记忆空间只能绑定一个工作区，避免工作区之间串记忆。');
    seen.add(key);
    spaces.add(binding.space);
    return { cwd: resolve(cwd), space: slug(binding.space) };
  });
  requireValue(Array.isArray(result.privateWriters) && result.privateWriters.every(v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)), 'INVALID_CONFIG', '私人作者列表无效。');
  return result;
}
export function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const p = resolve(cwd);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
export function bindingFor(config, cwd) {
  const key = canonicalCwd(cwd);
  return key ? config.bindings.find(item => canonicalCwd(item.cwd) === key) : undefined;
}
export function validateSource(source) {
  requireValue(source && typeof source === 'object' && !Array.isArray(source), 'INVALID_SOURCE', '来源必须是对象。');
  requireValue(JSON.stringify(source).length <= 20000, 'INVALID_SOURCE', '来源过大。');
  const stack = [source];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    requireValue(value.private !== true, 'PRIVATE_SOURCE', '私人来源不能写入普通记忆。', 403);
    stack.push(...Object.values(value));
  }
  return source;
}
export function normalizeRecord(input, now, existing) {
  const field = name => Object.hasOwn(input, name) ? input[name] : existing?.[name];
  const layer = choice(input.layer ?? existing?.layer, Object.keys(LAYERS), '层级');
  const text = string(input.text ?? existing?.text, '记忆正文');
  const category = choice(input.category ?? existing?.category ?? 'event',
    ['event', 'task', 'preference', 'agreement', 'knowledge', 'identity', 'self', 'observation'], '分类');
  const kind = choice(input.kind ?? existing?.kind ?? 'inference',
    ['user_statement', 'observation', 'inference', 'reflection', 'historical'], '证据性质');
  const status = choice(input.status ?? existing?.status ?? (layer === 'L0' ? 'pending' : 'active'),
    ['pending', 'candidate', 'active', 'review', 'completed', 'cancelled', 'superseded', 'archived', 'processed'], '状态');
  const scope = choice(input.scope ?? existing?.scope ?? 'space', ['space'], '作用域');
  const sessionId = string(input.sessionId ?? existing?.sessionId ?? '', '会话标识', 256, true);
  const source = input.source ?? existing?.source ?? { kind: 'manual' };
  validateSource(source);
  const validFrom = timestamp(field('validFrom'), '生效时间');
  const validUntil = timestamp(field('validUntil'), '失效时间');
  requireValue(!validFrom || !validUntil || Date.parse(validFrom) <= Date.parse(validUntil), 'INVALID_TIME', '失效时间不能早于生效时间。');
  const tags = input.tags ?? existing?.tags ?? [];
  requireValue(Array.isArray(tags) && tags.length <= 20 && tags.every(t => typeof t === 'string' && t.length <= 60), 'INVALID_TAGS', '标签最多 20 个，每个不超过 60 字符。');
  const parents = input.parents ?? existing?.parents ?? [];
  requireValue(Array.isArray(parents) && parents.length <= 40 && parents.every(p => typeof p === 'string' && /^[a-f0-9-]{36}$/.test(p)), 'INVALID_PARENTS', '来源关联必须是有效记忆 ID。');
  const occurredAt = timestamp(field('occurredAt'), '事件时间');
  const factKey = string(input.factKey ?? existing?.factKey ?? '', '事实键', 200, true);
  const horizon = choice(input.horizon ?? existing?.horizon ??
    ({ L1: 'task', L2: 'event', L3: 'long_term' }[layer] ?? 'unspecified'),
  ['unspecified', 'task', 'event', 'long_term'], '记忆期限');
  const taskKey = string(input.taskKey ?? existing?.taskKey ?? '', '任务键', 200, true);
  const sources = existing?.sources ?? [source];
  requireValue(Array.isArray(sources) && sources.length > 0 && sources.length <= 256, 'INVALID_SOURCE', '来源集合无效。');
  sources.forEach(validateSource);
  requireValue(JSON.stringify(sources).length <= 512000, 'PROVENANCE_LIMIT', '来源集合过大，需要人工整理。', 409);
  const canonicalText = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const eventKey = layer === 'L0' ? JSON.stringify(source) : layer === 'L2' ? (occurredAt?.slice(0, 10) ?? 'unknown') : '';
  return {
    id: existing?.id ?? randomUUID(), layer, text, category, kind, status, scope, sessionId,
    source, sources, tags: [...new Set(tags)], parents: [...new Set(parents)],
    factKey, horizon, taskKey, occurredAt,
    validFrom, validUntil,
    importance: number(input.importance ?? existing?.importance ?? 0.5, 0, 1, '重要度'),
    pinned: input.pinned ?? existing?.pinned ?? false,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
    revision: (existing?.revision ?? 0) + 1,
    stability: existing?.stability ?? 1, reinforcedAt: existing?.reinforcedAt ?? null,
    lastEvidenceId: existing?.lastEvidenceId ?? null,
    dedupeKey: hash(JSON.stringify([layer, canonicalText, factKey, eventKey])),
  };
}

const REMEMBER_PREFIX = /^\s*(?:请)?(?:记住|记一下|remember)\s*[:：,，]\s*([\s\S]+?)\s*$/i;
const EVENT_CUE = /(?:上次|之前|去年|昨天|当时|曾经|经历|发生过|遇到过|完成了)/;
const TASK_CUE = /(?:本次任务|这次任务|当前任务|这个任务|此任务|本轮|临时|暂时|待办|要做|需要完成|完成前|这次先|本次先|今天要|明天要|本周要)/;
const LONG_TERM_CUE = /(?:以后|今后|长期|一直|始终|总是|默认|偏好|习惯|我喜欢|我不喜欢|喜欢|不喜欢|每次都)/;

export function classifyRememberDirective(text) {
  if (typeof text !== 'string') return null;
  const match = REMEMBER_PREFIX.exec(text);
  if (!match) return null;
  const content = match[1].trim();
  if (!content) return null;
  if (EVENT_CUE.test(content)) return { text: content, layer: 'L2', horizon: 'event', category: 'event' };
  if (TASK_CUE.test(content)) return { text: content, layer: 'L1', horizon: 'task', category: 'task' };
  if (LONG_TERM_CUE.test(content)) {
    const preference = /(?:偏好|习惯|喜欢|不喜欢)/.test(content);
    return { text: content, layer: 'L3', horizon: 'long_term', category: preference ? 'preference' : 'knowledge' };
  }
  return { text: content, layer: 'L2', horizon: 'unspecified', category: 'knowledge' };
}

// Rules select verbatim statements, not summaries or confirmed facts.
export function localCandidates(text) {
  const plain = text.replace(/```[\s\S]*?(?:```|$)/g, '');
  const result = [];
  for (const match of plain.matchAll(/[^\n。！？!?]+[。！？!?]?/g)) {
    const quote = match[0].trim();
    if (quote.length < 4 || quote.length > 500 || /^[>"“「]/.test(quote) ||
      /[?？]|(?:假设|假如|如果|例如|比如|举例|示例|引用|他说|她说|不要记|不用记|别记)/.test(quote)) continue;
    let rule, layer = 'L3', category = 'knowledge';
    if (/^(?:不对[，,：:]|更正[：:]|纠正[：:]|我说错了[，,：:]|correction:)/i.test(quote)) rule = 'correction';
    else if (/^(?:我(?:更)?(?:喜欢|不喜欢|偏好|习惯)|I (?:prefer|like|dislike)\b)/i.test(quote)) {
      rule = 'preference'; category = 'preference';
    } else if (/^(?:我们(?:约定|说好)|约定[：:]|(?:以后|今后|默认|每次都)|请(?:以后|始终|默认|每次))/i.test(quote)) {
      rule = 'agreement'; category = 'agreement';
    } else if (/^(?:(?:我们|我)?(?:决定|已决定|确定采用|选择)|(?:本次|这次|当前)任务|we decided\b)/i.test(quote)) {
      rule = 'decision'; layer = 'L2'; category = 'event';
    } else if (/^(?:(?:本项目|当前项目|项目|服务|开发服务器|测试环境|构建工具|包管理器|数据库|运行时|仓库).{0,48}?(?:使用|采用|运行在|位于|端口|路径|版本|是)|(?:the )?project uses\b)/i.test(quote)) rule = 'fact';
    if (!rule) continue;
    if (TASK_CUE.test(quote)) { layer = 'L1'; category = 'task'; }
    result.push({ text: quote, rule, layer, category,
      horizon: { L1: 'task', L2: 'event', L3: 'long_term' }[layer] });
    if (result.length === 8) break;
  }
  return result;
}

export const SEARCH_VERSION = 'intl-zh-v3';
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '这', '那', '一个', '什么', 'the', 'a', 'is', 'and']);
export function terms(text, limit = 64) {
  return [...new Set([...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && !STOP.has(part.segment)).map(part => part.segment))].slice(0, limit);
}
export function estimatedTokens(text) {
  return Buffer.byteLength(text, 'utf8');
}
export function rankMemory(memory, queryTerms, now, halfLifeDays, idf = new Map(), idfCeiling = 0) {
  const words = terms(memory.text + ' ' + memory.tags.join(' '), Infinity);
  const hits = queryTerms.filter(word => words.includes(word));
  const weight = word => idf.get(word) ?? 1;
  const totalWeight = queryTerms.reduce((sum, word) => sum + weight(word), 0);
  const direct = hits.reduce((sum, word) => sum + weight(word), 0) / Math.max(Number.EPSILON, totalWeight);
  const age = Math.max(0, now - Date.parse(memory.reinforcedAt ?? memory.occurredAt ?? memory.createdAt)) / 86400000;
  const freshness = memory.pinned || memory.layer === 'L3' ? 1 : 2 ** (-age / (halfLifeDays * memory.stability));
  const specificity = idfCeiling > 0 ? Math.min(1, Math.max(0, ...hits.map(weight)) / idfCeiling) : 1;
  return { score: direct * specificity * (0.65 + 0.2 * freshness + 0.15 * memory.importance), hits, freshness, specificity };
}
