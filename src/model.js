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
  halfLifeDays: 30, bufferHours: 72, idleMinutes: 20, captureBatch: 12,
  autoExtract: false, maxModelCallsPerDay: 2, maxModelOutputTokens: 2048,
  autoBackup: true, backupKeep: 14, privateWriters: [],
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
  for (const key of ['enabled', 'autoExtract', 'autoBackup']) requireValue(typeof result[key] === 'boolean', 'INVALID_CONFIG', `${key} 必须是布尔值。`);
  for (const [key, min, max] of [
    ['tokenBudget', 256, 12000], ['maxRecall', 1, 20], ['halfLifeDays', 1, 3650],
    ['bufferHours', 1, 720], ['idleMinutes', 1, 1440], ['captureBatch', 1, 100],
    ['maxModelCallsPerDay', 0, 50], ['maxModelOutputTokens', 256, 8192], ['backupKeep', 1, 90],
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
  const status = choice(input.status ?? existing?.status ?? (layer === 'L0' ? 'pending' : 'candidate'),
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
  const sources = existing?.sources ?? [source];
  requireValue(Array.isArray(sources) && sources.length > 0 && sources.length <= 256, 'INVALID_SOURCE', '来源集合无效。');
  sources.forEach(validateSource);
  requireValue(JSON.stringify(sources).length <= 512000, 'PROVENANCE_LIMIT', '来源集合过大，需要人工整理。', 409);
  const canonicalText = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const eventKey = layer === 'L0' ? JSON.stringify(source) : layer === 'L2' ? (occurredAt?.slice(0, 10) ?? 'unknown') : '';
  return {
    id: existing?.id ?? randomUUID(), layer, text, category, kind, status, scope, sessionId,
    source, sources, tags: [...new Set(tags)], parents: [...new Set(parents)],
    factKey, occurredAt,
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

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '这', '那', '一个', '什么', 'the', 'a', 'is', 'and']);
export function terms(text) {
  return [...new Set([...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && !STOP.has(part.segment)).map(part => part.segment))].slice(0, 64);
}
export function estimatedTokens(text) {
  return Buffer.byteLength(text, 'utf8');
}
export function rankMemory(memory, queryTerms, now, halfLifeDays) {
  const words = terms(memory.text + ' ' + memory.tags.join(' '));
  const hits = queryTerms.filter(word => words.includes(word));
  const direct = hits.length / Math.max(1, queryTerms.length);
  const age = Math.max(0, now - Date.parse(memory.reinforcedAt ?? memory.occurredAt ?? memory.createdAt)) / 86400000;
  const freshness = memory.pinned || memory.layer === 'L3' ? 1 : 2 ** (-age / (halfLifeDays * memory.stability));
  return { score: direct * (0.65 + 0.2 * freshness + 0.15 * memory.importance), hits, freshness };
}
