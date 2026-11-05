import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemorySpace } from './store.js';
import { LocalEmbedding, modelInventory } from './embedding.js';
import { SemanticIndex, semanticChunks, clearSemanticFiles } from './semantic-index.js';
import { automaticBackup, applyImport, importPreview, packBackup, restoreBackup } from './transfer.js';
import { bindingFor, classifyRememberDirective, configOf, MAX_RECALL_QUERY_LENGTH, MemoryError, requireValue, slug, splitCapture, string } from './model.js';

export const ADMIN = Object.freeze({ admin: true });
export const PREFIX = '/tidal-memory';
const MAX_BODY = 12 * 1024 * 1024;
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
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
    if (modelKey !== this.embedding.key) this.semanticQueries.clear();
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
        this.spaces.get(name).onForget = () => { this.semanticQueries.clear(); this.invalidateSpace(name); };
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
      .filter(item => item.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name) && !item.name.startsWith('restore-'))
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
    return { store: this.space(binding.space), actor: { sessionId: agent.id }, space: binding.space };
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
    const cached = this.cachedSemantic(store, query, options.contextQueries ?? [], state);
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
  cachedSemantic(store, query, contextQueries, state) {
    if (this.config.embeddingMode === 'off') return { semantic: [], semanticStatus: { mode: 'off', state: 'disabled' } };
    const cached = state?.semantic;
    if (cached?.key === this.semanticKey(store, query, contextQueries) && cached.generation === store.generation)
      return { semantic: cached.hits, semanticStatus: cached.status };
    return { semantic: [], semanticStatus: { mode: this.config.embeddingMode, state: 'lexical',
      code: 'SEMANTIC_NOT_PREPARED', message: '语义线索尚未就绪或记忆已经变化，本次只使用词面检索。' } };
  }
  async prepareSemantic(store, actor, query, options = {}, signal) {
    const contextQueries = options.contextQueries ?? [];
    string(query, '查询', MAX_RECALL_QUERY_LENGTH, true);
    requireValue(Array.isArray(contextQueries) && contextQueries.length <= 10, 'INVALID_INPUT', '情境窗最多 10 条消息。');
    contextQueries.forEach(text => string(text, '情境线索', MAX_RECALL_QUERY_LENGTH, true));
    store.recallScope(actor, options);
    const mode = this.config.embeddingMode;
    const key = this.semanticKey(store, query, contextQueries);
    if (mode === 'off') return { key, generation: store.generation, hits: [], status: { mode, state: 'disabled' } };
    if (signal?.aborted) throw new MemoryError('SEMANTIC_CANCELLED', '当前语义检索已取消。', 409);
    const modelKey = this.embedding.key;
    const job = (async () => {
      store.semanticIndex ??= new SemanticIndex(store);
      await store.semanticIndex.sync(this.embedding);
      const pack = await this.embedding.ready();
      let queries = this.semanticQueries.get(key);
      if (!queries) {
        const chunks = [query, ...contextQueries].flatMap((text, contextIndex) =>
          text.trim() ? semanticChunks(text, pack.chunkSize).map(text => ({ text, contextIndex })) : []);
        queries = [];
        for (let offset = 0; offset < chunks.length; offset += 16) {
          const batch = chunks.slice(offset, offset + 16);
          const vectors = await this.embedding.embed(batch.map(item => item.text), 'query');
          queries.push(...vectors.map((vector, index) => ({ vector, contextIndex: batch[index].contextIndex })));
        }
        requireValue(modelKey === this.embedding.key && !this.disposed, 'MODEL_CHANGED', '本地模型已切换或停止。', 409);
        if (this.semanticQueries.size >= 64) this.semanticQueries.delete(this.semanticQueries.keys().next().value);
        this.semanticQueries.set(key, queries);
      }
      const policy = { ...pack,
        minScore: this.config.embeddingMinScore === -1 ? pack.minScore : this.config.embeddingMinScore,
        relativeFloor: this.config.embeddingRelativeFloor === -1 ? pack.relativeFloor : this.config.embeddingRelativeFloor };
      const hits = queries.length ? store.semanticIndex.search(queries, policy,
        { accept: store.recallScope(actor, options).accept, limit: Math.max(60, this.config.maxRecall * 4) }) : [];
      const index = store.semanticIndex.status();
      return { key, generation: store.generation, hits, status: { mode, state: index.pending ? 'partial' : 'ready',
        model: pack.modelId, fingerprint: pack.fingerprint, candidates: hits.length, index,
        minScore: policy.minScore, relativeFloor: policy.relativeFloor } };
    })();
    this.jobs.add(job);
    job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    try {
      const result = await waitForLocal(job, this.config.embeddingTimeoutSeconds * 1000, signal);
      if (result.status.state === 'ready' && this.lastError?.operation === 'semantic' && this.lastError.space === store.name)
        this.lastError = null;
      return result;
    }
    catch (error) {
      this.noteError(error.code ?? 'SEMANTIC_FAILED', `本地语义检索未完成：${error.message}`,
        { operation: 'semantic', space: store.name });
      return { key, generation: store.generation, hits: [], status: { mode, state: 'degraded',
        code: error.code ?? 'SEMANTIC_FAILED', message: error.message } };
    }
  }
  async recallAsync(store, actor, query, options = {}, signal) {
    const result = await this.prepareSemantic(store, actor, query, options, signal);
    requireValue(!this.disposed, 'CLOSED', '插件已停止。', 503);
    this.syncConfig();
    requireValue(!signal?.aborted && result.key === this.semanticKey(store, query, options.contextQueries ?? []),
      'SEMANTIC_OBSOLETE', '查询已取消或模型配置已变化，请重新检索。', 409);
    return store.recall(query, actor, { ...options, semantic: result.hits, semanticStatus: result.status });
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
    return store.recall(query, current.actor, { ...options, evidenceId,
      semantic: result.hits, semanticStatus: result.status });
  }
  async preStep({ agent, signal }, next) {
    const decision = await next();
    if (decision.kind === 'reject' || signal?.aborted || this.disposed) return decision;
    try {
      this.syncConfig();
      if (!this.config.enabled || agent.session?.header.origin === 'subagent') return decision;
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
          state.semanticRequest === token && result.key === this.semanticKey(store, query, contextQueries)) {
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
      if (state.context === null || state.generation !== store.generation) {
        const { query, contextQueries, pending } = this.queryWindow(state);
        const recalled = store.recall(query, actor, { contextQueries,
          ...this.cachedSemantic(store, query, contextQueries, state),
          evidenceId: pending || state.evidenceId === undefined ? undefined : `user-event:${state.evidenceId}` });
        const incomplete = this.config.embeddingMode !== 'off' && recalled.semanticStatus?.state !== 'ready';
        state.context = recalled.text + (incomplete ? '\n[本地语义联想尚未完整就绪，召回可能遗漏；不要据此断言不存在相关历史。]' : '');
        if (pending) state.pendingRecall = { query,
          ids: recalled.picked.filter(item => item.matched).map(item => item.id) };
        state.generation = store.generation;
        if (this.lastError?.operation === 'recall' && this.lastError.space === space) this.lastError = null;
      }
      return state.context;
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
        results.push({ space: name, ...maintenance, localOrganization, consolidation });
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
          const result = store.dailyConsolidation(day, {
            missed: now.getTime() - due.getTime() > 60000, backup,
          });
          if (this.lastError?.operation === 'consolidation' && this.lastError.space === name) this.lastError = null;
          results.push({ space: name, ...result });
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
  async api(method, path, query, body) {
    this.syncConfig();
    const spaceName = slug(query.get('space') ?? 'default');
    if (method === 'GET' && path === '/status') {
      let details;
      try { details = this.space(spaceName).status(); } catch (error) {
        if (error.code !== 'SPACE_BUSY') throw error;
        details = { space: spaceName, unavailable: true, spaceError: this.spaceErrors.get(spaceName), layers: [] };
      }
      const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` :
        `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(fileURLToPath(
        new URL('../scripts/setup-model.mjs', import.meta.url)))}`;
      return { version: '0.4.0', root: this.root, spaces: this.names(), ...details,
        paths: { plugin: fileURLToPath(new URL('../', import.meta.url)), models: join(this.root, 'models'),
          semanticIndex: join(this.root, 'spaces', spaceName, 'indexes', 'semantic.sqlite3'),
          backups: join(this.root, 'backups', spaceName) },
        modelPacks: modelInventory(this.root).map(item => ({ ...item,
          installCommand: `${command} --edition ${item.edition} --root ${quote(this.root)}` })),
        semantic: { ...this.embedding.state, index: this.spaces.get(spaceName)?.semanticIndex?.status() ?? null },
        config: this.config, legacyModelExtractionIgnored: this.legacyModelExtractionIgnored,
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
    const store = this.space(spaceName);
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
    if (method === 'GET' && path === '/traces') return store.traces(ADMIN);
    if (method === 'POST' && path === '/recall') return this.recallAsync(store, ADMIN, body.query, {
      includeArchived: body.includeArchived === true, mode: body.mode ?? 'current', asOf: body.asOf });
    if (method === 'POST' && path === '/semantic/prepare') {
      requireValue(this.config.embeddingMode !== 'off', 'SEMANTIC_DISABLED', '请先选择并保存本地语义组合。');
      const result = await this.prepareSemantic(store, ADMIN, '');
      requireValue(result.status.state === 'ready', result.status.code ?? 'SEMANTIC_FAILED',
        result.status.message ?? '语义索引未准备完成。', 503);
      return result.status;
    }
    if (method === 'POST' && path === '/semantic/rebuild') {
      requireValue(!this.jobs.size, 'SEMANTIC_BUSY', '语义任务正在运行，请稍后重建。', 409);
      requireValue(this.config.embeddingMode !== 'off', 'SEMANTIC_DISABLED', '请先启用语义组合。');
      store.semanticIndex?.close();
      store.semanticIndex = null;
      clearSemanticFiles(store.directory);
      this.embedding.reload();
      this.semanticQueries.clear();
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
        const backup = automaticBackup(store, this.root, { force: true });
        return store.manualDeepConsolidation(dateKey(this.clock()), { backup });
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
    if (method === 'GET' && path === '/private') return store.privateStatus();
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
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          requireValue(size <= MAX_BODY, 'BODY_TOO_LARGE', '请求超过 12 MiB。', 413);
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
    await this.embedding.close();
    await Promise.allSettled([...this.jobs]);
    for (const store of this.spaces.values()) store.close();
    this.spaces.clear();
    this.plans.clear();
  }
}
