import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemorySpace } from './store.js';
import { LocalEmbedding, modelInventory } from './embedding.js';
import { SemanticIndex, semanticChunks, clearSemanticFiles } from './semantic-index.js';
import { clearTopicFiles } from './topic-index.js';
import { privateJournalStatus } from './private-journal.js';
import { automaticBackup, applyImport, importPreview, packBackup, restoreBackup, MAX_RESTORE_BODY_BYTES } from './transfer.js';
import { automaticKeyStatus, readAutomaticKey, saveAutomaticKey } from './backup-key.js';
import { bindingFor, classifyRememberDirective, configOf, ENCODING_VERSION, LAYERS, MAX_RECALL_QUERY_LENGTH,
  localDateKey, MemoryError, requireValue, SEARCH_VERSION, slug, splitCapture, string } from './model.js';

export const ADMIN = Object.freeze({ admin: true });
export const PREFIX = '/tidal-memory';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_RESTORE_BODY = MAX_RESTORE_BODY_BYTES;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
async function waitForLocal(promise, timeout, signal) {
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(new MemoryError('SEMANTIC_CANCELLED', '当前语义检索已取消。', 409));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new MemoryError('SEMANTIC_TIMEOUT', '本地语义准备超时，本轮仅使用词面检索。', 503)), timeout);
  });
  try { return await Promise.race([promise, stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text')
  .map(block => block.text).join('\n').toWellFormed();
export function recallQuery(text) {
  if (text.length <= MAX_RECALL_QUERY_LENGTH) return text.toWellFormed();
  const half = Math.floor((MAX_RECALL_QUERY_LENGTH - 1) / 2);
  return `${text.slice(0, half)}\n${text.slice(-(MAX_RECALL_QUERY_LENGTH - half - 1))}`.toWellFormed();
}
const dateKey = localDateKey;
function scheduledAt(date, time) {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
}
function latestScheduledAt(date, time) {
  const day = new Date(date);
  if (date < scheduledAt(day, time)) day.setDate(day.getDate() - 1);
  return scheduledAt(day, time);
}
function nextScheduledAt(date, time, lastDay) {
  const due = latestScheduledAt(date, time);
  if (!lastDay || lastDay < dateKey(due)) return due.toISOString();
  const nextDay = new Date(`${lastDay}T12:00:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  return scheduledAt(nextDay, time).toISOString();
}

export class TidalRuntime {
  constructor(ctx, rawConfig, home, { clock = () => new Date(), embedding } = {}) {
    this.ctx = ctx;
    this.rawConfig = rawConfig;
    this.clock = clock;
    const legacyAutoExtract = rawConfig?.autoExtract;
    this.legacyModelExtractionIgnored = (legacyAutoExtract && typeof legacyAutoExtract.get === 'function'
      ? legacyAutoExtract.get() : legacyAutoExtract) === true;
    this.config = configOf(rawConfig);
    this.root = resolve(this.config.dataRoot || join(home, 'tidal-memory'));
    this.embedding = embedding ?? new LocalEmbedding(this.root);
    this.embedding.configure(this.config);
    this.semanticQueries = new Map();
    this.semanticResults = new Map();
    this.semanticTasks = new Set();
    this.lastSemanticTask = new Map();
    this.prewarmQueue = Promise.resolve();
    this.spaces = new Map();
    this.spaceErrors = new Map();
    this.plans = new Map();
    this.sessions = new Map();
    this.jobs = new Set();
    this.lastActivity = this.clock().getTime();
    this.workspaceActivity = new Map();
    this.disposed = false;
    this.lastError = null;
    this.busy = false;
  }
  syncConfig() {
    const config = configOf(this.rawConfig);
    requireValue(!config.dataRoot || resolve(config.dataRoot) === this.root, 'ROOT_RESTART_REQUIRED', '数据目录已变化。请停止插件并迁移数据后重新启动。', 409);
    const changed = JSON.stringify(config) !== JSON.stringify(this.config);
    const windowChanged = config.contextMessages !== this.config.contextMessages;
    this.config = config;
    const modelKey = this.embedding.key;
    this.embedding.configure(config);
    if (modelKey !== this.embedding.key) {
      for (const task of this.semanticTasks) task.controller.abort();
      this.semanticQueries.clear();
      this.semanticResults.clear();
    } else if (changed) this.semanticResults.clear();
    for (const store of this.spaces.values()) store.setConfig(config);
    if (windowChanged) this.sessions.clear();
    if (changed) for (const state of this.sessions.values()) { state.context = null; state.semantic = null; }
    return this.config;
  }
  space(name) {
    slug(name);
    requireValue(!this.disposed, 'CLOSED', '插件已停止。', 503);
    if (!this.spaces.has(name)) {
      try {
        this.spaces.set(name, new MemorySpace(this.root, name, { config: this.config, clock: () => this.clock().getTime() }));
        this.spaces.get(name).onForget = () => {
          this.semanticQueries.clear();
          this.semanticResults.clear();
          const lineage = this.spaces.get(name)?.lineageId;
          for (const [otherName, store] of this.spaces) if (store.lineageId === lineage) this.invalidateSpace(otherName);
        };
        this.spaceErrors.delete(name);
      } catch (error) {
        this.spaceErrors.set(name, { code: error.code ?? 'OPEN_FAILED',
          message: error instanceof MemoryError ? error.message : '空间无法打开，请检查数据目录。',
          at: new Date().toISOString() });
        throw error;
      }
    }
    return this.spaces.get(name);
  }
  names() {
    const path = join(this.root, 'spaces');
    const stored = existsSync(path) ? readdirSync(path, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name) &&
        !/^restore-[a-f0-9-]{36}$/.test(item.name))
      .map(item => item.name) : [];
    return [...new Set([...stored, ...this.config.bindings.map(b => b.space)])].sort();
  }
  forAgent(agent) {
    this.syncConfig();
    requireValue(this.config.enabled, 'DISABLED', '记忆插件已关闭。', 403);
    requireValue(agent?.session && this.ctx.agents.get(agent.id) === agent, 'NO_AGENT', '缺少宿主登记的会话身份。', 403);
    requireValue(agent.session.header.origin !== 'subagent', 'SUBAGENT_SCOPE', '第一版不向子代理开放跨会话记忆。', 403);
    const binding = bindingFor(this.config, agent.session.header.cwd);
    requireValue(binding, 'UNBOUND_WORKSPACE', '当前工作区未绑定记忆空间，请在设置中绑定。', 403);
    const store = this.space(binding.space);
    store.reconcileForgetLedger();
    return { store, actor: { sessionId: agent.id }, space: binding.space };
  }
  invalidateSpace(name) {
    for (const state of this.sessions.values()) {
      if (state.space === name) { state.context = null; state.semantic = null; }
    }
  }
  noteError(code, message, details = {}) {
    this.lastError = { code, message, at: new Date().toISOString(), ...details };
    this.ctx.logger?.warn?.(`[tidal-memory] ${code}: ${message}`);
  }
  sessionState(session, space) {
    let state = this.sessions.get(session.id);
    if (!state || state.space !== space) {
      const recent = [];
      const events = session.snapshotEvents?.() ?? [];
      for (let i = events.length - 1; i >= 0 && recent.length < this.config.contextMessages; i--) {
        const event = events[i];
        if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
        const text = textOf(event.data);
        if (text.trim()) recent.unshift({ seq: event.seq, text: recallQuery(text) });
      }
      state = { recent, query: recent.at(-1)?.text ?? '', evidenceId: recent.at(-1)?.seq,
        context: null, turn: null, lastSeen: this.clock().getTime(), space };
      this.sessions.set(session.id, state);
    }
    return state;
  }
  recallForAgent(agent, query, options = {}) {
    const { store, actor, space } = this.forAgent(agent);
    const state = this.sessionState(agent.session, space);
    const cached = this.cachedSemantic(store, actor, query, options.contextQueries ?? [], state, options);
    return store.recall(query, actor, { ...options, ...cached,
      evidenceId: state.evidenceId === undefined ? undefined : `user-event:${state.evidenceId}` });
  }
  queryWindow(state) {
    const pending = state.pendingQueries ?? [];
    const queries = pending.length ? [...(state.recent ?? []).map(item => item.text), ...pending]
      .slice(-this.config.contextMessages) : (state.recent ?? []).map(item => item.text);
    return { query: pending.length ? pending.at(-1) : recallQuery(state.query),
      contextQueries: queries.slice(-this.config.contextMessages, -1).reverse(), pending: pending.length > 0 };
  }
  semanticKey(store, query, contextQueries) {
    return JSON.stringify([this.embedding.key, store.name, query, contextQueries]);
  }
  semanticResultKey(store, actor, query, contextQueries, options = {}) {
    const scope = store.recallScope(actor, options);
    return JSON.stringify([this.semanticKey(store, query, contextQueries), store.generation, store.forgetVersion(),
      actor?.admin === true, actor?.sessionId ?? null, options.mode ?? 'current', scope.at,
      options.includeArchived === true, this.config.embeddingMinScore, this.config.embeddingRelativeFloor, this.config.maxRecall]);
  }
  cachedSemantic(store, actor, query, contextQueries, state, options = {}) {
    if (this.config.embeddingMode === 'off') return { semantic: [], semanticStatus: { mode: 'off', state: 'disabled' } };
    const cached = state?.semantic;
    if (cached?.resultKey === this.semanticResultKey(store, actor, query, contextQueries, options) &&
        (cached.expiresAt === null || this.clock().getTime() < cached.expiresAt))
      return { semantic: cached.hits, semanticStatus: cached.status };
    return { semantic: [], semanticStatus: { mode: this.config.embeddingMode, state: 'lexical',
      code: 'SEMANTIC_NOT_PREPARED', message: '语义线索尚未就绪或记忆已经变化，本次只使用词面检索。' } };
  }
  trackSemanticTask(task, job) {
    task.promise = job;
    this.semanticTasks.add(task);
    this.jobs.add(job);
    const finish = (state, error) => {
      task.state = state;
      this.semanticTasks.delete(task);
      this.jobs.delete(job);
      this.lastSemanticTask.set(task.space, { kind: task.kind, state, at: this.clock().toISOString(),
        ...(error && state === 'failed' ? { code: error.code ?? 'SEMANTIC_FAILED' } : {}) });
    };
    job.then(() => finish('completed'), error =>
      finish(task.controller.signal.aborted || error?.code === 'SEMANTIC_CANCELLED' ? 'cancelled' : 'failed', error));
    return job;
  }
  cancelPrewarm() {
    for (const task of this.semanticTasks) if (task.kind === 'prewarm') task.controller.abort();
  }
  requestPrewarm(store) {
    if (this.disposed || this.config.embeddingMode === 'off') return { state: 'disabled' };
    if ([...this.semanticTasks].some(task => task.space === store.name)) return { state: 'busy' };
    const task = { space: store.name, kind: 'prewarm', state: 'queued', controller: new AbortController() };
    const run = async () => {
      requireValue(!this.disposed && !task.controller.signal.aborted, 'SEMANTIC_CANCELLED', '后台索引准备已取消。', 409);
      task.state = 'running';
      store.semanticIndex ??= new SemanticIndex(store);
      await store.semanticIndex.sync(this.embedding, { signal: task.controller.signal });
    };
    const job = this.prewarmQueue.then(run, run);
    this.prewarmQueue = job;
    this.trackSemanticTask(task, job);
    job.catch(error => {
      if (error.code !== 'SEMANTIC_CANCELLED' && !this.disposed)
        this.noteError(error.code ?? 'SEMANTIC_PREWARM_FAILED', '后台语义索引准备未完成，请检查模型状态。',
          { operation: 'semantic', space: store.name });
    });
    return { state: 'queued' };
  }
  async prepareSemantic(store, actor, query, options = {}, signal) {
    const contextQueries = options.contextQueries ?? [];
    string(query, '查询', MAX_RECALL_QUERY_LENGTH, true);
    requireValue(Array.isArray(contextQueries) && contextQueries.length <= 10, 'INVALID_INPUT', '情境窗最多 10 条消息。');
    contextQueries.forEach(text => string(text, '情境线索', MAX_RECALL_QUERY_LENGTH, true));
    store.recallScope(actor, options);
    const mode = this.config.embeddingMode;
    const key = this.semanticKey(store, query, contextQueries);
    if (mode === 'off') return { key, resultKey: this.semanticResultKey(store, actor, query, contextQueries, options),
      generation: store.generation, expiresAt: null, hits: [], status: { mode, state: 'disabled' } };
    if (signal?.aborted) throw new MemoryError('SEMANTIC_CANCELLED', '当前语义检索已取消。', 409);
    this.cancelPrewarm();
    const modelKey = this.embedding.key;
    const task = { space: store.name, kind: 'foreground', state: 'running', controller: new AbortController() };
    const abort = () => task.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const check = () => {
      requireValue(!task.controller.signal.aborted, 'SEMANTIC_CANCELLED', '当前语义检索已取消。', 409);
      requireValue(modelKey === this.embedding.key && !this.disposed, 'MODEL_CHANGED', '本地模型已切换或停止。', 409);
    };
    const job = (async () => {
      check();
      store.semanticIndex ??= new SemanticIndex(store);
      await store.semanticIndex.sync(this.embedding, { signal: task.controller.signal });
      check();
      const pack = await this.embedding.ready();
      check();
      const scope = store.recallScope(actor, options);
      const resultKey = this.semanticResultKey(store, actor, query, contextQueries, options);
      const cached = this.semanticResults.get(resultKey);
      if (cached && cached.status.fingerprint === pack.fingerprint &&
          (cached.expiresAt === null || scope.now < cached.expiresAt) &&
          store.semanticIndex.status().pending === 0) return cached;
      let queries = this.semanticQueries.get(key);
      if (!queries) {
        const chunks = [query, ...contextQueries].flatMap((text, contextIndex) =>
          text.trim() ? semanticChunks(text, pack.chunkSize).map(text => ({ text, contextIndex })) : []);
        queries = [];
        for (let offset = 0; offset < chunks.length; offset += 16) {
          const batch = chunks.slice(offset, offset + 16);
          const vectors = await this.embedding.embed(batch.map(item => item.text), 'query');
          check();
          queries.push(...vectors.map((vector, index) => ({ vector, contextIndex: batch[index].contextIndex })));
        }
        check();
        if (this.semanticQueries.size >= 64) this.semanticQueries.delete(this.semanticQueries.keys().next().value);
        this.semanticQueries.set(key, queries);
      }
      const policy = { ...pack,
        minScore: this.config.embeddingMinScore === -1 ? pack.minScore : this.config.embeddingMinScore,
        relativeFloor: this.config.embeddingRelativeFloor === -1 ? pack.relativeFloor : this.config.embeddingRelativeFloor };
      const hits = queries.length ? store.semanticIndex.search(queries, policy,
        { accept: scope.accept, limit: Math.max(60, this.config.maxRecall * 4) }) : [];
      const index = store.semanticIndex.status();
      const expiresAt = (options.mode ?? 'current') === 'current' ? store.nextEligibilityChange(scope.statuses, scope.now) : null;
      const result = { key, resultKey, generation: store.generation, expiresAt, hits,
        status: { mode, state: index.pending || index.state !== 'ready' ? 'partial' : 'ready',
        model: pack.modelId, fingerprint: pack.fingerprint, candidates: hits.length, index,
        minScore: policy.minScore, relativeFloor: policy.relativeFloor } };
      if (result.status.state === 'ready') {
        if (this.semanticResults.size >= 128) this.semanticResults.delete(this.semanticResults.keys().next().value);
        this.semanticResults.set(resultKey, result);
      }
      return result;
    })();
    this.trackSemanticTask(task, job);
    try {
      const result = await waitForLocal(job, this.config.embeddingTimeoutSeconds * 1000, task.controller.signal);
      if (result.status.state === 'ready' && this.lastError?.operation === 'semantic' && this.lastError.space === store.name)
        this.lastError = null;
      return result;
    }
    catch (error) {
      task.controller.abort();
      if (error.code !== 'SEMANTIC_CANCELLED')
        this.noteError(error.code ?? 'SEMANTIC_FAILED', `本地语义检索未完成：${error.message}`,
          { operation: 'semantic', space: store.name });
      return { key, resultKey: this.semanticResultKey(store, actor, query, contextQueries, options),
        generation: store.generation, expiresAt: null, hits: [], status: { mode, state: 'degraded',
        code: error.code ?? 'SEMANTIC_FAILED', message: error.message } };
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async recallAsync(store, actor, query, options = {}, signal) {
    const result = await this.prepareSemantic(store, actor, query, options, signal);
    requireValue(!this.disposed, 'CLOSED', '插件已停止。', 503);
    this.syncConfig();
    requireValue(!signal?.aborted && result.key === this.semanticKey(store, query, options.contextQueries ?? []),
      'SEMANTIC_OBSOLETE', '查询已取消或模型配置已变化，请重新检索。', 409);
    const current = result.resultKey === this.semanticResultKey(store, actor, query, options.contextQueries ?? [], options) &&
      (result.expiresAt === null || this.clock().getTime() < result.expiresAt);
    return store.recall(query, actor, { ...options, semantic: current ? result.hits : [],
      semanticStatus: current ? result.status : { mode: this.config.embeddingMode, state: 'partial',
        code: 'SEMANTIC_OBSOLETE', message: '语义准备期间记忆或有效时间发生变化，本次只使用词面检索。' } });
  }
  async recallForAgentAsync(agent, query, options = {}, signal) {
    const { store, actor, space } = this.forAgent(agent);
    const state = this.sessionState(agent.session, space);
    const evidenceId = state.evidenceId === undefined ? undefined : `user-event:${state.evidenceId}`;
    const result = await this.prepareSemantic(store, actor, query, options, signal);
    const current = this.forAgent(agent);
    requireValue(current.store === store && !signal?.aborted &&
      result.key === this.semanticKey(store, query, options.contextQueries ?? []),
    'SEMANTIC_OBSOLETE', '查询范围、模型或会话状态已变化，请重新检索。', 409);
    const valid = result.resultKey === this.semanticResultKey(store, current.actor, query, options.contextQueries ?? [], options) &&
      (result.expiresAt === null || this.clock().getTime() < result.expiresAt);
    return store.recall(query, current.actor, { ...options, evidenceId,
      semantic: valid ? result.hits : [], semanticStatus: valid ? result.status :
        { mode: this.config.embeddingMode, state: 'partial', code: 'SEMANTIC_OBSOLETE',
          message: '语义准备期间记忆或有效时间发生变化，本次只使用词面检索。' } });
  }
  async preStep({ agent, signal }, next) {
    const decision = await next();
    if (decision.kind === 'reject' || signal?.aborted || this.disposed) return decision;
    try {
      this.syncConfig();
      if (!this.config.enabled || agent.session?.header.origin === 'subagent') return decision;
      this.cancelPrewarm();
      const binding = bindingFor(this.config, agent.session?.header.cwd);
      if (!binding) return decision;
      this.forAgent(agent);
      const state = this.sessionState(agent.session, binding.space);
      // rc5 appends admitted user events after its final runtime-context refresh.
      state.pendingQueries = decision.messages.filter(message => message.source?.kind === 'user')
        .map(textOf).filter(text => text.trim()).map(recallQuery);
      state.context = null;
      if (this.config.injectContext && this.config.embeddingMode !== 'off') {
        const token = Symbol('semantic-request');
        state.semanticRequest = token;
        const { query, contextQueries } = this.queryWindow(state);
        const { store, actor } = this.forAgent(agent);
        const result = await this.prepareSemantic(store, actor, query, { contextQueries }, signal);
        if (!signal?.aborted && !this.disposed && this.sessions.get(agent.id) === state &&
          state.semanticRequest === token && result.key === this.semanticKey(store, query, contextQueries) &&
          result.resultKey === this.semanticResultKey(store, actor, query, contextQueries, { contextQueries }) &&
          (result.expiresAt === null || this.clock().getTime() < result.expiresAt)) {
          state.semantic = result;
          state.context = null;
        }
      }
    } catch (error) {
      this.noteError(error.code ?? 'PRESTEP_FAILED', '当前轮次记忆线索准备失败，未确认完整召回。');
    }
    return decision;
  }
  onEvent(session, event) {
    if (this.disposed) return;
    try {
      this.syncConfig();
      if (!this.config.enabled || session.header.origin === 'subagent') return;
      this.cancelPrewarm();
      const binding = bindingFor(this.config, session.header.cwd);
      if (!binding) return;
      const state = this.sessionState(session, binding.space);
      state.space = binding.space;
      state.lastSeen = this.clock().getTime();
      this.lastActivity = state.lastSeen;
      this.workspaceActivity.set(binding.space, state.lastSeen);
      if (event.type === 'turn/start') { state.context = null; state.turn = event.data.turn; }
      if (event.type === 'turn/end') { state.pendingQueries = []; state.pendingRecall = null; state.context = null; }
      const message = event.type === 'user/message' ? event.data :
        event.type === 'assistant/message' ? event.data.message : null;
      if (!message) return;
      if (event.type === 'user/message' && message.source?.kind !== 'user') return;
      if (event.type === 'assistant/message' && event.data.interrupted) return;
      if (message.role === 'assistant' && !this.config.captureAssistant) return;
      const text = textOf(message);
      if (!text.trim()) return;
      if (message.role === 'user') {
        if (state.pendingRecall?.query === recallQuery(text)) {
          const store = this.space(binding.space);
          for (const id of state.pendingRecall.ids) store.recordRetrieval(id, `${session.id}:user-event:${event.seq}`);
          state.pendingRecall = null;
        }
        state.pendingQueries = [];
        state.query = text;
        state.recent = [...(state.recent ?? []).filter(item => item.seq !== event.seq),
          { seq: event.seq, text: recallQuery(text) }].slice(-this.config.contextMessages);
        state.evidenceId = event.seq;
        state.context = null;
      }
      const store = this.space(binding.space);
      const chunks = splitCapture(text);
      const directive = classifyRememberDirective(text);
      for (const [index, chunk] of chunks.entries()) {
        if (!chunk.text.trim()) continue;
        const source = store.capture({
          sessionId: session.id, eventId: event.seq, text: chunk.text, role: message.role,
          at: new Date(event.time).toISOString(),
          ...(chunks.length > 1 ? { chunk: { index, count: chunks.length, offset: chunk.offset, inCodeFence: chunk.inCodeFence,
            ...(index && directive ? { directive: { layer: directive.layer, category: directive.category, horizon: directive.horizon } } : {}) } } : {}),
        });
        if (message.role === 'user' && store.organizePending(1, source.id).organized) this.invalidateSpace(binding.space);
      }
    } catch (error) {
      this.noteError(error.code ?? 'CAPTURE_FAILED', '记忆捕获未完成，请在管理页检查。');
    }
  }
  context({ agent }) {
    let selectedSpace;
    try {
      this.syncConfig();
      if (!this.config.enabled || !agent?.session || agent.session.header.origin === 'subagent') return '';
      if (!this.config.injectContext) return '';
      const binding = bindingFor(this.config, agent.session.header.cwd);
      if (!binding) return '';
      selectedSpace = binding.space;
      const { store, actor, space } = this.forAgent(agent);
      const state = this.sessionState(agent.session, space);
      state.space = space;
      for (let attempt = 0; attempt < 3; attempt++) {
        store.reconcileForgetLedger();
        const version = store.reconciledForgetVersion, observedAt = this.clock().getTime();
        if (state.context === null || state.generation !== store.generation ||
            (state.contextAt !== undefined && observedAt < state.contextAt) ||
            (state.contextExpiresAt !== null && state.contextExpiresAt !== undefined && observedAt >= state.contextExpiresAt)) {
          const { query, contextQueries, pending } = this.queryWindow(state);
          const recalled = store.recall(query, actor, { contextQueries,
            ...this.cachedSemantic(store, actor, query, contextQueries, state),
            evidenceId: pending || state.evidenceId === undefined ? undefined : `user-event:${state.evidenceId}` });
          const incomplete = this.config.embeddingMode !== 'off' && recalled.semanticStatus?.state !== 'ready';
          state.context = recalled.text + (incomplete ? '\n[本地语义联想尚未完整就绪，召回可能遗漏；不要据此断言不存在相关历史。]' : '');
          if (pending) state.pendingRecall = { query,
            ids: recalled.picked.filter(item => item.matched).map(item => item.id) };
          state.generation = store.generation;
          const scope = store.recallScope(actor);
          state.contextAt = Math.max(observedAt, scope.now);
          state.contextExpiresAt = store.nextEligibilityChange(scope.statuses, scope.now);
          if (this.lastError?.operation === 'recall' && this.lastError.space === space) this.lastError = null;
        }
        if (version === store.forgetVersion()) return state.context;
        state.context = null;
        state.semantic = null;
        state.pendingRecall = null;
      }
      throw new MemoryError('FORGET_CONFLICT', '生成上下文期间遗忘标记持续变化，请稍后重试。', 409);
    } catch (error) {
      this.noteError(error.code ?? 'RECALL_FAILED',
        error instanceof MemoryError ? `记忆召回不可用：${error.message}` : '记忆召回不可用，不应声称已经读取历史。',
        { operation: 'recall', space: selectedSpace });
      return '[潮汐记忆暂不可用：请勿声称已检索到历史记录。]';
    }
  }
  async tick(force = false, selectedSpace) {
    if (this.disposed || this.busy) return { busy: true };
    this.syncConfig();
    if (!this.config.enabled) return { disabled: true };
    this.busy = true;
    try {
      const results = [];
      const names = selectedSpace ? [slug(selectedSpace)] : this.names();
      for (const name of names) {
        const agents = [...this.ctx.agents.list()].filter(agent =>
          agent.session.header.origin !== 'subagent' && bindingFor(this.config, agent.session.header.cwd)?.space === name);
        if (agents.some(agent => agent.status === 'running')) {
          results.push({ space: name, waitingForConversation: true }); continue;
        }
        if (!force && this.clock().getTime() - (this.workspaceActivity.get(name) ?? this.lastActivity) < this.config.idleMinutes * 60000) {
          results.push({ space: name, waiting: true }); continue;
        }
        let store;
        try { store = this.space(name); } catch (error) {
          if (error.code !== 'SPACE_BUSY') throw error;
          this.noteError(error.code, error.message);
          results.push({ space: name, unavailable: true, error: this.spaceErrors.get(name) });
          continue;
        }
        const localOrganization = store.organizePending();
        const consolidation = this.config.autoConsolidate ? store.consolidate() : { disabled: true };
        const maintenance = store.maintenance();
        this.invalidateSpace(name);
        const semanticPrewarm = this.requestPrewarm(store);
        results.push({ space: name, ...maintenance, localOrganization, consolidation, semanticPrewarm });
        if (this.config.autoBackup) automaticBackup(store, this.root);
      }
      return { results };
    } finally { this.busy = false; }
  }
  requestMaintenance(force = false, space) {
    const job = this.tick(force, space);
    this.jobs.add(job);
    job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }
  scheduleTick() {
    if (this.disposed) return;
    const job = this.checkDailyConsolidation().then(() => this.requestMaintenance());
    this.jobs.add(job);
    job.then(() => this.jobs.delete(job), error => {
      this.jobs.delete(job);
      this.noteError(error.code ?? 'MAINTENANCE_FAILED', '后台维护失败，请检查数据目录和设置。');
    });
    return job;
  }
  readOnlyStatus(name) {
    const directory = join(this.root, 'spaces', name);
    const databaseFiles = [
      ...Object.values(LAYERS).map(info => join(directory, info.directory, info.file)),
      join(directory, 'system', 'operations.sqlite3'),
      join(directory, 'private', 'journal.sqlite3'),
    ];
    if (databaseFiles.some(file => existsSync(`${file}-wal`))) {
      return { space: name, directory, unavailable: true,
        spaceError: { code: 'SPACE_BUSY', message: '空间仍有活动 WAL 写入；为避免创建 SQLite 辅助文件，状态暂不可读。' },
        layers: [], dailyConsolidation: null };
    }
    const databases = [];
    const open = file => {
      if (!existsSync(file)) return null;
      const db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
      databases.push(db);
      return db;
    };
    let readError;
    try {
      const layerDatabases = new Map();
      const layers = Object.entries(LAYERS).map(([id, info]) => {
        const file = join(directory, info.directory, info.file);
        const db = open(file);
        if (db) layerDatabases.set(id, db);
        return {
          id, name: info.name,
          count: db?.prepare('SELECT count(*) AS n FROM memories').get().n ?? 0,
          pending: db?.prepare("SELECT count(*) AS n FROM memories WHERE status IN ('pending','candidate','review')").get().n ?? 0,
          directory: join(directory, info.directory), file,
        };
      });
      const searchIndex = Object.entries(LAYERS).map(([layer, info]) => {
        const db = layerDatabases.get(layer);
        return { layer, current: db?.prepare("SELECT value FROM index_state WHERE key='tokenizer'").get()?.value === SEARCH_VERSION,
          expectedVersion: SEARCH_VERSION };
      });
      const system = open(join(directory, 'system', 'operations.sqlite3'));
      const metadata = new Map((system?.prepare('SELECT key,value FROM metadata').all() ?? [])
        .map(row => [row.key, row.value]));
      const encoded = (system?.prepare('SELECT result FROM encodings').all() ?? []).map(row => JSON.parse(row.result));
      const reasons = {};
      for (const row of encoded) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
      const privateFile = join(directory, 'private', 'journal.sqlite3');
      const privateDb = open(privateFile);
      const count = privateDb ? privateJournalStatus(privateDb) :
        { count: 0, lastWritten: null, dailyCount: 0, legacyCount: 0, firstDay: null, lastDay: null, organization: null, failure: null };
      let bytes = 0;
      for (const file of [privateFile, `${privateFile}-wal`]) {
        try { bytes += statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return {
        space: name, directory, layers, errors: [], searchIndex,
        private: { ...count, bytes, directory: join(directory, 'private'), authors: this.config.privateWriters,
          contentVisible: false, generation: '由获准的外部作者插件提供，本插件不生成拟人人格日记。' },
        encoding: { version: ENCODING_VERSION, inspected: encoded.length,
          saved: encoded.reduce((total, row) => total + row.saved, 0), reasons,
          sleep: JSON.parse(metadata.get('sleep-reencoding') ?? 'null'),
          expiredBeforeSleep: Number(metadata.get('expired-unencoded') ?? 0) },
        maintenance: JSON.parse(metadata.get('maintenance') ?? 'null'),
        dailyConsolidation: JSON.parse(metadata.get('daily-consolidation') ?? 'null'),
        deepConsolidation: JSON.parse(metadata.get('deep-consolidation') ?? 'null'),
      };
    } catch (error) {
      readError = error;
      throw error;
    } finally {
      const closeErrors = [];
      for (const db of databases.reverse()) {
        try { db.close(); } catch (error) { closeErrors.push(error); }
      }
      if (closeErrors.length) throw new AggregateError(
        readError ? [readError, ...closeErrors] : closeErrors, '只读状态连接未能全部关闭。');
    }
  }
  async checkDailyConsolidation(now = this.clock()) {
    if (this.disposed || this.busy) return { busy: true };
    this.syncConfig();
    const time = this.config.dailyConsolidateAt;
    if (!this.config.enabled || !time) return { disabled: true };
    const due = latestScheduledAt(now, time);
    const day = dateKey(due);
    this.busy = true;
    try {
      const results = [];
      for (const name of this.names()) {
        let store;
        try { store = this.space(name); } catch (error) {
          if (error.code !== 'SPACE_BUSY') throw error;
          results.push({ space: name, unavailable: true });
          continue;
        }
        if (store.dailyConsolidationStatus()?.day >= day) {
          results.push({ space: name, alreadyRun: true, day });
          continue;
        }
        const agents = [...this.ctx.agents.list()].filter(agent =>
          agent.session.header.origin !== 'subagent' &&
          bindingFor(this.config, agent.session.header.cwd)?.space === name);
        if (agents.some(agent => agent.status === 'running')) {
          results.push({ space: name, waitingForConversation: true, day });
          continue;
        }
        if (now.getTime() - (this.workspaceActivity.get(name) ?? this.lastActivity) < this.config.idleMinutes * 60000) {
          results.push({ space: name, waiting: true, day });
          continue;
        }
        try {
          const backup = automaticBackup(store, this.root, { force: true });
          const privateOrganization = this.runPrivateOrganization(store, now, due);
          const previousDue = new Date(due);
          previousDue.setDate(previousDue.getDate() - 1);
          const from = store.system.prepare("SELECT value FROM metadata WHERE key='sleep-reencoding-until'").get()?.value ??
            previousDue.toISOString();
          const result = store.dailyConsolidation(day, {
            missed: now.getTime() - due.getTime() > 60000, backup, from, until: now.toISOString(),
          });
          if (this.lastError?.operation === 'consolidation' && this.lastError.space === name) this.lastError = null;
          results.push({ space: name, ...result, privateOrganization,
            modelExtraction: this.modelOrganizationStatus() });
        } catch (error) {
          this.noteError(error.code ?? 'CONSOLIDATION_FAILED', `空间 ${name} 深度整理失败；未记录当日完成，下次检查重试。`,
            { operation: 'consolidation', space: name });
          results.push({ space: name, failed: true, error: this.lastError });
        } finally { this.invalidateSpace(name); }
      }
      return { results };
    } finally { this.busy = false; }
  }
  descriptor() {
    return this.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'tidal-memory');
  }
  modelOrganizationStatus() {
    return this.config.deepOrganizationMode === 'selected'
      ? { mode: 'selected', state: 'unavailable', code: 'HOST_AUDIT_REQUIRED',
        message: '宿主自选模型整理尚未满足可回放审计要求，未发送数据；本地规则仍可独立运行。' }
      : { mode: 'local', state: 'rules-only', code: 'LOCAL_GENERATOR_NOT_CONFIGURED',
        message: '本地生成模型未配置；仅运行本地规则和已启用的语义索引。' };
  }
  runPrivateOrganization(store, now, due = now) {
    if (this.config.privateOrganizationMode === 'author') return {
      state: 'unavailable', code: 'PRIVATE_MODEL_ROUTE_UNVERIFIED',
      message: '作者模型映射及私人调用审计尚未验证，未发送或修改私人内容。',
    };
    try {
      const previous = store.privateStatus().organization?.until;
      const first = new Date(due);
      first.setDate(first.getDate() - 1);
      const from = previous ?? first.toISOString(), until = now.toISOString();
      const result = store.organizePrivateWindow({ from, until });
      store.privateDb.prepare("DELETE FROM journal_metadata WHERE key='last-failure'").run();
      if (result.state === 'completed' && this.lastError?.operation === 'private' && this.lastError.space === store.name)
        this.lastError = null;
      return result;
    } catch (error) {
      let recorded = true;
      try {
        store.privateDb.prepare("INSERT OR REPLACE INTO journal_metadata VALUES('last-failure',?)").run(now.toISOString());
      } catch {
        recorded = false;
      }
      const code = recorded ? 'PRIVATE_ORGANIZATION_FAILED' : 'PRIVATE_STATUS_WRITE_FAILED';
      this.noteError(code, recorded ? '私人整理未全部完成；已完成条目保留，失败条目需要重试。普通整理可继续。' :
        '私人整理和失败状态写入均未完成，请检查私人库后重试；普通整理可继续。',
      { operation: 'private', space: store.name });
      return { state: 'failed', code };
    }
  }
  async api(method, path, query, body) {
    this.syncConfig();
    const spaceName = slug(query.get('space') ?? 'default');
    if (method === 'GET' && path === '/status') {
      let details;
      try { details = this.spaces.get(spaceName)?.status() ?? this.readOnlyStatus(spaceName); } catch (error) {
        if (error.code !== 'SPACE_BUSY') throw error;
        details = { space: spaceName, unavailable: true, spaceError: this.spaceErrors.get(spaceName), layers: [] };
      }
      const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` :
        `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(fileURLToPath(
        new URL('../scripts/setup-model.mjs', import.meta.url)))}`;
      return { version: PACKAGE_VERSION, root: this.root, spaces: this.names(), ...details,
        paths: { plugin: fileURLToPath(new URL('../', import.meta.url)), models: join(this.root, 'models'),
          semanticIndex: join(this.root, 'spaces', spaceName, 'indexes', 'semantic.sqlite3'),
          topicIndex: join(this.root, 'spaces', spaceName, 'indexes', 'topics.sqlite3'),
          backups: join(this.root, 'backups', spaceName),
          backupKey: automaticKeyStatus(this.root).path,
          forgetLedger: join(this.root, 'system', 'forget-ledger.sqlite3') },
        backupProtection: { mode: this.config.autoBackupMode, ...automaticKeyStatus(this.root) },
        modelPacks: modelInventory(this.root).map(item => ({ ...item,
          installCommand: `${command} --edition ${item.edition} --root ${quote(this.root)}` })),
        semantic: { ...this.embedding.state, index: this.spaces.get(spaceName)?.semanticIndex?.status() ?? null,
          tasks: [...this.semanticTasks].filter(task => task.space === spaceName)
            .map(task => ({ kind: task.kind, state: task.state })),
          lastTask: this.lastSemanticTask.get(spaceName) ?? null },
        config: this.config, legacyModelExtractionIgnored: this.legacyModelExtractionIgnored,
        organizationModels: { ordinary: this.modelOrganizationStatus(),
          private: { mode: this.config.privateOrganizationMode, authorAvailable: false,
            code: 'PRIVATE_MODEL_ROUTE_UNVERIFIED',
            message: '作者模型映射及私人调用审计尚未验证，作者模型选项暂不可用。' } },
        dailyConsolidation: details.dailyConsolidation ?? null,
        nextDailyConsolidationAt: this.config.enabled && this.config.dailyConsolidateAt && !details.unavailable ?
          nextScheduledAt(this.clock(), this.config.dailyConsolidateAt, details.dailyConsolidation?.day) : null,
        settingsRevision: this.descriptor()?.revision ?? null, busy: this.busy,
        error: this.lastError?.space && this.lastError.space !== spaceName ? null : this.lastError,
        spaceErrors: Object.fromEntries(this.spaceErrors),
        sessions: [...this.ctx.agents.list()].filter(a => a.session.header.origin !== 'subagent')
          .map(a => ({ id: a.id, cwd: a.session.header.cwd ?? '', status: a.status })) };
    }
    if (method === 'POST' && path === '/config') {
      const descriptor = this.descriptor();
      requireValue(descriptor, 'SETTINGS_UNAVAILABLE', '找不到宿主设置入口 tidal-memory。', 503);
      requireValue(body && typeof body.patch === 'object' && body.patch !== null, 'INVALID_CONFIG', '配置补丁无效。');
      requireValue(Object.keys(body.patch).every(key => key in this.config), 'INVALID_CONFIG', '包含未知配置项。');
      const validated = configOf({ ...this.config, ...body.patch });
      requireValue(validated.dataRoot === this.config.dataRoot, 'ROOT_RESTART_REQUIRED', '修改数据根目录需要停止插件并使用备份迁移。');
      requireValue(body.revision === descriptor.revision, 'REVISION_CONFLICT', '设置已变化，请刷新后重试。', 409);
      if (validated.autoBackupMode !== 'plain' && validated.autoBackupMode !== this.config.autoBackupMode)
        readAutomaticKey(this.root);
      const patch = Object.fromEntries(Object.entries(body.patch).filter(([key, value]) =>
        key !== 'dataRoot' && JSON.stringify(value) !== JSON.stringify(this.config[key])));
      if (Object.keys(patch).length) await this.ctx.settings.update(descriptor.ns, patch, body.revision);
      this.syncConfig();
      return { saved: true };
    }
    if (method === 'POST' && path === '/restore') {
      const result = restoreBackup(this.root, slug(body.name), body.text, body.password ?? '', this.config);
      return result;
    }
    if (method === 'POST' && path === '/backup/key') return saveAutomaticKey(this.root, body.password);
    const store = this.space(spaceName);
    store.reconcileForgetLedger();
    if (method === 'GET' && path === '/memories') return store.list({
      layer: query.get('layer') || undefined, status: query.get('status') || undefined,
      query: query.get('q') ?? '', offset: Number(query.get('offset') ?? 0), limit: 50,
    }, ADMIN);
    if (method === 'POST' && path === '/memories') {
      const result = store.create(body, ADMIN);
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/update') {
      const result = store.update(body.id, body.patch, body.revision, ADMIN);
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/promote') {
      const result = store.promote(body.id, body.target, ADMIN);
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/forget') {
      requireValue(body.confirmation === 'DELETE', 'CONFIRMATION_REQUIRED', '请输入 DELETE 确认删除。');
      const result = store.forget(body.id, ADMIN);
      this.semanticQueries.clear();
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/confirm') {
      const result = store.reinforce(body.id, `ui:${randomUUID()}`, ADMIN);
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'GET' && path === '/history') return store.revisions(query.get('id'), ADMIN);
    if (method === 'GET' && path === '/evidence') return store.get(query.get('id'), ADMIN).sources;
    if (method === 'GET' && path === '/lifecycle') return store.lifecycle(query.get('id'), ADMIN);
    if (method === 'GET' && path === '/traces') return store.traces(ADMIN);
    if (method === 'POST' && path === '/recall') return this.recallAsync(store, ADMIN, body.query, {
      includeArchived: body.includeArchived === true, mode: body.mode ?? 'current', asOf: body.asOf });
    if (method === 'POST' && path === '/topics/read') return store.readEvidence(body, ADMIN);
    if (method === 'POST' && path === '/semantic/prepare') {
      requireValue(this.config.embeddingMode !== 'off', 'SEMANTIC_DISABLED', '请先选择并保存本地语义组合。');
      const result = await this.prepareSemantic(store, ADMIN, '');
      requireValue(result.status.state === 'ready', result.status.code ?? 'SEMANTIC_FAILED',
        result.status.message ?? '语义索引未准备完成。', 503);
      return result.status;
    }
    if (method === 'POST' && path === '/semantic/rebuild') {
      requireValue(this.config.embeddingMode !== 'off', 'SEMANTIC_DISABLED', '请先启用语义组合。');
      requireValue(![...this.semanticTasks].some(task => task.kind === 'foreground'), 'SEMANTIC_BUSY',
        '共享本地模型正在响应前台语义请求，请稍后重建。', 409);
      const prewarm = [...this.semanticTasks].filter(task => task.kind === 'prewarm');
      this.cancelPrewarm();
      this.embedding.reload();
      await Promise.allSettled(prewarm.map(task => task.promise));
      store.semanticIndex?.close();
      store.semanticIndex = null;
      clearSemanticFiles(store.directory);
      this.semanticQueries.clear();
      this.semanticResults.clear();
      this.invalidateSpace(spaceName);
      const result = await this.prepareSemantic(store, ADMIN, '');
      requireValue(result.status.state === 'ready', result.status.code ?? 'SEMANTIC_FAILED',
        result.status.message ?? '请先启用语义组合。', 503);
      return result.status;
    }
    if (method === 'POST' && path === '/timeline') return store.timeline(body, ADMIN);
    if (method === 'POST' && path === '/maintenance') return this.requestMaintenance(true, spaceName);
    if (method === 'POST' && path === '/consolidate') {
      requireValue(!this.busy, 'MAINTENANCE_BUSY', '整理任务正在运行，请稍后重试。', 409);
      requireValue(![...this.ctx.agents.list()].some(agent => agent.status === 'running' &&
        bindingFor(this.config, agent.session.header.cwd)?.space === spaceName),
      'CONVERSATION_BUSY', '当前空间正在生成回复，请等会话空闲后再整理。', 409);
      this.busy = true;
      try {
        const now = this.clock();
        const due = this.config.dailyConsolidateAt ? latestScheduledAt(now, this.config.dailyConsolidateAt) : now;
        const backup = automaticBackup(store, this.root, { force: true });
        const privateOrganization = this.runPrivateOrganization(store, now, due);
        const previousDue = new Date(due);
        previousDue.setDate(previousDue.getDate() - 1);
        const from = store.system.prepare("SELECT value FROM metadata WHERE key='sleep-reencoding-until'").get()?.value ??
          previousDue.toISOString();
        return { ...store.manualDeepConsolidation(dateKey(now), { backup, from, until: now.toISOString() }), privateOrganization,
          modelExtraction: this.modelOrganizationStatus() };
      } finally {
        this.busy = false;
        this.invalidateSpace(spaceName);
      }
    }
    if (method === 'POST' && (path === '/rebuild' || path === '/rebuild/search')) {
      const result = store.rebuildSearch();
      if (path === '/rebuild') store.rebuildViews();
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/rebuild/views') { store.rebuildViews(); return { rebuilt: true }; }
    if (method === 'POST' && path === '/rebuild/topics') {
      store.topicIndex?.close();
      store.topicIndex = null;
      store.topicCardCache.clear();
      clearTopicFiles(store.directory);
      store.topics();
      return { rebuilt: true };
    }
    if (method === 'GET' && path === '/private') return store.privateStatus();
    if (method === 'POST' && path === '/private/organize') {
      requireValue(!this.busy, 'MAINTENANCE_BUSY', '整理任务正在运行，请稍后重试。', 409);
      requireValue(![...this.ctx.agents.list()].some(agent => agent.status === 'running' &&
        bindingFor(this.config, agent.session.header.cwd)?.space === spaceName),
      'CONVERSATION_BUSY', '当前空间正在生成回复，请等会话空闲后再整理。', 409);
      const now = this.clock();
      const due = this.config.dailyConsolidateAt ? latestScheduledAt(now, this.config.dailyConsolidateAt) : now;
      const result = this.runPrivateOrganization(store, now, due);
      requireValue(!['failed', 'unavailable'].includes(result.state), result.code,
        result.message ?? '私人整理未完成，请检查状态后重试。', 409);
      return result;
    }
    if (method === 'POST' && path === '/private/clear') return store.clearPrivate(ADMIN, body.confirmation);
    if (method === 'POST' && path === '/backup') return { filename: `tidal-${spaceName}-${Date.now()}.${body.password ? 'encrypted' : 'json'}`,
      text: packBackup(store, body.password ?? '') };
    if (method === 'POST' && path === '/import/preview') {
      for (const [id, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(id);
      requireValue(this.plans.size < 5, 'TOO_MANY_PREVIEWS', '尚有导入预览待处理，请完成或等待过期。', 429);
      const plan = importPreview(body.files);
      const id = randomUUID();
      this.plans.set(id, { ...plan, space: spaceName, expires: Date.now() + 20 * 60000 });
      return { id, candidates: plan.candidates, privateCount: plan.privateFiles.length };
    }
    if (method === 'POST' && path === '/import/apply') {
      const plan = this.plans.get(body.id);
      requireValue(plan && plan.expires >= Date.now() && plan.space === spaceName, 'PREVIEW_EXPIRED', '预览已过期或空间已切换，请重新预览。', 409);
      const result = applyImport(store, plan, body.selected);
      this.plans.delete(body.id);
      this.invalidateSpace(spaceName);
      return result;
    }
    throw new MemoryError('NOT_FOUND', '没有此接口。', 404);
  }
  async handle(req, res) {
    const reply = (status, value) => {
      if (res.writableEnded) return;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(JSON.stringify(value));
    };
    try {
      requireValue(this.ctx.connection?.requestRejection, 'AUTH_UNAVAILABLE', '宿主认证服务不可用。', 503);
      const rejection = this.ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
      requireValue(['GET', 'POST'].includes(req.method), 'METHOD_NOT_ALLOWED', '请求方法不受支持。', 405);
      const url = new URL(req.url, 'http://localhost');
      let body = {};
      if (req.method === 'POST') {
        requireValue(req.headers['x-tidal-request'] === '1' &&
          String(req.headers['content-type'] ?? '').startsWith('application/json'), 'CSRF', '缺少受信任的请求标记。', 403);
        const limit = url.pathname === `${PREFIX}/restore` ? MAX_RESTORE_BODY : MAX_BODY;
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          requireValue(size <= limit, 'BODY_TOO_LARGE',
            limit === MAX_BODY ? '请求超过 12 MiB。' : '恢复请求超过 256 MiB 加少量封装开销。', 413);
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requireValue(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_INPUT', '请求必须是 JSON 对象。');
      }
      const result = await this.api(req.method, url.pathname.slice(PREFIX.length), url.searchParams, body);
      reply(200, { ok: true, data: result });
    } catch (error) {
      const status = error instanceof MemoryError ? error.status : error instanceof SyntaxError ? 400 : 500;
      if (status === 500) this.noteError('REQUEST_FAILED', '记忆操作失败，请查看状态并确认数据目录可写。');
      reply(status, { ok: false, error: { code: error.code ?? (status === 400 ? 'INVALID_JSON' : 'REQUEST_FAILED'),
        message: error instanceof MemoryError ? error.message : status === 400 ? 'JSON 格式无效。' : '操作失败，未确认完成；请检查状态后重试。' } });
    }
  }
  async close() {
    this.disposed = true;
    const errors = [];
    for (const task of this.semanticTasks) task.controller.abort();
    try { await this.embedding.close(); } catch (error) { errors.push(error); }
    await Promise.allSettled([...this.jobs]);
    for (const store of this.spaces.values()) {
      try { store.close(); } catch (error) { errors.push(error); }
    }
    this.spaces.clear();
    this.plans.clear();
    if (errors.length) throw new AggregateError(errors, '部分潮汐记忆资源未能关闭。');
  }
}
