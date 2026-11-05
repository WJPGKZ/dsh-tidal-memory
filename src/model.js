import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const LAYERS = Object.freeze({
  L0: { name: '感知缓冲', directory: 'L0-buffer', file: 'buffer.sqlite3' },
  L1: { name: '工作记忆', directory: 'L1-working', file: 'working.sqlite3' },
  L2: { name: '情景记忆', directory: 'L2-episodes', file: 'episodes.sqlite3' },
  L3: { name: '长期知识', directory: 'L3-long-term', file: 'long-term.sqlite3' },
});
export const MAX_RECALL_QUERY_LENGTH = 16000;
export const MAX_CONTEXT_BUDGET = 192000;
export const DEFAULTS = Object.freeze({
  enabled: true, dataRoot: '', bindings: [], tokenBudget: 48000, maxRecall: 30,
  residentMode: 'all', residentBudget: 16000, contextMessages: 5,
  autoConsolidate: true, autoArchive: false,
  dailyConsolidateAt: '03:00', workingHours: 24,
  halfLifeDays: 30, bufferHours: 72, idleMinutes: 20,
  autoCandidates: true, captureAssistant: false, minScore: 0.28, relativeFloor: 0.6,
  injectContext: true, autoBackup: true, backupKeep: 14, privateWriters: [],
});
export const MAX_PROVENANCE_ITEMS = 10000;
export const MAX_PROVENANCE_BYTES = 16 * 1024 * 1024;
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
  for (const key of ['enabled', 'injectContext', 'autoBackup', 'autoCandidates', 'captureAssistant', 'autoConsolidate', 'autoArchive']) requireValue(typeof result[key] === 'boolean', 'INVALID_CONFIG', `${key} 必须是布尔值。`);
  choice(result.residentMode, ['all', 'core', 'pinned'], 'L3 常驻模式');
  requireValue(typeof result.dailyConsolidateAt === 'string' &&
    (result.dailyConsolidateAt === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result.dailyConsolidateAt)),
  'INVALID_CONFIG', '每日深度整理时间必须是 HH:mm 格式或留空关闭。');
  for (const key of ['minScore', 'relativeFloor']) number(result[key], 0, 1, key);
  for (const [key, min, max] of [
    ['tokenBudget', 256, MAX_CONTEXT_BUDGET], ['maxRecall', 1, 100],
    ['residentBudget', 0, MAX_CONTEXT_BUDGET], ['contextMessages', 1, 10], ['halfLifeDays', 1, 3650],
    ['workingHours', 0, 8760],
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
export function defaultImportance(category) {
  return ({ identity: 0.9, agreement: 0.9, preference: 0.85, knowledge: 0.65,
    task: 0.7, self: 0.6, event: 0.5, observation: 0.4 })[category] ?? 0.5;
}
export function residentMemory(record, mode) {
  return record.layer === 'L3' && (record.pinned || mode === 'all' ||
    (mode === 'core' && ['identity', 'preference', 'agreement'].includes(record.category)));
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
  const expiredAt = timestamp(Object.hasOwn(input, 'expiredAt') ? input.expiredAt :
    Object.hasOwn(input, 'status') ? null : existing?.expiredAt, '自动到期归档时间');
  requireValue(!validFrom || !validUntil || Date.parse(validFrom) <= Date.parse(validUntil), 'INVALID_TIME', '失效时间不能早于生效时间。');
  const tags = input.tags ?? existing?.tags ?? [];
  requireValue(Array.isArray(tags) && tags.length <= 20 && tags.every(t => typeof t === 'string' && t.length <= 60), 'INVALID_TAGS', '标签最多 20 个，每个不超过 60 字符。');
  const aliases = input.aliases ?? existing?.aliases ?? [];
  requireValue(Array.isArray(aliases) && aliases.length <= 40 &&
    aliases.every(t => typeof t === 'string' && t.length > 0 && t.length <= 120),
  'INVALID_ALIASES', '实体别名最多 40 个，每个 1–120 字符。');
  const claim = Object.hasOwn(input, 'claim') ? input.claim :
    input.text !== undefined && input.text !== existing?.text ? null : existing?.claim ?? null;
  if (claim !== null) {
    requireValue(claim && typeof claim === 'object' && !Array.isArray(claim), 'INVALID_CLAIM', '事实结构无效。');
    for (const key of ['subject', 'predicate', 'value']) string(claim[key], key, 200);
    choice(claim.polarity, ['positive', 'negative'], '事实极性');
    requireValue(claim.scope === 'space', 'INVALID_CLAIM', '事实必须属于当前空间。');
  }
  const parents = input.parents ?? existing?.parents ?? [];
  requireValue(Array.isArray(parents) && parents.length <= MAX_PROVENANCE_ITEMS && parents.every(p => typeof p === 'string' && /^[a-f0-9-]{36}$/.test(p)), 'INVALID_PARENTS', '来源关联必须是有效记忆 ID。');
  const occurredAt = timestamp(field('occurredAt'), '事件时间');
  const factKey = string(input.factKey ?? existing?.factKey ?? '', '事实键', 200, true);
  const horizon = choice(input.horizon ?? existing?.horizon ??
    ({ L1: 'task', L2: 'event', L3: 'long_term' }[layer] ?? 'unspecified'),
  ['unspecified', 'task', 'event', 'long_term'], '记忆期限');
  const taskKey = string(input.taskKey ?? existing?.taskKey ?? '', '任务键', 200, true);
  const sources = existing?.sources ?? [source];
  requireValue(Array.isArray(sources) && sources.length > 0 && sources.length <= MAX_PROVENANCE_ITEMS, 'INVALID_SOURCE', '来源集合无效。');
  sources.forEach(validateSource);
  requireValue(JSON.stringify(sources).length <= MAX_PROVENANCE_BYTES, 'PROVENANCE_LIMIT', '来源集合过大，需要人工整理。', 409);
  const canonicalText = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const eventKey = layer === 'L0' ? JSON.stringify(source) : layer === 'L2' ? (occurredAt?.slice(0, 10) ?? 'unknown') : '';
  return {
    id: existing?.id ?? randomUUID(), layer, text, category, kind, status, scope, sessionId,
    source, sources, tags: [...new Set(tags)], aliases: [...new Set(aliases)], claim,
    parents: [...new Set(parents)],
    factKey, horizon, taskKey, occurredAt,
    validFrom, validUntil, expiredAt,
    importance: number(input.importance ?? existing?.importance ?? defaultImportance(category), 0, 1, '重要度'),
    pinned: input.pinned ?? existing?.pinned ?? false,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
    revision: (existing?.revision ?? 0) + 1,
    stability: existing?.stability ?? 1, reinforcedAt: existing?.reinforcedAt ?? null,
    lastEvidenceId: existing?.lastEvidenceId ?? null,
    recallCount: number(existing?.recallCount ?? 0, 0, Number.MAX_SAFE_INTEGER, '召回次数', true),
    lastRecalledAt: timestamp(existing?.lastRecalledAt, '最近召回时间'),
    dedupeKey: hash(JSON.stringify([layer, canonicalText, factKey, eventKey])),
  };
}

const REMEMBER_PREFIX = /^\s*(?:请)?(?:记住|记一下|remember)\s*[:：,，]\s*([\s\S]+?)\s*$/i;
const EVENT_CUE = /(?:上次|之前|去年|昨天|今天|刚才|刚刚|当时|曾经|经历|发生过|遇到过|完成了|取消了|去了|看了|买了|做了|试了|发现|解决了)/;
const TASK_CUE = /(?:本次任务|这次任务|当前任务|这个任务|此任务|本轮|当前话题|正在讨论|临时|暂时|待办|要做|需要完成|完成前|这次先|本次先|今天要|明天要|本周要|接下来|下一步|现在在做|我们先处理|我(?:现在|目前|正在).{0,12}(?:在做|处理|讨论)|当前.{0,12}(?:话题|目标|任务))/;
const LONG_TERM_CUE = /(?:以后|今后|长期|一直|始终|总是|默认|偏好|习惯|我喜欢|我不喜欢|喜欢|不喜欢|每次都)/;
const TASK_ACTION = /(?:修复|实现|检查|整理|分析|编写|创建|查找|解释|比较|验证|完成|发布|部署|迁移|重构|优化|更新|安装|删除|设计|测试|处理|归纳|总结|记录|回答|搜索|研究|看一下|看看|写进|写到|拆成|拆分|加入|添加|放到|放进|改成|改为|运行|跑一下|打开|保存)/;
const TASK_REQUEST = /(?:请(?:你|帮我|协助我)?|麻烦(?:你|帮我)?|帮我|替我|能否|能不能|可以(?:帮我|请)?|接下来|下一步|现在|这次|本轮|我们先|先)/;

export function classifyRememberDirective(text) {
  if (typeof text !== 'string') return null;
  const match = REMEMBER_PREFIX.exec(text);
  if (!match) return null;
  const content = match[1].trim();
  if (!content) return null;
  if (/(?:昨天|上次|去年|之前|刚才|刚刚|完成了|解决了)/.test(content))
    return { text: content, layer: 'L2', horizon: 'event', category: 'event' };
  if (TASK_CUE.test(content)) return { text: content, layer: 'L1', horizon: 'task', category: 'task' };
  if (EVENT_CUE.test(content)) return { text: content, layer: 'L2', horizon: 'event', category: 'event' };
  if (LONG_TERM_CUE.test(content)) {
    const preference = /(?:偏好|习惯|喜欢|不喜欢)/.test(content);
    return { text: content, layer: 'L3', horizon: 'long_term', category: preference ? 'preference' : 'knowledge' };
  }
  return { text: content, layer: 'L2', horizon: 'unspecified', category: 'knowledge' };
}

const taskKeyOf = text => hash([...new Set(terms(text, Infinity))].sort().join(' ')).slice(0, 32);

// Local rules select explicit user statements and requests without promoting assistant prose.
export function localCandidates(text) {
  const plain = text.replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/([，,])(?=(?:请|帮我|麻烦|把|我更喜欢|我喜欢))\s*/g, '$1\n');
  const result = [];
  for (const match of plain.matchAll(/[^\n。！？!?；;]+[。！？!?；;]?/g)) {
    const quote = match[0].trim();
    if (quote.length < 4 || quote.length > 16000 || /^[>"“「]/.test(quote) ||
      /(?:假设|假如|如果|例如|比如|举例|示例|引用|他说|她说|不要记|不用记|别记)/.test(quote)) continue;
    const action = TASK_ACTION.test(quote) && (TASK_REQUEST.test(quote) || /^把.{1,100}(?:写进|写到|放到|放进|拆成|拆分|改成|改为|加入|添加|保存)/.test(quote));
    if ((/[?？]|(?:是否|吗|呢)$/.test(quote) && !action) ||
        /(?:我不知道|我不确定|据说|听说|他喜欢|她喜欢)/.test(quote)) continue;
    let rule, layer = 'L2', category = 'knowledge', horizon = 'unspecified';
    const preference = /(?:我.{0,24}(?:喜欢|偏好|习惯|希望|想要|讨厌|不喜欢|不习惯)|对我来说|(?:prefer|preference|I like|I dislike)\b)/i.test(quote);
    const agreement = /(?:我们.{0,16}(?:约定|说好)|(?:约定|规矩|规则|教训)\s*[：:]|(?:以后|今后|始终|每次都|默认).{0,24}(?:回答|叫我|使用|采用|称呼|回复|用\s*\S|改成|改为))/i.test(quote);
    const decision = /(?:我(?:们)?(?:最终)?(?:决定|选择)|最后(?:决定|选择)|决定采用|选定|we decided)\s*.{0,80}/i.test(quote);
    const fact = /(?:(?:本项目|当前项目|项目|服务|开发服务器|测试环境|构建工具|包管理器|数据库|运行时|仓库).{0,80}?(?:使用|采用|运行在|位于|端口|路径|版本|是|用\s*\S)|^我(?:现在|目前)?用的是\s*\S|(?:the )?project uses\b)/i.test(quote);
    const event = EVENT_CUE.test(quote) && /(?:我|我们|自己|完成|去了|看了|买了|做了|试了|发现|遇到|经历|解决|发生)/.test(quote);
    if (/^(?:不对[，,：:]|更正[：:]|纠正[：:]|我说错了[，,：:]|correction:)/i.test(quote)) {
      rule = 'correction'; category = 'knowledge';
    } else if (event && /(?:完成了|解决了|取消了)/.test(quote)) {
      rule = 'event'; category = 'event'; horizon = 'event';
    } else if (TASK_CUE.test(quote)) {
      rule = 'active-topic'; layer = 'L1'; category = 'task'; horizon = 'task';
    } else if (/^(?:明天|后天|本周|下周).{0,30}(?:开会|会议|交付|提交|发布|复查|验收)/.test(quote)) {
      rule = 'scheduled-task'; layer = 'L1'; category = 'task'; horizon = 'task';
    } else if (agreement) {
      rule = 'agreement'; category = 'agreement'; horizon = 'long_term';
    } else if (action && (!preference || /我(?:希望|想要)(?:你|你帮我)/.test(quote))) {
      rule = 'task-request'; layer = 'L1'; category = 'task'; horizon = 'task';
    } else if (preference) {
      rule = 'preference'; category = 'preference'; horizon = 'long_term';
    } else if (decision) {
      rule = 'decision'; category = 'event'; horizon = 'event';
    } else if (event) {
      rule = 'event'; category = 'event'; horizon = 'event';
    } else if (fact) {
      rule = 'fact'; category = 'knowledge';
      horizon = LONG_TERM_CUE.test(quote) ? 'long_term' : 'unspecified';
    } else continue;
    const candidate = { text: quote, rule, layer, category, horizon };
    if (layer === 'L1') candidate.taskKey = taskKeyOf(quote);
    result.push(candidate);
  }
  return result;
}

export const ENCODING_VERSION = 'local-context-v4';
const TECH_VALUES = [
  ['package-manager', /\b(?:pnpm|npm|yarn|bun)\b/gi, '包管理器'],
  ['storage', /\b(?:SQLite|PostgreSQL|MySQL|MongoDB|Redis)\b/gi, '数据库'],
  ['shell', /\b(?:PowerShell|bash|zsh|cmd)\b/gi, '命令行'],
];
export function technicalClaim(text) {
  if (/[?？]|(?:如果|假设|例如|比如|听说|他说|她说)/.test(text)) return null;
  const explicitSubject = /^(?:本项目|这个项目|当前项目|项目|本仓库|这个仓库)(?:目前|现在|默认|暂时)?(?:不使用|不采用|不再用|不要再用|不用|使用|采用|用|改成|改为|换成|换为)/.test(text) ? 'workspace.project' :
    /^我(?:现在|目前)?用的是/.test(text) ? 'user' :
      /^(?:以后|今后|默认)/.test(text) ? 'workspace.default' : null;
  if (!explicitSubject) return null;
  for (const [predicate, pattern, tag] of TECH_VALUES) {
    const values = [...text.matchAll(pattern)];
    if (!values.length) continue;
    const replacement = /(?:改成|改为|换成|换为)\s*([A-Za-z0-9-]+)/i.exec(text);
    if (values.length !== 1 && !replacement) return null;
    const value = replacement ? values.find(item => item[0].toLowerCase() === replacement[1].toLowerCase()) : values[0];
    if (!value) return null;
    const negative = !replacement && /(?:不使用|不用|不要用|不再用|不是)/.test(text.slice(0, value.index));
    return { subject: explicitSubject, predicate, value: value[0], polarity: negative ? 'negative' : 'positive',
      scope: 'space', tag, replaces: replacement && values[0][0] !== value[0] ? values[0][0] : null };
  }
  return null;
}
export function encodeCandidates(text, context = []) {
  const candidates = localCandidates(text);
  if (!candidates.length && /^(?:改成|改为|换成|换为)\s*[A-Za-z0-9-]+[。.]?$/.test(text.trim())) {
    const claims = context.map(item => ({ item, claim: technicalClaim(item.text) })).filter(item => item.claim);
    const keys = new Set(claims.map(({ claim }) => `${claim.subject}.${claim.predicate}`));
    if (keys.size === 1) {
      const { item, claim } = claims.at(-1);
      const inferred = technicalClaim(`这个项目${text}`);
      if (inferred?.predicate === claim.predicate) candidates.push({
        text: text.trim(), layer: 'L2', category: 'knowledge', horizon: 'unspecified', rule: 'contextual-change',
        claim: { ...inferred, subject: claim.subject, replaces: claim.value },
        contextSourceId: item.id,
      });
    }
  }
  return candidates.map(candidate => {
    const proposed = candidate.claim ?? (candidate.layer !== 'L1' ? technicalClaim(candidate.text) : null);
    if (!proposed) return candidate;
    const { tag, replaces, ...claim } = proposed;
    return { ...candidate, claim, factKey: `${claim.subject}.${claim.predicate}`, tags: tag ? [tag] : [],
      replaces: replaces ?? null };
  });
}
export function splitCapture(text, limit = 16000) {
  const chunks = [];
  let offset = 0, inCodeFence = false;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > offset + limit / 2) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      while (end > offset && text[end - 1] === '`') end--;
      if (end === offset) end = Math.min(offset + limit, text.length);
    }
    const part = text.slice(offset, end);
    chunks.push({ text: part, offset, inCodeFence });
    if ((part.match(/```/g) ?? []).length % 2) inCodeFence = !inCodeFence;
    offset = end;
  }
  return chunks;
}
export const memorySearchText = record => `${record.text} ${(record.tags ?? []).join(' ')} ${(record.aliases ?? []).join(' ')}`;
export const memoryContentHash = record => hash(memorySearchText(record));

export const SEARCH_VERSION = 'intl-zh-v3';
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '这', '那', '一个', '什么', 'the', 'a', 'is', 'and']);
export function terms(text, limit = 64) {
  return [...new Set([...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && !STOP.has(part.segment)).map(part => part.segment))].slice(0, limit);
}
const CONSOLIDATION_SYNONYMS = new Map([
  ['偏好', '喜欢'], ['喜好', '喜欢'],
  ['简短', '简洁'], ['简练', '简洁'], ['简明', '简洁'], ['精炼', '简洁'],
  ['回复', '回答'], ['答复', '回答'],
  ['采用', '使用'], ['选用', '使用'], ['用的是', '使用'],
]);
function consolidationKey(text) {
  // Keep order, subjects, qualifiers and symbols (C++ is not C#).
  return JSON.stringify([...segmenter.segment(text)]
    .filter(part => part.segment.trim() && part.segment !== '的' &&
      !/^[。！？!?；;，,、]+$/.test(part.segment))
    .map(part => CONSOLIDATION_SYNONYMS.get(part.segment) ?? part.segment));
}
export function consolidationProfile(text) {
  const exact = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const canonical = exact.replace(/^(我|我们)(?:更|比较)(?=喜欢|偏好)/, '$1');
  const base = canonical
    .replace(/不喜欢|不偏好|讨厌/g, '喜欢')
    .replace(/不使用|不采用/g, '使用')
    .replace(/不是/g, '是').replace(/不能/g, '能').replace(/不要/g, '要')
    .replace(/\d+(?:\.\d+)*/g, '<number>');
  return {
    exact, key: consolidationKey(canonical), conflictKey: consolidationKey(base),
  };
}
export function consolidationSimilarity(left, right) {
  const a = typeof left === 'string' ? consolidationProfile(left) : left;
  const b = typeof right === 'string' ? consolidationProfile(right) : right;
  return a.key === b.key ? 1 : 0;
}
export function consolidationConflict(left, right) {
  const a = typeof left === 'string' ? consolidationProfile(left) : left;
  const b = typeof right === 'string' ? consolidationProfile(right) : right;
  return a.conflictKey === b.conflictKey && a.key !== b.key;
}
export function estimatedTokens(text) {
  return Buffer.byteLength(text, 'utf8');
}
const EVIDENCE_STOP = new Set(['到', '在', '有', '对', '把', '从', '以', '和', '与', '还', '吗', '呢', '吧', '啊',
  '请', '可以', '一下', 'can', 'you', 'please', 'to', 'for', 'with']);
export function rankMemory(memory, queryTerms, now, halfLifeDays, idf = new Map(), idfCeiling = 0) {
  queryTerms = queryTerms.filter(word => !EVIDENCE_STOP.has(word));
  const words = terms(memorySearchText(memory), Infinity);
  const hits = queryTerms.filter(word => words.includes(word));
  const weight = word => idf.get(word) ?? 1;
  const totalWeight = queryTerms.reduce((sum, word) => sum + weight(word), 0);
  const hitWeight = hits.reduce((sum, word) => sum + weight(word), 0);
  const coverage = hitWeight / Math.max(Number.EPSILON, totalWeight);
  const evidence = 1 - Math.exp(-hitWeight / Math.max(1, idfCeiling));
  const direct = 0.55 * coverage + 0.45 * evidence;
  const age = Math.max(0, now - Date.parse(memory.lastRecalledAt ?? memory.reinforcedAt ?? memory.occurredAt ?? memory.createdAt)) / 86400000;
  const freshness = memory.pinned || memory.layer === 'L3' ? 1 : 2 ** (-age / (halfLifeDays * memory.stability));
  const specificity = idfCeiling > 0 ? Math.min(1, Math.max(0, ...hits.map(weight)) / idfCeiling) : 1;
  return { score: direct * specificity * (0.65 + 0.2 * freshness + 0.15 * memory.importance), hits, freshness, specificity };
}
