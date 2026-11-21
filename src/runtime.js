import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemorySpace } from './store.js';
import { LocalEmbedding, modelInventory } from './embedding.js';
import { PrivateSessionRegistry } from './private-session-registry.js';
import { SemanticIndex, semanticChunks, clearSemanticFiles } from './semantic-index.js';
import { clearTopicFiles } from './topic-index.js';
import { clearGraphFiles } from './graph-index.js';
import { graphSemanticSuggestions } from './graph-semantic.js';
import { privateJournalStatus } from './private-journal.js';
import { privateJournalDatabasePath } from './journal-files.js';
import { automaticBackup, applyImport, importPreview, packBackup, restoreBackup, MAX_RESTORE_BODY_BYTES } from './transfer.js';
import { automaticKeyStatus, clearModelApiKey, modelApiKeyStatus, readAutomaticKey, readModelApiKey,
  saveAutomaticKey, saveModelApiKey } from './backup-key.js';
import { organizeMemoryBatch, summarizeDailyMessages } from './model-consolidation.js';
import { assistantClaim } from './event-capture.js';
import { LOCAL_FOLDER, locations, prepareWorkspace, readLocation, suggestedSpace, verifiedLocalDirectory } from './workspace-storage.js';
import { bindingFor, configOf, containsCredential, ENCODING_VERSION, LAYERS, MAX_RECALL_QUERY_LENGTH,
  canonicalCwd, hash, localCandidates, localDateKey, MemoryError, normalizeRecord, requireValue,
  SEARCH_VERSION, slug, string, terms } from './model.js';

export const ADMIN = Object.freeze({ admin: true });
export const PREFIX = '/tidal-memory';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_RESTORE_BODY = MAX_RESTORE_BODY_BYTES;
const MODEL_BATCH_BYTES = 64 * 1024;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_HISTORY_BYTES = 6 * 1024;
const MAX_HISTORY_WINDOW_BYTES = MAX_HISTORY_BYTES - 1024;
const MAX_HISTORY_SESSIONS = 3;
const MAX_HISTORY_WINDOWS = 2;
const MAX_HISTORY_WINDOW_EVENTS = 5;
const MAX_HISTORY_IMPORT_CANDIDATES = 200;
const ROUTE_SETTINGS = ['privateMainSessions', 'historyMainSessions', 'deepOrganizationSessions'];
const sameBinding = (current, expected) => Boolean(current && expected && current.workspaceId === expected.workspaceId &&
  canonicalCwd(current.cwd) === canonicalCwd(expected.cwd));
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
    this.privateSessions = null;
    this.semanticQueries = new Map();
    this.semanticResults = new Map();
    this.semanticTasks = new Set();
    this.graphTasks = new Map();
    this.graphSuggestionTasks = new Map();
    this.lastSemanticTask = new Map();
    this.prewarmQueue = Promise.resolve();
    this.spaces = new Map();
    this.localWorkspaces = new Map();
    this.directoryReady = false;
    this.spaceErrors = new Map();
    this.plans = new Map();
    this.sessions = new Map();
    this.privateCandidates = new Map();
    this.pendingPrivateObservations = new Map();
    this.privateAgentDisposers = new Map();
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
      for (const task of this.graphSuggestionTasks.values()) task.controller.abort();
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
    const directory = this.directoryFor(name);
    if (!this.spaces.has(name)) {
      try {
        this.spaces.set(name, new MemorySpace(this.root, name, { directory, config: this.config, clock: () => this.clock().getTime() }));
        this.spaces.get(name).onForget = () => {
          this.semanticQueries.clear();
          this.semanticResults.clear();
          const lineage = this.spaces.get(name)?.lineageId;
          for (const [otherName, store] of this.spaces) if (store.lineageId === lineage) this.invalidateSpace(otherName);
        };
        this.spaces.get(name).onPrivacyChange = () => {
          for (const task of this.semanticTasks) if (task.space === name) task.controller.abort();
          this.cancelGraphBuild(name);
          this.semanticQueries.clear();
          this.semanticResults.clear();
          this.invalidateSpace(name);
        };
        this.spaceErrors.delete(name);
      } catch (error) {
        this.spaceErrors.set(name, { code: error.code ?? 'OPEN_FAILED',
          message: error instanceof MemoryError ? error.message : '空间无法打开，请检查数据目录。',
          at: new Date().toISOString() });
        throw error;
      }
    }
    const store = this.spaces.get(name);
    requireValue(canonicalCwd(store.directory) === canonicalCwd(directory), 'WORKSPACE_CHANGED', '空间位置已变化；请重启插件。', 409);
    return store;
  }
  directoryFor(name) {
    if (!this.directoryReady && this.hostService('workspaceRegistry')?.list) this.refreshWorkspaceFolders();
    const row = this.localWorkspaces.get(name);
    if (!row) {
      requireValue(!readLocation(this.root, name), 'WORKSPACE_OFFLINE', '该记忆库所属的 DSH 工作区已离线，未回退到集中目录。', 409);
      return join(this.root, 'spaces', slug(name));
    }
    requireValue(!row.error, row.error?.code, row.error?.message, 409);
    const live = this.hostService('workspaceRegistry')?.get?.(row.id);
    requireValue(live && canonicalCwd(live.path) === canonicalCwd(row.cwd), 'WORKSPACE_OFFLINE', 'DSH 工作区位置已变化。', 409);
    return verifiedLocalDirectory(this.root, row, name, !this.spaces.has(name));
  }
  refreshWorkspaceFolders() {
    const rows = this.workspaceDirectory();
    const receipts = locations(this.root), reserved = new Set([...this.names(), ...receipts.map(item => item.space)]);
    const next = new Map();
    for (const row of rows) {
      const binding = this.config.bindings.find(b => b.workspaceId === row.id ||
        (!b.workspaceId && canonicalCwd(b.cwd) === canonicalCwd(row.cwd)));
      const known = receipts.find(item => item.id === row.id);
      const space = known?.space ?? binding?.space ?? suggestedSpace(row, reserved);
      reserved.add(space);
      let error;
      try {
        requireValue(!next.has(space) && (!binding || !known || binding.space === known.space),
          'WORKSPACE_CHANGED', '工作区和现有空间的对应关系冲突，未合并。', 409);
        if (known && this.localWorkspaces.get(space)?.id === row.id && !this.localWorkspaces.get(space).error)
          verifiedLocalDirectory(this.root, row, space);
        else prepareWorkspace(this.root, row, space);
      } catch (reason) {
        error = { code: reason.code || 'WORKSPACE_FOLDER_UNAVAILABLE', message: reason instanceof MemoryError ?
          reason.message : '工作区记忆目录不可用；请检查磁盘与访问权限。' };
      }
      next.set(space, { ...row, space, bound: Boolean(binding), memoryDirectory: join(row.cwd, LOCAL_FOLDER), ...(error ? { error } : {}) });
    }
    this.localWorkspaces = next;
    this.directoryReady = true;
    return [...next.values()];
  }
  names() {
    const path = join(this.root, 'spaces');
    const stored = existsSync(path) ? readdirSync(path, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name) &&
        !/^restore-[a-f0-9-]{36}$/.test(item.name))
      .map(item => item.name) : [];
    return [...new Set([...stored, ...this.config.bindings.map(b => b.space)])].sort();
  }
  workspaceDirectory() {
    const registry = this.hostService('workspaceRegistry');
    requireValue(typeof registry?.list === 'function', 'WORKSPACE_DIRECTORY_UNAVAILABLE',
      '当前宿主未提供工作区列表。可重试或使用高级手动绑定。', 503);
    let rows;
    try { rows = registry.list(); }
    catch { throw new MemoryError('WORKSPACE_DIRECTORY_UNAVAILABLE', 'DSH 工作区目录暂不可用，请刷新重试。', 503); }
    requireValue(Array.isArray(rows) && rows.every(row => typeof row?.id === 'string' && row.id &&
      canonicalCwd(row.path) && typeof row.title === 'string'), 'WORKSPACE_DIRECTORY_INVALID', 'DSH 工作区列表格式无效。', 502);
    return rows.map(({ id, title, path }) => ({ id, title, cwd: path }));
  }
  activeBinding(binding) {
    if (!binding) return undefined;
    const local = this.localWorkspaces.get(binding.space);
    if (local?.error || (local && canonicalCwd(local.cwd) !== canonicalCwd(binding.cwd))) return undefined;
    const id = binding.workspaceId || local?.id;
    if (!id) return binding;
    const row = this.hostService('workspaceRegistry')?.get?.(id);
    return row?.id === id && canonicalCwd(row.path) === canonicalCwd(binding.cwd) ? binding : undefined;
  }
  bindingAt(cwd) { return this.activeBinding(bindingFor(this.config, cwd)); }
  bindingIn(space) { return this.activeBinding(this.config.bindings.find(item => item.space === space)); }
  async saveSettings(patch, revision) {
    const descriptor = this.descriptor();
    requireValue(descriptor, 'SETTINGS_UNAVAILABLE', '找不到宿主设置入口 tidal-memory。', 503);
    requireValue(revision === descriptor.revision, 'REVISION_CONFLICT', '设置已变化。草稿保留；请刷新核对后重试。', 409);
    const validated = configOf({ ...this.config, ...patch });
    requireValue(validated.dataRoot === this.config.dataRoot, 'ROOT_RESTART_REQUIRED', '修改数据根目录需要停止插件并使用备份迁移。');
    if (validated.autoBackupMode !== 'plain' && validated.autoBackupMode !== this.config.autoBackupMode)
      readAutomaticKey(this.root);
    const changed = Object.fromEntries(Object.keys(patch).filter(key => key !== 'dataRoot' &&
      JSON.stringify(validated[key]) !== JSON.stringify(this.config[key])).map(key => [key, validated[key]]));
    if (Object.keys(changed).length) await this.ctx.settings.update(descriptor.ns, changed, revision);
    this.syncConfig();
  }
  async changeBinding(space, body) {
    let bindings = this.config.bindings;
    const patch = {};
    if (body.action === 'bind' || body.action === 'manual') {
      let cwd, workspaceId;
      if (body.action === 'bind') {
        const row = this.workspaceDirectory().find(item => item.id === body.workspaceId);
        requireValue(row && canonicalCwd(row.cwd) === canonicalCwd(body.cwd), 'WORKSPACE_CHANGED',
          '该工作区已变化，请刷新列表后重新选择。', 409);
        ({ cwd, id: workspaceId } = row);
      } else {
        cwd = string(body.cwd, '工作区绝对路径', 2048);
        requireValue(canonicalCwd(cwd), 'INVALID_CONFIG', '请输入工作区绝对路径。');
        if (this.hostService('workspaceRegistry')?.list) {
          workspaceId = this.workspaceDirectory().find(item => canonicalCwd(item.cwd) === canonicalCwd(cwd))?.id;
        }
      }
      const existing = bindingFor(this.config, cwd);
      if (existing) {
        requireValue(this.activeBinding(existing), 'WORKSPACE_CHANGED', '旧绑定的工作区身份已失效；请先解除旧绑定。', 409);
        return { space: existing.space, alreadyBound: true };
      }
      const local = workspaceId && this.refreshWorkspaceFolders().find(row => row.id === workspaceId);
      if (local) requireValue(!local.error && (!body.reuseSpace || body.reuseSpace === local.space),
        'WORKSPACE_FOLDER_UNAVAILABLE', local.error?.message || '不能将其他空间覆盖到现有工作区记忆目录。', 409);
      const names = new Set(this.names());
      if (local) {
        space = local.space;
      } else if (body.reuseSpace) {
        space = slug(body.reuseSpace);
        requireValue(names.has(space) && !bindings.some(item => item.space === space),
          'SPACE_UNAVAILABLE', '所选已有空间不可绑定。', 409);
      } else {
        const ledger = join(this.root, 'system', 'forget-ledger.sqlite3');
        if (existsSync(ledger)) {
          const db = new DatabaseSync(ledger, { readOnly: true });
          try { for (const row of db.prepare('SELECT name FROM spaces').iterate()) names.add(row.name); }
          finally { db.close(); }
        }
        const prefix = `mem-${hash(workspaceId || canonicalCwd(cwd)).slice(0, 12)}`;
        space = prefix;
        for (let i = 2; names.has(space); i++) space = `${prefix}-${i}`;
      }
      bindings = [...bindings, { cwd, space, ...(workspaceId ? { workspaceId } : {}) }];
    } else {
      const target = bindings.find(item => item.space === space);
      requireValue(target, 'UNBOUND_WORKSPACE', '此空间尚未绑定。', 409);
      if (body.action === 'rename') {
        const displayName = string(body.displayName, '空间显示名', 128, true);
        bindings = bindings.map(item => item === target ? { ...item, displayName } : item);
      } else {
        requireValue(body.action === 'unbind', 'INVALID_INPUT', '未知的绑定操作。');
        bindings = bindings.filter(item => item !== target);
        for (const key of ROUTE_SETTINGS) patch[key] = this.config[key].filter(item => item.space !== space);
      }
    }
    await this.saveSettings({ ...patch, bindings }, body.revision);
    if (body.action === 'unbind') {
      for (const [id, plan] of this.plans) if (plan.space === space) this.plans.delete(id);
    }
    return { space, saved: true };
  }
  forAgent(agent) {
    this.syncConfig();
    requireValue(this.config.enabled, 'DISABLED', '记忆插件已关闭。', 403);
    requireValue(agent?.session && agent.session.id === agent.id && this.ctx.agents.get(agent.id) === agent,
      'NO_AGENT', '缺少宿主登记的会话身份。', 403);
    requireValue(!this.privateSessionBlock(agent), 'PRIVATE_SESSION_UNAUTHORIZED',
      '当前会话的私人历史或授权状态不允许普通记忆访问。', 403);
    const binding = this.bindingAt(agent.session.header.cwd);
    requireValue(binding, 'UNBOUND_WORKSPACE', '当前工作区未绑定记忆空间，请在设置中绑定。', 403);
    const store = this.space(binding.space);
    store.reconcileForgetLedger();
    return { store, actor: { sessionId: agent.id,
      privateSession: Boolean(this.privateSessionRegistry().get(agent.id)) }, space: binding.space };
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
    const privateSession = Boolean(this.privateSessionRegistry().get(session.id));
    const store = this.spaces.get(space);
    const version = store?.forgetVersion();
    const unknownCoverage = store?.forgetLedger.hasUnknownEventCoverage(store.lineageId);
    if (!state || state.space !== space) {
      const recent = [];
      const events = privateSession || !store || unknownCoverage ? [] : session.snapshotEvents?.() ?? [];
      for (let i = events.length - 1; i >= 0 && recent.length < this.config.contextMessages; i--) {
        const event = events[i];
        if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
        if (Number.isSafeInteger(event.seq) &&
            store.forgetLedger.hasEvent(store.lineageId, session.id, event.seq)) continue;
        const text = textOf(event.data);
        if (text.trim() && !containsCredential(text)) recent.unshift({ seq: event.seq, text: recallQuery(text) });
      }
      state = { recent, query: recent.at(-1)?.text ?? '', evidenceId: recent.at(-1)?.seq,
        context: null, turn: null, lastSeen: this.clock().getTime(), space, privateSession, forgetVersion: version };
      this.sessions.set(session.id, state);
    } else if (privateSession && !state.privateSession) {
      state.recent = [];
      state.query = '';
      state.evidenceId = undefined;
      state.pendingQueries = [];
      state.pendingRecall = null;
      state.context = null;
      state.semantic = null;
      state.privateSession = true;
    }
    if (store && state.forgetVersion !== version) {
      state.recent = unknownCoverage ? [] : (state.recent ?? []).filter(item =>
        !store.forgetLedger.hasEvent(store.lineageId, session.id, item.seq));
      if (unknownCoverage || state.evidenceId !== undefined &&
          store.forgetLedger.hasEvent(store.lineageId, session.id, state.evidenceId)) {
        state.query = '';
        state.evidenceId = undefined;
      }
      state.pendingQueries = [];
      state.pendingRecall = null;
      state.context = null;
      state.semantic = null;
      state.forgetVersion = version;
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
  queryWindow(state, store, actor) {
    const pending = state.pendingQueries ?? [];
    const focus = store.sessionFocus(actor);
    const focusText = [focus.task?.text, focus.scene?.title].filter(Boolean).join(' ');
    const recent = (state.recent ?? []).map(item => item.text);
    const queries = [...(focusText ? [focusText] : []), ...recent, ...pending]
      .filter(Boolean).slice(-this.config.contextMessages);
    const query = pending.at(-1) ?? (state.query ? recallQuery(state.query) : focusText);
    return { query, contextQueries: queries.filter(text => text !== query).reverse(), pending: pending.length > 0 };
  }
  semanticKey(store, query, contextQueries) {
    return JSON.stringify([this.embedding.key, store.name, query, contextQueries]);
  }
  semanticResultKey(store, actor, query, contextQueries, options = {}) {
    const scope = store.recallScope(actor, options);
    return JSON.stringify([this.semanticKey(store, query, contextQueries), store.generation, store.forgetVersion(), store.privateVersion(),
      actor?.admin === true, actor?.privateSession === true, actor?.sessionId ?? null, options.mode ?? 'current', scope.at,
      options.includeArchived === true, this.config.embeddingMinScore, this.config.embeddingRelativeFloor, this.config.maxRecall]);
  }
  cachedSemantic(store, actor, query, contextQueries, state, options = {}) {
    if (this.config.embeddingMode === 'off') return { semantic: [], semanticStatus: { mode: 'off', state: 'disabled' } };
    if (actor?.privateSession) return { semantic: [], semanticStatus: { mode: this.config.embeddingMode,
      state: 'privacy-lexical', code: 'PRIVATE_QUERY_EXCLUDED', message: '私人历史会话不向语义模型发送查询。' } };
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
  cancelGraphBuild(name) {
    this.graphTasks.get(name)?.controller.abort();
    this.graphSuggestionTasks.get(name)?.controller.abort();
  }
  requestGraphBuild(store) {
    if (this.disposed) return { state: 'closed' };
    const active = this.graphTasks.get(store.name);
    if (active) return store.graph().status();
    const index = store.graph();
    if (index.state === 'ready') return index.status();
    const task = { controller: new AbortController(), promise: null };
    const shouldPause = () => this.disposed || [...this.ctx.agents.list()].some(agent =>
      agent.status === 'running' && this.bindingAt(agent.session.header.cwd)?.space === store.name);
    const job = index.sync({ signal: task.controller.signal, shouldPause });
    task.promise = job;
    this.graphTasks.set(store.name, task);
    this.jobs.add(job);
    const finish = error => {
      if (this.graphTasks.get(store.name) === task) this.graphTasks.delete(store.name);
      this.jobs.delete(job);
      if (error && error.code !== 'GRAPH_PAUSED' && !this.disposed)
        this.noteError(error.code ?? 'GRAPH_INDEX_FAILED', '后台图谱建立未完成，可在图谱页重试或重建。',
          { operation: 'graph', space: store.name });
    };
    job.then(() => finish(), error => finish(error));
    return index.status();
  }
  async requestGraphSuggestions(store, options) {
    requireValue(this.config.embeddingMode !== 'off', 'SEMANTIC_DISABLED',
      '标准组合没有本地语义候选；请先选择并准备本地语义组合。', 409);
    requireValue(this.embedding.state.ready && this.embedding.pack, 'SEMANTIC_NOT_PREPARED',
      '请先完成当前空间的本地语义索引准备。', 409);
    const shouldPause = () => this.disposed || [...this.ctx.agents.list()].some(agent =>
      agent.status === 'running' && this.bindingAt(agent.session.header.cwd)?.space === store.name);
    requireValue(!shouldPause(), 'CONVERSATION_BUSY', '当前空间正在生成回复，请空闲后再查找语义候选。', 409);
    this.graphSuggestionTasks.get(store.name)?.controller.abort();
    const task = { controller: new AbortController() };
    const key = this.embedding.key, index = store.semanticIndex, pack = this.embedding.pack;
    this.graphSuggestionTasks.set(store.name, task);
    const job = graphSemanticSuggestions(store, index, pack, options, ADMIN, {
      signal: task.controller.signal, shouldPause,
      validateModel: () => !this.disposed && this.embedding.key === key &&
        this.embedding.state.ready && store.semanticIndex === index,
    });
    this.jobs.add(job);
    try { return await job; }
    finally {
      this.jobs.delete(job);
      if (this.graphSuggestionTasks.get(store.name) === task) this.graphSuggestionTasks.delete(store.name);
    }
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
    requireValue(!containsCredential(query) && !contextQueries.some(containsCredential),
      'SENSITIVE_QUERY_EXCLUDED', '查询可能包含凭据，未检索或记录。', 403);
    store.recallScope(actor, options);
    const mode = this.config.embeddingMode;
    const key = this.semanticKey(store, query, contextQueries);
    if (mode === 'off') return { key, resultKey: this.semanticResultKey(store, actor, query, contextQueries, options),
      generation: store.generation, expiresAt: null, hits: [], status: { mode, state: 'disabled' } };
    if (actor?.privateSession) return { key, resultKey: this.semanticResultKey(store, actor, query, contextQueries, options),
      generation: store.generation, expiresAt: null, hits: [], status: { mode, state: 'privacy-lexical',
        code: 'PRIVATE_QUERY_EXCLUDED', message: '私人历史会话不向语义模型发送查询。' } };
    if (store.exactIdentifierRecords(query, actor, options).length) {
      const scope = store.recallScope(actor, options);
      return { key, resultKey: this.semanticResultKey(store, actor, query, contextQueries, options),
        generation: store.generation,
        expiresAt: (options.mode ?? 'current') === 'current' ? store.nextEligibilityChange(scope.statuses, scope.now) : null,
        hits: [], status: { mode, state: 'exact', code: 'EXACT_IDENTIFIER',
          message: '找到精确标识符，本次未等待本地语义模型；匹配不等于事实验证。' } };
    }
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
  privateSessionRegistry() {
    this.privateSessions ??= new PrivateSessionRegistry(this.root);
    return this.privateSessions;
  }
  privateMainFor(agent) {
    if (!agent?.session || this.ctx.agents.get(agent.id) !== agent) return null;
    const binding = this.bindingAt(agent.session.header.cwd);
    if (!binding) return null;
    const main = this.config.privateMainSessions.find(item =>
      item.space === binding.space && item.sessionId === agent.session.id);
    return main ? { ...main, binding } : null;
  }
  hasPrivateHistory(session) {
    requireValue(typeof session.snapshotEvents === 'function', 'PRIVATE_LINEAGE_UNAVAILABLE',
      '无法核验会话历史；普通捕获和模型请求已暂停。', 503);
    const events = session.snapshotEvents();
    requireValue(Array.isArray(events), 'PRIVATE_LINEAGE_UNAVAILABLE',
      '会话历史格式无效；普通捕获和模型请求已暂停。', 503);
    return this.eventsContainPrivateHistory(events);
  }
  eventsContainPrivateHistory(events) {
    return events.some(event => {
      const source = event.type === 'user/message' ? event.data?.source :
        event.type === 'assistant/message' ? event.data?.message?.source : null;
      return source?.kind === 'runtime-context' &&
        source.sections?.some(section => section.name === 'tidal-private-journal');
    });
  }
  historyMainFor(agent) {
    if (!agent?.session || this.ctx.agents.get(agent.id) !== agent) return null;
    const binding = this.bindingAt(agent.session.header.cwd);
    if (!binding) return null;
    const main = this.config.historyMainSessions.find(item =>
      item.space === binding.space && item.sessionId === agent.session.id);
    return main ? { ...main, binding } : null;
  }
  requireHistoryMain(agent, binding) {
    requireValue(this.config.historyReadEnabled, 'HISTORY_READ_DISABLED',
      '历史查证默认关闭；请先在此工作区的设置中显式启用。', 403);
    const selection = this.historyMainFor(agent);
    requireValue(selection && selection.binding.space === binding.space &&
      canonicalCwd(selection.binding.cwd) === canonicalCwd(binding.cwd),
    'HISTORY_MAIN_UNAUTHORIZED', '仅当前工作区配置的主会话可以查证原始历史。', 403);
    requireValue(!this.privateSessionBlock(agent) && !this.privateSessionRegistry().get(agent.id),
      'PRIVATE_SESSION_UNAUTHORIZED', '私人或继承私人历史的会话不能读取普通历史。', 403);
    const route = agent.session.requestContext?.();
    requireValue(route?.provider === selection.provider && route?.model === selection.model,
      'HISTORY_ROUTE_UNAUTHORIZED', '当前 Provider / Model 与历史查证授权不匹配。', 403);
    return selection;
  }
  historyMessage(event) {
    const message = event.type === 'user/message' ? event.data :
      event.type === 'assistant/message' ? event.data?.message : null;
    if (!message || message.source?.kind === 'runtime-context' ||
        event.type === 'user/message' && (message.role !== 'user' || message.source?.kind !== 'user') ||
        event.type === 'assistant/message' && (message.role !== 'assistant' || event.data?.interrupted)) return null;
    const text = textOf(message).trim();
    return text && !containsCredential(text) ? text : null;
  }
  async findWorkspaceHistory(agent, { sessionIds, query = '', date } = {}) {
    this.syncConfig();
    const { store, space } = this.forAgent(agent);
    const binding = this.bindingAt(agent.session.header.cwd);
    const selection = this.requireHistoryMain(agent, binding);
    requireValue(Array.isArray(sessionIds) && sessionIds.length >= 1 && sessionIds.length <= MAX_HISTORY_SESSIONS &&
      sessionIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:@-]{1,256}$/.test(id)) &&
      new Set(sessionIds).size === sessionIds.length,
    'INVALID_HISTORY_SCOPE', '请指定 1–3 个不重复的完整会话 ID。');
    const search = string(query, '历史查询词', 500, true);
    requireValue(!containsCredential(search), 'SENSITIVE_CONTENT_SKIPPED', '查询看起来包含凭据；未读取历史。', 403);
    let day = null;
    if (date !== undefined && date !== null && date !== '') {
      requireValue(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date,
      'INVALID_DATE', '历史查证日期须为 YYYY-MM-DD。');
      day = date;
    }
    requireValue(search || day, 'INVALID_HISTORY_QUERY', '请提供查询词或日期。');
    const lineageId = store.lineageId;
    const forgetVersion = store.forgetVersion();
    const verifyForgetState = () => requireValue(
      store.lineageId === lineageId && store.forgetVersion() === forgetVersion,
      'HISTORY_FORGET_STATE_CHANGED', '查证期间遗忘状态发生变化，未返回历史内容；请重试。', 409);
    requireValue(!store.forgetLedger.hasUnknownEventCoverage(lineageId),
      'FORGET_SOURCE_COVERAGE_UNKNOWN', '旧遗忘标记缺少来源事件锚点，无法安全检查历史；请先核对并补齐来源覆盖状态。', 409);
    const signal = AbortSignal.timeout(30_000);
    const catalog = await this.workspaceSessionSnapshot(space, signal);
    verifyForgetState();
    const headers = sessionIds.map(id => catalog.headers.get(id));
    requireValue(headers.every(Boolean), 'HISTORY_SESSION_OUT_OF_SCOPE',
      '所选会话不在此工作区的当前会话目录中；未读取历史。', 403);
    const queryTerms = terms(search, 32).map(value => value.toLocaleLowerCase());
    const registry = this.privateSessionRegistry();
    const privateVersion = registry.version();
    const windows = [];
    let bytes = 0, loadedCount = 0, ignoredSensitive = 0, forgottenEvents = 0;
    for (let index = 0; index < sessionIds.length && windows.length < MAX_HISTORY_WINDOWS; index++) {
      const sessionId = sessionIds[index], header = headers[index];
      requireValue(!registry.get(sessionId), 'PRIVATE_HISTORY_EXCLUDED',
        '所选会话已登记为私人或继承历史；未读取其内容。', 403);
      let parentId = header.parentSession;
      const ancestors = new Set([sessionId]);
      for (let depth = 0; parentId && depth < 32; depth++) {
        requireValue(!ancestors.has(parentId), 'INVALID_HISTORY_LINEAGE',
          '会话继承链无效；未读取历史。', 403);
        ancestors.add(parentId);
        const parent = catalog.headers.get(parentId);
        requireValue(parent, 'HISTORY_LINEAGE_UNAVAILABLE',
          '无法核验所选会话的完整继承链；未读取历史。', 403);
        if (registry.get(parentId))
          throw new MemoryError('PRIVATE_HISTORY_EXCLUDED', '所选会话的父会话包含私人历史；未读取其内容。', 403);
        parentId = parent.parentSession;
      }
      requireValue(!parentId, 'INVALID_HISTORY_LINEAGE', '会话继承链过深；未读取历史。', 403);
      signal.throwIfAborted();
      const { query: sessionQuery } = catalog;
      requireValue(typeof sessionQuery.readSession === 'function', 'SESSION_HISTORY_UNAVAILABLE',
        '宿主未提供历史读取服务；未读取会话正文。', 503);
      let loaded;
      try { loaded = await sessionQuery.readSession(sessionId); }
      catch { throw new MemoryError('SESSION_HISTORY_READ_FAILED', '读取所选工作区会话失败；未返回历史内容。', 503); }
      signal.throwIfAborted();
      verifyForgetState();
      this.syncConfig();
      const currentBinding = this.bindingIn(space);
      const currentSelection = this.config.historyMainSessions.find(item => item.space === space);
      const currentRoute = agent.session.requestContext?.();
      requireValue(sameBinding(currentBinding, binding) &&
        this.config.historyReadEnabled && currentSelection?.sessionId === selection.sessionId &&
        currentSelection.provider === selection.provider && currentSelection.model === selection.model &&
        currentRoute?.provider === selection.provider && currentRoute?.model === selection.model,
      'HISTORY_AUTHORIZATION_CHANGED', '读取期间工作区绑定、模型路由或授权发生变化；未返回历史内容。', 409);
      requireValue(loaded?.session?.id === sessionId && typeof loaded.session.cwd === 'string' &&
        canonicalCwd(loaded.session.cwd) === canonicalCwd(binding.cwd) && Array.isArray(loaded.events),
      'HISTORY_SESSION_CHANGED', '宿主返回的历史会话身份或工作区不匹配；未返回内容。', 409);
      if (this.eventsContainPrivateHistory(loaded.events)) {
        const owner = registry.get(sessionId) ??
          (header.parentSession ? registry.get(header.parentSession) : null);
        registry.markInherited({ sessionId, space, lineageId: owner?.lineage_id ?? lineageId, now: this.clock().toISOString() });
        throw new MemoryError('PRIVATE_HISTORY_EXCLUDED',
          '所选历史包含私人日记上下文，已登记隔离且未返回内容。', 403);
      }
      requireValue(!registry.get(sessionId) && privateVersion === registry.version(),
        'PRIVATE_REGISTRY_CHANGED', '读取期间私人历史隔离状态发生变化；未返回内容。', 409);
      const timeline = [];
      for (const event of loaded.events) {
        if (!['user/message', 'assistant/message'].includes(event?.type)) continue;
        const text = this.historyMessage(event);
        if (!text) {
          if (containsCredential(textOf(event?.data?.message ?? event?.data ?? {}))) ignoredSensitive++;
          timeline.push(null);
          continue;
        }
        const at = Date.parse(event.time);
        if (!Number.isFinite(at) || day && localDateKey(new Date(at)) !== day ||
            !Number.isSafeInteger(event.seq)) {
          timeline.push(null);
          continue;
        }
        if (store.forgetLedger.hasEvent(lineageId, sessionId, event.seq)) {
          forgottenEvents++;
          timeline.push(null);
          continue;
        }
        const normalized = text.toLocaleLowerCase();
        const matches = !search || queryTerms.length > 0 &&
          (normalized.includes(search.toLocaleLowerCase()) || queryTerms.some(term => normalized.includes(term)));
        timeline.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant',
          at: new Date(at).toISOString(), text, matches });
      }
      loadedCount++;
      for (let hit = 0; hit < timeline.length && windows.length < MAX_HISTORY_WINDOWS; hit++) {
        if (!timeline[hit]?.matches) continue;
        let start = hit, end = hit + 1;
        const radius = Math.floor(MAX_HISTORY_WINDOW_EVENTS / 2);
        while (start > 0 && hit - start < radius && timeline[start - 1]) start--;
        while (end < timeline.length && end - hit <= radius && timeline[end]) end++;
        if (windows.some(window => window.sessionId === sessionId && window.fromSeq <= timeline[hit].seq &&
            window.untilSeq >= timeline[hit].seq)) continue;
        const candidate = { sessionId, events: timeline.slice(start, end).map(event => ({ ...event })) };
        const hitSeq = timeline[hit].seq;
        while (candidate.events.length) {
          candidate.fromSeq = candidate.events[0].seq;
          candidate.untilSeq = candidate.events.at(-1).seq;
          if (bytes + Buffer.byteLength(JSON.stringify(candidate)) <= MAX_HISTORY_WINDOW_BYTES) break;
          const hitIndex = candidate.events.findIndex(event => event.seq === hitSeq);
          const leftContext = hitIndex;
          const rightContext = candidate.events.length - hitIndex - 1;
          if (leftContext > rightContext) candidate.events.shift();
          else if (rightContext > 0) candidate.events.pop();
          else {
            candidate.events = [];
            break;
          }
        }
        if (!candidate.events.length) continue;
        bytes += Buffer.byteLength(JSON.stringify(candidate));
        windows.push(candidate);
      }
    }
    signal.throwIfAborted();
    requireValue(registry.version() === privateVersion, 'PRIVATE_REGISTRY_CHANGED',
      '读取期间私人历史隔离状态发生变化；未返回内容。', 409);
    this.syncConfig();
    requireValue(this.config.historyReadEnabled &&
      this.config.historyMainSessions.some(item => item.space === space &&
        item.sessionId === selection.sessionId && item.provider === selection.provider && item.model === selection.model) &&
      sameBinding(this.bindingIn(space), binding),
    'HISTORY_AUTHORIZATION_CHANGED', '返回历史前授权或工作区发生变化；未返回内容。', 409);
    const result = { space, sessionsChecked: loadedCount, windows, bytes: 0, ignoredSensitive, forgottenEvents,
      coverage: '只搜索指定会话中可读的用户/助手文本；未检查其他会话、私人会话、工具输出或未覆盖历史。未命中不证明事件未发生。' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const size = Buffer.byteLength(JSON.stringify(result));
      if (size === result.bytes) break;
      result.bytes = size;
    }
    requireValue(result.bytes <= MAX_HISTORY_BYTES, 'HISTORY_RESULT_TOO_LARGE',
      '历史查证结果超过输出上限，未返回内容。', 413);
    verifyForgetState();
    return result;
  }
  async previewHistoryImport(store, { sessionIds, query = '', date } = {}) {
    const space = store.name;
    const binding = this.bindingIn(space);
    requireValue(binding, 'UNBOUND_WORKSPACE', '请先绑定此工作区，再预览历史补录。', 409);
    requireValue(Array.isArray(sessionIds) && sessionIds.length >= 1 && sessionIds.length <= MAX_HISTORY_SESSIONS &&
      sessionIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:@-]{1,256}$/.test(id)) &&
      new Set(sessionIds).size === sessionIds.length,
    'INVALID_HISTORY_SCOPE', '请指定 1–3 个不重复的完整会话 ID。');
    const search = string(query, '历史查询词', 500, true);
    requireValue(!containsCredential(search), 'SENSITIVE_CONTENT_SKIPPED', '查询看起来包含凭据；未读取历史。', 403);
    let day = null;
    if (date !== undefined && date !== null && date !== '') {
      requireValue(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date,
      'INVALID_DATE', '历史补录日期须为 YYYY-MM-DD。');
      day = date;
    }
    requireValue(search || day, 'INVALID_HISTORY_QUERY', '请提供查询词或日期。');
    requireValue(!store.forgetLedger.hasUnknownEventCoverage(store.lineageId),
      'FORGET_SOURCE_COVERAGE_UNKNOWN', '旧遗忘标记缺少来源事件锚点，无法安全预览历史补录。', 409);
    for (const [id, plan] of this.plans)
      if (plan.expires < this.clock().getTime()) this.plans.delete(id);
    requireValue(this.plans.size < 5, 'TOO_MANY_PREVIEWS', '尚有预览待处理，请完成或等待过期。', 429);

    const signal = AbortSignal.timeout(30_000);
    const catalog = await this.workspaceSessionSnapshot(space, signal);
    const headers = sessionIds.map(id => catalog.headers.get(id));
    requireValue(headers.every(Boolean), 'HISTORY_SESSION_OUT_OF_SCOPE',
      '所选会话不在此工作区的当前会话目录中；未读取历史。', 403);
    const registry = this.privateSessionRegistry();
    const privateVersion = registry.version();
    const forgetVersion = store.forgetVersion();
    const lineageId = store.lineageId;
    const candidates = [], eventVersions = new Map(), existing = new Set(
      store.all().map(record => record.dedupeKey));
    let sessionsChecked = 0, ignoredSensitive = 0, forgottenEvents = 0, skippedUnclassified = 0,
      skippedTooLong = 0, truncated = false;
    const queryTerms = terms(search, 32).map(value => value.toLocaleLowerCase());
    scan: for (let index = 0; index < sessionIds.length; index++) {
      const sessionId = sessionIds[index], header = headers[index];
      requireValue(!registry.get(sessionId), 'PRIVATE_HISTORY_EXCLUDED',
        '所选会话已登记为私人或继承历史；未读取其内容。', 403);
      let parentId = header.parentSession;
      const ancestors = new Set([sessionId]);
      for (let depth = 0; parentId && depth < 32; depth++) {
        requireValue(!ancestors.has(parentId), 'INVALID_HISTORY_LINEAGE',
          '会话继承链无效；未读取历史。', 403);
        ancestors.add(parentId);
        const parent = catalog.headers.get(parentId);
        requireValue(parent, 'HISTORY_LINEAGE_UNAVAILABLE',
          '无法核验所选会话的完整继承链；未生成预览。', 403);
        requireValue(!registry.get(parentId), 'PRIVATE_HISTORY_EXCLUDED',
          '所选会话继承了私人历史；未读取其内容。', 403);
        parentId = parent.parentSession;
      }
      requireValue(!parentId, 'INVALID_HISTORY_LINEAGE', '会话继承链过深；未读取历史。', 403);
      signal.throwIfAborted();
      let loaded;
      try { loaded = await catalog.query.readSession(sessionId); }
      catch { throw new MemoryError('SESSION_HISTORY_READ_FAILED', '读取所选工作区会话失败；未生成预览。', 503); }
      signal.throwIfAborted();
      this.syncConfig();
      requireValue(sameBinding(this.bindingIn(space), binding) && store.lineageId === lineageId &&
        store.forgetVersion() === forgetVersion && registry.version() === privateVersion,
      'HISTORY_PREVIEW_SCOPE_CHANGED', '读取期间工作区、谱系、遗忘或私人隔离状态发生变化；未生成预览。', 409);
      requireValue(loaded?.session?.id === sessionId && canonicalCwd(loaded.session.cwd) === canonicalCwd(binding.cwd) &&
        Array.isArray(loaded.events), 'HISTORY_SESSION_CHANGED', '宿主返回的历史会话身份或工作区不匹配；未生成预览。', 409);
      if (this.eventsContainPrivateHistory(loaded.events)) {
        registry.markInherited({ sessionId, space, lineageId, now: this.clock().toISOString() });
        throw new MemoryError('PRIVATE_HISTORY_EXCLUDED',
          '所选历史包含私人日记上下文，已登记隔离且未生成预览。', 403);
      }
      requireValue(!registry.get(sessionId) && registry.version() === privateVersion,
        'PRIVATE_REGISTRY_CHANGED', '读取期间私人历史隔离状态发生变化；未生成预览。', 409);
      sessionsChecked++;
      for (const event of loaded.events) {
        if (event?.type !== 'user/message' || event.data?.role !== 'user' ||
            event.data?.source?.kind !== 'user' || !Number.isSafeInteger(event.seq)) continue;
        const text = this.historyMessage(event);
        if (!text) {
          if (containsCredential(textOf(event.data))) ignoredSensitive++;
          continue;
        }
        const at = Date.parse(event.time);
        if (!Number.isFinite(at) || day && localDateKey(new Date(at)) !== day) continue;
        if (store.forgetLedger.hasEvent(lineageId, sessionId, event.seq)) {
          forgottenEvents++;
          continue;
        }
        const normalized = text.toLocaleLowerCase();
        if (search && !normalized.includes(search.toLocaleLowerCase()) &&
            !queryTerms.some(term => normalized.includes(term))) continue;
        const encoded = localCandidates(text);
        if (!encoded.length) { skippedUnclassified++; continue; }
        if (encoded.some(item => item.text.length > 2000)) { skippedTooLong++; continue; }
        const version = hash(JSON.stringify([event.type, event.seq, event.time, text]));
        eventVersions.set(`${sessionId}:${event.seq}`, { sessionId, seq: event.seq, version });
        for (const item of encoded) {
          if (candidates.length === MAX_HISTORY_IMPORT_CANDIDATES) {
            truncated = true;
            break scan;
          }
          const record = {
            layer: item.layer === 'L1' ? 'L1' : 'L2',
            text: item.text, category: item.category, kind: 'historical', status: 'candidate',
            horizon: item.layer === 'L1' ? 'task' : 'event', scope: 'space', sessionId: '',
            occurredAt: new Date(at).toISOString(),
            ...(item.taskKey ? { taskKey: item.taskKey } : {}),
            source: { kind: 'session', sessionId, eventId: String(event.seq), role: 'user',
              at: new Date(at).toISOString(), historicalImport: true },
          };
          const normalizedRecord = normalizeRecord(record, store.now());
          const exists = existing.has(normalizedRecord.dedupeKey);
          candidates.push({ importId: hash(JSON.stringify([lineageId, sessionId, event.seq, item.rule, item.text])),
            sessionId, eventSeq: event.seq, at: new Date(at).toISOString(), rule: item.rule,
            layer: record.layer, category: record.category, status: exists ? 'already-exists' : 'new',
            text: item.text, record: { ...record, dedupeKey: normalizedRecord.dedupeKey } });
        }
      }
    }
    requireValue(registry.version() === privateVersion &&
      store.forgetVersion() === forgetVersion && store.lineageId === lineageId,
    'HISTORY_PREVIEW_SCOPE_CHANGED', '预览期间来源权限或遗忘状态发生变化；未生成预览。', 409);
    const id = truncated || !candidates.length ? null : randomUUID();
    const expires = id ? this.clock().getTime() + 20 * 60_000 : null;
    if (id) {
      requireValue(this.plans.size < 5, 'TOO_MANY_PREVIEWS', '尚有预览待处理，请完成或等待过期。', 429);
      this.plans.set(id, { id, kind: 'history', space, bindingCwd: binding.cwd, workspaceId: binding.workspaceId, lineageId, forgetVersion,
        privateVersion, sessionIds, eventVersions: [...eventVersions.values()], candidates, expires });
    }
    return { id, sessionsChecked, candidates: candidates.map(({ record, ...item }) => item),
      candidateCount: candidates.length, truncated, ignoredSensitive,
      forgottenEvents, skippedUnclassified, skippedTooLong, expiresAt: expires === null ? null : new Date(expires).toISOString(),
      coverage: '只预览所选会话中匹配查询词或日期的可分类普通用户陈述；未读取私人内容、助手陈述、工具输出或其他历史。候选均为待核，批量补录不会写入 L3。' };
  }
  async applyHistoryImport(store, plan, selected) {
    requireValue(plan?.kind === 'history' && plan.expires >= this.clock().getTime() &&
      plan.space === store.name && plan.lineageId === store.lineageId &&
      plan.forgetVersion === store.forgetVersion() &&
      !store.forgetLedger.hasUnknownEventCoverage(store.lineageId),
    'PREVIEW_EXPIRED', '历史补录预览已过期，或遗忘状态已变化；请重新预览。', 409);
    requireValue(Array.isArray(selected) && selected.length > 0 && selected.length <= plan.candidates.length,
      'INVALID_SELECTION', '补录选择无效。');
    const ids = new Set(selected);
    requireValue(ids.size === selected.length && selected.every(id =>
      plan.candidates.some(candidate => candidate.importId === id)),
    'INVALID_SELECTION', '候选已变化，请重新预览。');
    const binding = this.bindingIn(plan.space);
    requireValue(sameBinding(binding, { cwd: plan.bindingCwd, workspaceId: plan.workspaceId }),
      'HISTORY_PREVIEW_SCOPE_CHANGED', '工作区绑定已变化；请重新预览。', 409);
    const registry = this.privateSessionRegistry();
    requireValue(registry.version() === plan.privateVersion &&
      plan.sessionIds.every(sessionId => !registry.get(sessionId)),
    'PRIVATE_REGISTRY_CHANGED', '私人历史隔离状态已变化；请重新预览。', 409);
    const signal = AbortSignal.timeout(30_000);
    const catalog = await this.workspaceSessionSnapshot(plan.space, signal);
    const headers = plan.sessionIds.map(id => catalog.headers.get(id));
    requireValue(headers.every(Boolean), 'HISTORY_SESSION_OUT_OF_SCOPE',
      '原会话已不在此工作区；请重新预览。', 409);
    const loadedById = new Map();
    for (const sessionId of plan.sessionIds) {
      requireValue(!registry.get(sessionId), 'PRIVATE_HISTORY_EXCLUDED',
        '所选会话已登记为私人历史；未补录。', 403);
      let parentId = catalog.headers.get(sessionId)?.parentSession;
      const ancestors = new Set([sessionId]);
      for (let depth = 0; parentId && depth < 32; depth++) {
        requireValue(!ancestors.has(parentId), 'INVALID_HISTORY_LINEAGE',
          '会话继承链无效；未补录。', 403);
        const parent = catalog.headers.get(parentId);
        requireValue(parent, 'HISTORY_LINEAGE_UNAVAILABLE',
          '无法核验所选会话的完整继承链；未补录。', 403);
        requireValue(!registry.get(parentId), 'PRIVATE_HISTORY_EXCLUDED',
          '所选会话继承了私人历史；未补录。', 403);
        ancestors.add(parentId);
        parentId = parent.parentSession;
      }
      requireValue(!parentId, 'INVALID_HISTORY_LINEAGE', '会话继承链无效；未补录。', 403);
      let loaded;
      try { loaded = await catalog.query.readSession(sessionId); }
      catch { throw new MemoryError('SESSION_HISTORY_READ_FAILED', '重新核对来源失败；未补录。', 503); }
      signal.throwIfAborted();
      requireValue(loaded?.session?.id === sessionId &&
        canonicalCwd(loaded.session.cwd) === canonicalCwd(plan.bindingCwd) && Array.isArray(loaded.events),
      'HISTORY_SESSION_CHANGED', '历史会话身份或工作区已变化；请重新预览。', 409);
      if (this.eventsContainPrivateHistory(loaded.events)) {
        registry.markInherited({ sessionId, space: plan.space, lineageId: plan.lineageId,
          now: this.clock().toISOString() });
        throw new MemoryError('PRIVATE_HISTORY_EXCLUDED', '来源包含私人历史，未补录。', 403);
      }
      loadedById.set(sessionId, loaded);
    }
    this.syncConfig();
    requireValue(sameBinding(this.bindingIn(plan.space), binding) && registry.version() === plan.privateVersion &&
      store.lineageId === plan.lineageId && store.forgetVersion() === plan.forgetVersion,
    'HISTORY_PREVIEW_SCOPE_CHANGED', '重新核对期间授权、谱系、工作区或遗忘状态变化；未补录。', 409);
    for (const anchor of plan.eventVersions) {
      const loaded = loadedById.get(anchor.sessionId);
      const event = loaded?.events.find(item => item.seq === anchor.seq);
      const text = event ? this.historyMessage(event) : null;
      const version = event && text ? hash(JSON.stringify([event.type, event.seq, event.time, text])) : null;
      requireValue(version === anchor.version, 'HISTORY_SOURCE_CHANGED',
        '预览后的来源事件已变化或不可读取；请重新预览。', 409);
      requireValue(!store.forgetLedger.hasEvent(plan.lineageId, anchor.sessionId, anchor.seq),
        'FORGOTTEN', '来源事件已明确遗忘，不能补录。', 409);
    }
    const chosen = plan.candidates.filter(candidate => ids.has(candidate.importId));
    requireValue(this.plans.get(plan.id) === plan && plan.expires >= this.clock().getTime(),
      'PREVIEW_EXPIRED', '历史补录预览已过期或已提交，请重新预览。', 409);
    const selection = JSON.stringify(chosen.map(candidate => candidate.importId));
    requireValue(!plan.selection || plan.selection === selection, 'INVALID_SELECTION',
      '部分提交后须按原勾选重试；需要修改时请重新预览。', 409);
    plan.selection = selection;
    let imported = 0, existing = 0;
    try {
      for (const candidate of chosen) {
        requireValue(!store.forgetLedger.hasEvent(plan.lineageId, candidate.sessionId, candidate.eventSeq),
          'FORGOTTEN', '来源事件已明确遗忘，不能补录。', 409);
        const previous = store.db(candidate.record.layer).prepare('SELECT id FROM memories WHERE dedupe_key=?')
          .get(candidate.record.dedupeKey);
        store.create(candidate.record, ADMIN);
        if (previous) existing++;
        else imported++;
      }
    } catch (error) {
      if (!imported && !existing) throw error;
      throw new MemoryError('HISTORY_IMPORT_PARTIAL',
        `历史补录中断：新增 ${imported} 条，已存在 ${existing} 条；已完成部分保留，使用同一预览重试可幂等续办。` +
        (error instanceof MemoryError ? error.message : '请检查数据目录后重试。'), error?.status ?? 500);
    } finally {
      this.invalidateSpace(plan.space);
    }
    this.plans.delete(plan.id);
    return { imported, existing, selected: chosen.length,
      status: '所选历史已作为待核候选补录；不会自动成为 L3 长期知识或已验证事实。' };
  }
  privateSessionBlock(agent) {
    const session = agent?.session;
    if (!session || this.ctx.agents.get(agent.id) !== agent) return null;
    const binding = this.bindingAt(session.header.cwd);
    const registry = this.privateSessionRegistry();
    const row = registry.get(session.id);
    const parent = session.header.parentSession ? registry.get(session.header.parentSession) : null;
    if ((parent && row?.state !== 'inherited') || (!row && this.hasPrivateHistory(session))) {
      registry.markInherited({
        sessionId: session.id, space: binding?.space ?? parent?.space ?? 'unbound',
        lineageId: parent?.lineage_id ?? (binding ? this.space(binding.space).lineageId : 'unknown'),
        now: this.clock().toISOString(),
      });
    }
    const state = registry.get(session.id);
    if (state?.state === 'inherited') return '该会话继承了私人日记历史，已在模型请求前阻止；请使用干净会话。';
    if (state?.state === 'exposed') {
      const main = this.privateMainFor(agent);
      const route = session.requestContext?.();
      if (!main || !binding || state.space !== binding.space ||
          state.lineage_id !== this.space(binding.space).lineageId ||
          state.provider !== main.provider || state.model !== main.model ||
          route?.provider !== main.provider || route?.model !== main.model ||
          !this.privateAgentDisposers.has(agent.id))
        return '此会话曾接收私人日记上下文，当前不再满足主会话授权；模型请求已阻止。';
    }
    return null;
  }
  privateContext({ agent }) {
    this.privateCandidates.delete(agent?.id);
    try {
      this.syncConfig();
      if (!this.config.enabled || !this.config.injectContext || !this.privateAgentDisposers.has(agent?.id)) return '';
      const main = this.privateMainFor(agent);
      if (!main) return '';
      if (this.privateSessionBlock(agent)) return '';
      if (!main || this.privateSessionRegistry().get(agent.id)?.state === 'inherited') return '';
      const store = this.space(main.space);
      const candidate = store.privateJournalContext({
        sessionId: agent.id, provider: main.provider, model: main.model,
        now: this.clock(), maxBytes: this.config.privateContextBudget,
      });
      if (!candidate) return '';
      this.privateCandidates.set(agent.id, { space: main.space, receipt: candidate.receipt });
      return candidate.text;
    } catch (error) {
      this.noteError(error.code ?? 'PRIVATE_CONTEXT_FAILED',
        '私人日记回顾上下文未能安全准备；未向模型发送。');
      return '';
    }
  }
  attachPrivateAgent(agent) {
    if (!agent?.ctx?.on || this.privateAgentDisposers.has(agent.id)) return;
    const dispose = agent.ctx.on('agent/request', async (payload, next) => {
      const config = await next();
      const candidate = this.privateCandidates.get(agent.id);
      const state = this.privateSessionRegistry().get(agent.id);
      if (!candidate && state?.state !== 'exposed') return config;
      const main = this.privateMainFor(agent);
      requireValue(state?.state !== 'inherited' && (state?.state !== 'exposed' || !this.privateSessionBlock(agent)) && main &&
        config.provider === main.provider && config.model === main.model,
      'PRIVATE_ROUTE_UNAUTHORIZED', '私人日记主会话或模型路由未获授权，已在模型请求前阻止。', 403);
      this.privateSessionRegistry().markExposed({
        sessionId: agent.id, space: main.space, lineageId: this.space(main.space).lineageId,
        provider: main.provider, model: main.model, now: this.clock().toISOString(),
      });
      this.space(main.space).reconcileForgetLedger();
      if (state?.state !== 'exposed') this.sessions.delete(agent.id);
      this.privateCandidates.delete(agent.id);
      if (candidate) this.pendingPrivateObservations.set(agent.id, {
        ...candidate.receipt, turn: payload.turn, step: payload.step,
      });
      return config;
    });
    this.privateAgentDisposers.set(agent.id, dispose);
  }
  privateContribution(agent, content, operationId) {
    this.syncConfig();
    requireValue(this.config.privateContributionsEnabled, 'PRIVATE_CONTRIBUTIONS_DISABLED',
      '用户尚未启用同工作区会话私人贡献。', 403);
    requireValue(this.ctx.agents.get(agent?.id) === agent && !this.privateSessionBlock(agent),
      'PRIVATE_SESSION_UNAUTHORIZED', '当前会话不能提交私人日记贡献。', 403);
    const binding = this.bindingAt(agent.session.header.cwd);
    requireValue(binding, 'UNBOUND_WORKSPACE', '私人贡献仅限已绑定工作区。', 403);
    const store = this.space(binding.space);
    const result = store.appendPrivateFromSession(agent.id, content, operationId);
    return { saved: true, id: result.id, day: result.day_key, revision: result.revision };
  }
  organizePrivateForAgent(agent, input) {
    this.syncConfig();
    const main = this.privateMainFor(agent);
    requireValue(main && this.privateAgentDisposers.has(agent.id) &&
      this.privateSessionRegistry().get(agent.id)?.state === 'exposed',
    'PRIVATE_SESSION_UNAUTHORIZED', '仅当前获授权的私人日记主会话可以整理日记。', 403);
    const route = agent.session.requestContext?.();
    requireValue(route?.provider === main.provider && route?.model === main.model,
      'PRIVATE_ROUTE_UNAUTHORIZED', '当前模型路由未获授权，不能整理私人日记。', 403);
    const store = this.space(main.space);
    const result = store.organizePrivateDay({ ...input, sessionId: agent.id,
      provider: main.provider, model: main.model, maxBytes: this.config.privateContextBudget });
    return { saved: result.saved, day: result.day, revision: result.revision, contentHash: result.contentHash };
  }
  async preStep({ agent, signal }, next) {
    try {
      this.syncConfig();
      if (this.privateSessionBlock(agent)) return { kind: 'reject' };
    } catch (error) {
      this.noteError(error.code ?? 'PRIVATE_GUARD_FAILED',
        '私人日记会话安全校验未能完成；模型请求已阻止。');
      return { kind: 'reject' };
    }
    const decision = await next();
    if (decision.kind === 'reject' || signal?.aborted || this.disposed) return decision;
    try {
      if (this.privateSessionBlock(agent)) return { kind: 'reject' };
    } catch (error) {
      this.noteError(error.code ?? 'PRIVATE_GUARD_FAILED', '私人日记会话安全校验未能完成；模型请求已阻止。');
      return { kind: 'reject' };
    }
    try {
      this.syncConfig();
      if (!this.config.enabled) return decision;
      this.cancelPrewarm();
      const binding = this.bindingAt(agent.session?.header.cwd);
      if (!binding) return decision;
      this.cancelGraphBuild(binding.space);
      const { actor } = this.forAgent(agent);
      const state = this.sessionState(agent.session, binding.space);
      // rc5 appends admitted user events after its final runtime-context refresh.
      const pending = decision.messages.filter(message =>
        message.role === 'user' && message.source?.kind !== 'runtime-context')
        .map(textOf).filter(text => text.trim());
      const sensitive = pending.some(containsCredential);
      state.pendingQueries = actor.privateSession || sensitive ? [] : pending.map(recallQuery);
      if (actor.privateSession || sensitive) {
        state.query = '';
        state.recent = [];
        state.evidenceId = undefined;
        state.pendingRecall = null;
        state.semantic = null;
      }
      state.context = null;
      if (this.config.injectContext && this.config.embeddingMode !== 'off' && !actor.privateSession && !sensitive) {
        const token = Symbol('semantic-request');
        state.semanticRequest = token;
        const { store, actor } = this.forAgent(agent);
        const { query, contextQueries } = this.queryWindow(state, store, actor);
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
    try {
      if (this.privateSessionBlock(agent)) return { kind: 'reject' };
    } catch (error) {
      this.noteError(error.code ?? 'PRIVATE_GUARD_FAILED', '私人日记会话安全校验未能完成；模型请求已阻止。');
      return { kind: 'reject' };
    }
    return decision;
  }
  onEvent(session, event) {
    if (this.disposed) return;
    try {
      this.syncConfig();
      if (!this.config.enabled || this.ctx.agents.get(session.id)?.session !== session) return;
      this.cancelPrewarm();
      const binding = this.bindingAt(session.header.cwd);
      if (!binding) return;
      this.cancelGraphBuild(binding.space);
      const agent = this.ctx.agents.get(session.id);
      const blocked = this.privateSessionBlock(agent);
      const privateSession = this.privateSessionRegistry().get(session.id);
      const state = this.sessionState(session, binding.space);
      state.space = binding.space;
      state.lastSeen = this.clock().getTime();
      this.lastActivity = state.lastSeen;
      this.workspaceActivity.set(binding.space, state.lastSeen);
      if (event.type === 'assistant/message') {
        const pending = this.pendingPrivateObservations.get(session.id);
        if (pending && pending.turn === event.data.turn && pending.step === event.data.step) {
          this.pendingPrivateObservations.delete(session.id);
          if (!event.data.interrupted) {
            const store = this.space(binding.space);
            if (!store.recordPrivateObservation(pending, new Date(event.time).toISOString()))
              this.noteError('PRIVATE_OBSERVATION_STALE', '私人日记回顾期间文件版本变化；本次回顾未登记。');
          }
        }
      }
      if (event.type === 'turn/start') { state.context = null; state.turn = event.data.turn; }
      if (event.type === 'turn/end') {
        state.pendingQueries = []; state.pendingRecall = null; state.context = null;
        this.privateCandidates.delete(session.id);
        this.pendingPrivateObservations.delete(session.id);
      }
      if (blocked || privateSession) {
        this.space(binding.space).reconcileForgetLedger();
        return;
      }
      const message = event.type === 'user/message' ? event.data :
        event.type === 'assistant/message' ? event.data.message : null;
      const user = event.type === 'user/message' && message?.role === 'user' && message.source?.kind === 'user';
      const assistant = event.type === 'assistant/message' && message?.role === 'assistant' && !event.data.interrupted;
      const text = user || assistant ? textOf(message) : '';
      if (!this.spaces.has(binding.space) && !user && !['tool/call', 'tool/result'].includes(event.type) &&
          !(assistant && this.config.autoCandidates && assistantClaim(text))) return;
      const store = this.space(binding.space);
      if (store.forgetLedger.hasEvent(store.lineageId, session.id, event.seq)) {
        store.eventCapture.process(session, event, binding, this.config);
        state.recent = (state.recent ?? []).filter(item => item.seq !== event.seq);
        if (state.evidenceId === event.seq) { state.query = ''; state.evidenceId = undefined; }
        state.pendingQueries = [];
        state.pendingRecall = null;
        state.semantic = null;
        state.context = null;
        return;
      }
      if (user && containsCredential(text)) {
        state.pendingQueries = [];
        state.query = '';
        state.recent = [];
        state.evidenceId = undefined;
        state.pendingRecall = null;
        state.semantic = null;
        state.context = null;
        this.noteError('SENSITIVE_CONTENT_SKIPPED', '消息可能包含凭据，未进入普通记忆或自动召回。');
      }
      if (user && text.trim() && !containsCredential(text)) {
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
      const captured = store.eventCapture.process(session, event, binding, this.config);
      if (captured.state === 'saved' || captured.state === 'review') this.invalidateSpace(binding.space);
      if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
        const pending = store.eventCapture.pending(session.id, event.data.callId);
        if (pending.length && typeof session.snapshotEvents === 'function') {
          const events = session.snapshotEvents();
          for (const seq of pending) {
            const result = events.find(item => item.seq === seq);
            if (result) {
              const retried = store.eventCapture.process(session, result, binding, this.config);
              if (retried.state === 'saved' || retried.state === 'review') this.invalidateSpace(binding.space);
            }
          }
        }
      }
    } catch (error) {
      this.noteError(error.code ?? 'CAPTURE_FAILED', '记忆捕获未完成，请在管理页检查。');
    }
  }
  retryLiveCaptures(store, { force = false } = {}) {
    store.reconcileForgetLedger();
    const rows = store.system.prepare(`SELECT r.session_id,r.event_seq,r.attempts,r.updated_at,r.state
      FROM capture_receipts r WHERE r.state IN ('pending','failed','waiting') AND r.attempts<5
      AND (r.state<>'waiting' OR EXISTS (SELECT 1 FROM capture_calls c
        WHERE c.session_id=r.session_id AND c.call_id=r.call_id))
      ORDER BY r.updated_at,r.session_id,r.event_seq LIMIT 20`).all();
    let retried = 0, unavailable = 0, failed = 0;
    for (const row of rows) {
      if (store.blockedSessionIds.has(row.session_id)) continue;
      const agent = this.ctx.agents.get(row.session_id);
      const binding = agent?.session && this.bindingAt(agent.session.header.cwd);
      if (!agent || binding?.space !== store.name || typeof agent.session.snapshotEvents !== 'function') {
        unavailable++;
        continue;
      }
      if (!force && this.clock().getTime() - Date.parse(row.updated_at) <
          Math.min(60_000, 1000 * 2 ** Math.max(0, row.attempts - 1))) continue;
      try {
        if (this.privateSessionBlock(agent) || this.privateSessionRegistry().get(agent.id)) continue;
        const event = agent.session.snapshotEvents().find(item => item.seq === row.event_seq);
        if (!event) { unavailable++; continue; }
        const result = store.eventCapture.process(agent.session, event, binding, this.config);
        if (result.state === 'saved' || result.state === 'review') this.invalidateSpace(store.name);
        retried++;
      } catch (error) {
        failed++;
        this.noteError(error.code ?? 'CAPTURE_RETRY_FAILED', '已登记事件重试失败，未读取其他会话。',
          { operation: 'capture', space: store.name });
      }
    }
    return { retried, unavailable, failed };
  }
  context({ agent }) {
    let selectedSpace;
    try {
      this.syncConfig();
      if (!this.config.enabled || !agent?.session) return '';
      if (!this.config.injectContext) return '';
      const binding = this.bindingAt(agent.session.header.cwd);
      if (!binding) return '';
      selectedSpace = binding.space;
      const { store, actor, space } = this.forAgent(agent);
      const state = this.sessionState(agent.session, space);
      state.space = space;
      for (let attempt = 0; attempt < 3; attempt++) {
        store.reconcileForgetLedger();
        const version = store.reconciledForgetVersion, privateVersion = store.reconciledPrivateVersion,
          observedAt = this.clock().getTime();
        if (state.context === null || state.generation !== store.generation ||
            (state.contextAt !== undefined && observedAt < state.contextAt) ||
            (state.contextExpiresAt !== null && state.contextExpiresAt !== undefined && observedAt >= state.contextExpiresAt)) {
          const { query, contextQueries, pending } = this.queryWindow(state, store, actor);
          const recalled = store.recall(query, actor, { contextQueries,
            ...this.cachedSemantic(store, actor, query, contextQueries, state),
            evidenceId: pending || state.evidenceId === undefined ? undefined : `user-event:${state.evidenceId}` });
          const incomplete = this.config.embeddingMode !== 'off' && !actor.privateSession &&
            !['ready', 'exact'].includes(recalled.semanticStatus?.state);
          state.context = recalled.text + (incomplete ? '\n[本地语义联想尚未完整就绪，召回可能遗漏；不要据此断言不存在相关历史。]' : '') +
            (actor.privateSession ? '\n[私人历史会话不会从混合历史自动提取或发送语义查询；普通记忆仅显示可用背景。]' : '');
          if (pending) state.pendingRecall = { query,
            ids: recalled.picked.filter(item => item.matched).map(item => item.id) };
          state.generation = store.generation;
          const scope = store.recallScope(actor);
          state.contextAt = Math.max(observedAt, scope.now);
          state.contextExpiresAt = store.nextEligibilityChange(scope.statuses, scope.now);
          if (this.lastError?.operation === 'recall' && this.lastError.space === space) this.lastError = null;
        }
        if (version === store.forgetVersion() && privateVersion === store.privateVersion()) return state.context;
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
          this.bindingAt(agent.session.header.cwd)?.space === name);
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
        const captureRetry = this.retryLiveCaptures(store);
        const localOrganization = store.organizePending();
        const consolidation = this.config.autoConsolidate ? store.consolidate() : { disabled: true };
        const maintenance = store.maintenance();
        this.invalidateSpace(name);
        const semanticPrewarm = this.requestPrewarm(store);
        const graphPreparation = this.config.graphRecall || store.graphIndex ?
          this.requestGraphBuild(store) : { state: 'disabled' };
        results.push({ space: name, ...maintenance, captureRetry, localOrganization, consolidation, semanticPrewarm, graphPreparation });
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
    this.observeWorkspaceDirectory();
    const job = this.checkDailyConsolidation().then(() => this.requestMaintenance());
    this.jobs.add(job);
    job.then(() => this.jobs.delete(job), error => {
      this.jobs.delete(job);
      this.noteError(error.code ?? 'MAINTENANCE_FAILED', '后台维护失败，请检查数据目录和设置。');
    });
    return job;
  }
  observeWorkspaceDirectory() {
    if (!this.hostService('workspaceRegistry')?.list || this.disposed) return;
    try { this.refreshWorkspaceFolders(); }
    catch (error) {
      this.noteError(error.code || 'WORKSPACE_DIRECTORY_UNAVAILABLE', '工作区目录暂不可用，将在下次检查重试。');
    }
  }
  hostService(name) {
    return typeof this.ctx.get === 'function' ? this.ctx.get(name) : this.ctx[name];
  }
  sessionChoice(header, agent) {
    const id = header.id ?? agent?.session.id ?? agent?.id;
    const candidate = agent?.session ?? this.ctx.sessions?.get?.(id);
    const live = candidate && canonicalCwd(candidate.header.cwd) === canonicalCwd(header.cwd) ? candidate : null;
    let values = {}, metadataError = null;
    try {
      const cache = this.hostService('sessionProjectionCache');
      const snapshot = live ? this.hostService('sessionProjections')?.cachedSnapshot?.(live) :
        cache?.cachedSnapshot?.(header) ?? cache?.cachedPredecessorTitle?.(header);
      values = snapshot?.values ?? {};
    } catch {
      metadataError = 'SESSION_METADATA_READ_FAILED';
    }
    const route = live?.requestContext?.() ?? values.modelSelection?.next ?? values.modelSelection?.lastUsed;
    return { id, title: typeof values.title === 'string' ? values.title : '',
      cwd: header.cwd ?? '', status: agent?.status ?? (live ? 'idle' : 'inactive'),
      origin: header.origin ?? 'primary', child: Boolean(header.parentSession || header.origin === 'subagent'),
      createdAt: header.createdAt ?? null, metadataError,
      provider: typeof route?.provider === 'string' ? route.provider : '',
      model: typeof route?.model === 'string' ? route.model : '' };
  }
  liveSessionChoices(spaceName) {
    const agents = [...this.ctx.agents.list()];
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const registry = this.privateSessionRegistry();
    return agents.filter(agent => {
      if (this.bindingAt(agent.session.header.cwd)?.space !== spaceName || registry.get(agent.id)) return false;
      let parentId = agent.session.header.parentSession;
      const seen = new Set([agent.id]);
      for (let depth = 0; parentId && depth < 32; depth++) {
        if (seen.has(parentId) || registry.get(parentId) || !byId.has(parentId)) return false;
        seen.add(parentId);
        parentId = byId.get(parentId)?.session?.header?.parentSession;
      }
      return !parentId;
    })
      .map(agent => this.sessionChoice(agent.session.header, agent));
  }
  async workspaceSessionChoices(spaceName, offset = 0, picker = false) {
    const binding = this.bindingIn(spaceName);
    requireValue(binding, 'UNBOUND_WORKSPACE', '请先保存当前空间的工作区绑定，再读取会话。', 409);
    requireValue(Number.isSafeInteger(offset) && offset >= 0, 'INVALID_OFFSET', '会话分页位置无效。');
    const query = this.hostService('sessionQuery');
    requireValue(typeof query?.listSessions === 'function', 'WORKSPACE_SESSIONS_UNAVAILABLE',
      '当前宿主未提供会话目录服务，无法读取历史会话；现有主会话设置未改动。', 503);
    const signal = AbortSignal.timeout(30_000);
    const listed = await query.listSessions(signal);
    requireValue(Array.isArray(listed), 'SESSION_CATALOG_INVALID', '宿主返回的会话目录格式无效。', 502);
    const unique = new Map();
    for (const item of listed) {
      const header = item?.header;
      if (typeof header?.id === 'string' && this.bindingAt(header.cwd)?.space === spaceName)
        unique.set(header.id, header);
    }
    const registry = this.privateSessionRegistry();
    const privacyVersion = registry.version();
    const registryMembers = picker && binding.workspaceId ?
      this.hostService('workspaceRegistry')?.get?.(binding.workspaceId)?.sessionIds : undefined;
    const members = Array.isArray(registryMembers) ? new Set(registryMembers) : null;
    const visible = [...unique.values()].filter(header => {
      if (registry.get(header.id)) return false;
      const seen = new Set([header.id]);
      let parentId = header.parentSession;
      for (let depth = 0; parentId && depth < 32; depth++) {
        if (seen.has(parentId) || registry.get(parentId) || !unique.has(parentId)) return false;
        seen.add(parentId);
        parentId = unique.get(parentId)?.parentSession;
      }
      // A child may be represented through its parent rather than as a top-level sidebar row.
      return !parentId && (!members || [...seen].some(id => members.has(id)));
    });
    const headers = visible.sort((a, b) =>
      (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id));
    // The picker searches cached metadata across the workspace; only the legacy explicit
    // title lookup may ask rc.5 to fold a page of cold session logs.
    const items = (picker ? headers : headers.slice(offset, offset + 25)).map(header =>
      this.sessionChoice(header, this.ctx.agents.get(header.id)));
    const missing = items.filter(item => !item.title);
    if (!picker && missing.length && typeof query.readTitleSnapshots === 'function') {
      const results = await query.readTitleSnapshots(missing.map(item => item.id), signal);
      requireValue(Array.isArray(results) && results.length === missing.length,
        'SESSION_CATALOG_INVALID', '宿主返回的会话名称格式无效。', 502);
      results.forEach((result, index) => {
        const item = missing[index];
        if (result.status === 'rejected') {
          item.metadataError = 'SESSION_TITLE_READ_FAILED';
          return;
        }
        requireValue(result.status === 'fulfilled' && result.value?.session?.id === item.id &&
          canonicalCwd(result.value.session.cwd) === canonicalCwd(binding.cwd),
        'WORKSPACE_SESSIONS_CHANGED', '会话所属工作区已变化，请重新读取。', 409);
        item.title = typeof result.value.title?.title === 'string' ? result.value.title.title : '';
      });
    } else if (missing.length) {
      for (const item of missing) item.metadataError ??= 'SESSION_TITLE_UNAVAILABLE';
    }
    signal.throwIfAborted();
    this.syncConfig();
    requireValue(!this.disposed && registry.version() === privacyVersion && sameBinding(this.bindingIn(spaceName), binding),
      'WORKSPACE_SESSIONS_CHANGED', '工作区绑定或会话可见性已变化，请重新读取。', 409);
    return { space: spaceName, cwd: binding.cwd, items, total: headers.length,
      nextOffset: !picker && offset + items.length < headers.length ? offset + items.length : null,
      warnings: items.filter(item => item.metadataError).length };
  }
  async workspaceSessionSnapshot(spaceName, signal) {
    const binding = this.bindingIn(spaceName);
    requireValue(binding, 'UNBOUND_WORKSPACE', '请先绑定此工作区，再读取会话。', 409);
    const query = this.hostService('sessionQuery');
    requireValue(typeof query?.listSessions === 'function', 'WORKSPACE_SESSIONS_UNAVAILABLE',
      '当前宿主未提供会话目录服务；未读取或整理会话内容。', 503);
    const listed = await query.listSessions(signal);
    requireValue(Array.isArray(listed), 'SESSION_CATALOG_INVALID', '宿主返回的会话目录格式无效。', 502);
    const headers = new Map();
    for (const item of listed) {
      const header = item?.header;
      if (typeof header?.id === 'string' &&
          canonicalCwd(header.cwd) === canonicalCwd(binding.cwd)) headers.set(header.id, header);
    }
    this.syncConfig();
    requireValue(sameBinding(this.bindingIn(spaceName), binding), 'WORKSPACE_SESSIONS_CHANGED', '工作区绑定已变化，请重新检查。', 409);
    return { binding, query, headers };
  }
  async verifiedModelSession(spaceName, selection, signal, purpose = 'deep') {
    this.syncConfig();
    requireValue(selection && typeof selection.sessionId === 'string' &&
      selection.provider && selection.model, 'MODEL_SESSION_UNCONFIGURED',
    '请先为此工作区选择一个可用的模型会话。', 409);
    const { headers } = await this.workspaceSessionSnapshot(spaceName, signal);
    const configured = (purpose === 'private' ? this.config.privateMainSessions :
      this.config.deepOrganizationSessions).find(item => item.space === spaceName);
    requireValue(configured && configured.sessionId === selection.sessionId &&
      configured.provider === selection.provider && configured.model === selection.model,
    'MODEL_SETTINGS_CHANGED', '整理模型设置已变化；请重新检查后重试。', 409);
    const header = headers.get(selection.sessionId);
    requireValue(header, 'MODEL_SESSION_UNAVAILABLE', '所选模型会话不在当前绑定工作区；未发送数据。', 409);
    const route = this.sessionChoice(header, this.ctx.agents.get(header.id));
    requireValue(route.provider === selection.provider && route.model === selection.model,
      'SESSION_MODEL_CHANGED', '所选会话的模型路由已变化；请重新选择并保存。', 409);
    if (purpose === 'private')
      requireValue(!header.parentSession && route.origin !== 'subagent',
        'PRIVATE_MAIN_INHERITED', '私人日记主会话不能是 fork 或子会话；未读取或写入私人内容。', 409);
    return selection;
  }
  modelOrganizationStatus(spaceName) {
    if (this.config.deepOrganizationMode === 'session') {
      const route = this.config.deepOrganizationSessions.find(item => item.space === spaceName);
      if (!route) return { mode: 'session', state: 'unconfigured', code: 'MODEL_SESSION_UNCONFIGURED',
        message: '请读取此工作区的会话并选择整理模型；未发送记忆内容。' };
      const llm = this.hostService('llm');
      return typeof llm?.stream === 'function'
        ? { mode: 'session', state: 'ready', provider: route.provider, model: route.model,
          message: `使用所选工作区会话模型 ${route.provider} / ${route.model} 整理 L1、L2；不读取 L0 或私人日记。` }
        : { mode: 'session', state: 'unavailable', code: 'HOST_LLM_UNAVAILABLE',
          message: '宿主模型流服务不可用；未发送记忆内容。' };
    }
    if (this.config.deepOrganizationMode === 'api') {
      const key = modelApiKeyStatus(this.root);
      if (!key.supported) return { mode: 'api', state: 'unavailable', code: 'MODEL_API_KEY_UNSUPPORTED',
        message: '整理 API 密钥需要 Windows 当前用户 DPAPI；未使用明文存储或发送内容。' };
      if (!key.configured) return { mode: 'api', state: 'unconfigured', code: 'MODEL_API_KEY_UNAVAILABLE',
        message: '请保存受 Windows 当前用户保护的整理 API 密钥；未发送记忆内容。' };
      return { mode: 'api', state: 'ready', model: this.config.deepOrganizationApiModel,
        message: `整理 API 已配置（${this.config.deepOrganizationApiModel}）；仅整理普通 L1、L2，不读取 L0 或私人日记。` };
    }
    return { mode: 'local', state: 'rules-only', code: 'LOCAL_GENERATOR_NOT_CONFIGURED',
      message: '仅运行本地规则；不会调用生成模型。' };
  }
  async runModelDeepSleep(store) {
    this.syncConfig();
    const mode = this.config.deepOrganizationMode;
    if (mode === 'local') return { mode, state: 'rules-only', batches: 0, inspected: 0, saved: 0 };
    store.reconcileForgetLedger();
    const privateVersion = store.reconciledPrivateVersion, forgetVersion = store.reconciledForgetVersion;
    const now = this.clock().getTime();
    const records = ['L1', 'L2'].flatMap(layer => store.db(layer)
      .prepare("SELECT data FROM memories WHERE status='active' ORDER BY id").all()
      .map(row => JSON.parse(row.data)).filter(record => !store.isPrivateQuarantined(record) &&
        (!record.validFrom || Date.parse(record.validFrom) <= now) &&
        (!record.validUntil || Date.parse(record.validUntil) > now)));
    if (!records.length) return { mode, state: 'completed', batches: 0, inspected: 0, saved: 0 };
    const signal = AbortSignal.timeout(180_000);
    const expectedBinding = this.bindingIn(store.name);
    if (this.config.bindings.some(item => item.space === store.name && item.workspaceId) && !expectedBinding)
      throw new MemoryError('WORKSPACE_CHANGED', 'DSH 工作区已失效；未调用整理模型。', 409);
    const route = mode === 'session'
      ? await this.verifiedModelSession(store.name,
        this.config.deepOrganizationSessions.find(item => item.space === store.name), signal)
      : { provider: '', model: this.config.deepOrganizationApiModel, sessionId: '',
        endpoint: this.config.deepOrganizationApiEndpoint };
    const settingsMatch = () => {
      this.syncConfig();
      store.reconcileForgetLedger();
      if (store.privateVersion() !== privateVersion || store.forgetVersion() !== forgetVersion) return false;
      if (this.config.deepOrganizationMode !== mode) return false;
      const currentBinding = this.bindingIn(store.name);
      if ((expectedBinding || currentBinding) && !sameBinding(currentBinding, expectedBinding)) return false;
      if (mode === 'api') return this.config.deepOrganizationApiEndpoint === route.endpoint &&
        this.config.deepOrganizationApiModel === route.model;
      const current = this.config.deepOrganizationSessions.find(item => item.space === store.name);
      return current?.sessionId === route.sessionId && current.provider === route.provider &&
        current.model === route.model;
    };
    const batches = [];
    let batch = [], bytes = 0;
    for (const record of records) {
      const size = Buffer.byteLength(JSON.stringify({
        id: record.id, layer: record.layer, category: record.category,
        occurredAt: record.occurredAt, text: record.text,
      }), 'utf8');
      if (batch.length && (batch.length >= 20 || bytes + size > MODEL_BATCH_BYTES)) {
        batches.push(batch); batch = []; bytes = 0;
      }
      batch.push(record); bytes += size;
    }
    if (batch.length) batches.push(batch);
    let proposed = 0, pendingEvidence = 0, duplicates = 0;
    const apiKey = mode === 'api' ? readModelApiKey(this.root) : null;
    try {
      for (const recordsInBatch of batches) {
        requireValue(settingsMatch(),
        'MODEL_SETTINGS_CHANGED', '整理模型设置已变化；本批未发送。', 409);
        signal.throwIfAborted();
        const generated = await organizeMemoryBatch(this.ctx, {
          mode, provider: route.provider, model: route.model,
          sessionId: route.sessionId, endpoint: mode === 'api' ? this.config.deepOrganizationApiEndpoint : undefined,
          apiKey, signal, records: recordsInBatch,
        });
        requireValue(settingsMatch(),
          'MODEL_SETTINGS_CHANGED', '整理模型设置已变化；本批输出未写入。', 409);
        for (const memory of generated) {
          store.reconcileForgetLedger();
          const sources = memory.sourceIds.map(id => recordsInBatch.find(record => record.id === id));
          const currentTime = this.clock().getTime();
          requireValue(sources.every(source => source && ['L1', 'L2'].includes(source.layer) &&
            store.raw(source.id)?.status === 'active' && store.raw(source.id)?.revision === source.revision &&
            !store.isPrivateQuarantined(source) &&
            (!source.validFrom || Date.parse(source.validFrom) <= currentTime) &&
            (!source.validUntil || Date.parse(source.validUntil) > currentTime)),
            'MODEL_SOURCE_CHANGED', '整理来源已变化；本批输出未写入。', 409);
          const input = {
            layer: 'L3', text: memory.text, category: memory.category, kind: 'inference',
            horizon: 'long_term', status: 'review', scope: 'space',
            occurredAt: sources.map(source => source.occurredAt).filter(Boolean).sort().at(-1) ?? null,
            parents: memory.sourceIds,
            source: { kind: 'model-consolidation', provider: route.provider || 'configured-api',
              model: route.model, sourceIds: memory.sourceIds, at: this.clock().toISOString() },
          };
          proposed++;
          const key = normalizeRecord(input, store.now()).dedupeKey;
          if (store.db('L3').prepare('SELECT 1 FROM memories WHERE dedupe_key=?').get(key)) {
            duplicates++;
            continue;
          }
          store.create(input, ADMIN);
          pendingEvidence++;
        }
      }
    } finally { apiKey?.fill(0); }
    return { mode, state: 'completed', batches: batches.length, inspected: records.length,
      proposed, saved: 0, pendingEvidence, duplicates, pendingConflicts: 0 };
  }
  saveAutoJournalStatus(store, value) {
    store.privateDb.prepare("INSERT OR REPLACE INTO journal_metadata(key,value) VALUES('auto-daily-summary',?)")
      .run(JSON.stringify(value));
  }
  async runPrivateDailySummary(store, day, { automatic = false } = {}) {
    const parsedDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? Date.parse(`${day}T00:00:00Z`) : NaN;
    requireValue(Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === day,
    'INVALID_DATE', '私人日记目标日期无效。');
    if (!this.config.privateAutoJournalEnabled) return { state: 'disabled', day };
    const previous = store.privateDb.prepare("SELECT value FROM journal_metadata WHERE key='auto-daily-summary'").get()?.value;
    if (previous) {
      try {
        const saved = JSON.parse(previous);
        if (saved.day === day && ['completed', 'no-content'].includes(saved.state))
          return { state: saved.state, day, alreadyRun: true };
      } catch {}
    }
    if (store.privateDb.prepare("SELECT 1 FROM entries WHERE author='tidal-auto' AND day_key=? LIMIT 1").get(day)) {
      const result = { state: 'completed', day, at: this.clock().toISOString(), sessionCount: 0,
        messageCount: 0, provider: '', model: '' };
      this.saveAutoJournalStatus(store, result);
      return { ...result, alreadyRun: true };
    }
    try {
      const selection = this.config.privateMainSessions.find(item => item.space === store.name);
      const signal = AbortSignal.timeout(180_000);
      requireValue(selection, 'PRIVATE_MAIN_UNCONFIGURED', '请先选择此工作区的私人日记主会话。', 409);
      const route = await this.verifiedModelSession(store.name, selection, signal, 'private');
      const sessionSnapshot = await this.workspaceSessionSnapshot(store.name, signal);
      const { headers, query } = sessionSnapshot;
      const settingsMatch = () => {
        this.syncConfig();
        const currentSelection = this.config.privateMainSessions.find(item => item.space === store.name);
        return this.config.privateAutoJournalEnabled && currentSelection &&
          currentSelection.sessionId === route.sessionId && currentSelection.provider === route.provider &&
          currentSelection.model === route.model &&
          sameBinding(this.bindingIn(store.name), sessionSnapshot.binding);
      };
      requireValue(typeof query.readSession === 'function', 'SESSION_HISTORY_UNAVAILABLE',
        '宿主未提供历史会话读取服务；未写入私人日记。', 503);
      const messages = [];
      const sessionIds = [...headers.keys()];
      for (const sessionId of sessionIds) {
        requireValue(settingsMatch(), 'MODEL_SETTINGS_CHANGED',
          '私人日记或工作区设置已变化；已停止读取会话。', 409);
        signal.throwIfAborted();
        let loaded;
        try { loaded = await query.readSession(sessionId); }
        catch { throw new MemoryError('SESSION_HISTORY_READ_FAILED', '读取同工作区会话历史失败；未写入私人日记。', 503); }
        signal.throwIfAborted();
        requireValue(loaded?.session?.id === sessionId && typeof loaded.session.cwd === 'string' &&
          Array.isArray(loaded.events), 'SESSION_HISTORY_INVALID',
        '宿主返回的会话历史格式无效；未写入私人日记。', 502);
        requireValue(canonicalCwd(loaded.session.cwd) === canonicalCwd(this.bindingIn(store.name)?.cwd), 'WORKSPACE_SESSIONS_CHANGED',
        '会话历史所属工作区已变化；未写入私人日记。', 409);
        const events = loaded.events;
        events.forEach((event, index) => {
          if (!['user/message', 'assistant/message'].includes(event?.type)) return;
          const time = new Date(event.time);
          if (!Number.isFinite(time.getTime()) || dateKey(time) !== day) return;
          const isUser = event.type === 'user/message' && event.data?.source?.kind === 'user';
          const isAssistant = event.type === 'assistant/message' &&
            event.data?.message?.role === 'assistant' && event.data?.interrupted !== true &&
            event.data?.message?.interrupted !== true;
          if (!isUser && !isAssistant) return;
          const text = textOf(isAssistant ? event.data.message : event.data);
          if (!text.trim()) return;
          const eventId = event.seq ?? event.id ?? index;
          messages.push({ id: `${hash(sessionId).slice(0, 20)}:${eventId}`,
            role: isUser ? 'user' : 'assistant', time: time.toISOString(), text });
        });
      }
      messages.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
      requireValue(settingsMatch(), 'MODEL_SETTINGS_CHANGED',
      '私人日记模型设置已变化；未发送会话内容。', 409);
      if (!messages.length) {
        const result = { state: 'no-content', day, at: this.clock().toISOString(),
          sessionCount: sessionIds.length, messageCount: 0, provider: route.provider, model: route.model };
        this.saveAutoJournalStatus(store, result);
        return result;
      }
      automaticBackup(store, this.root, { force: true });
      const summary = await summarizeDailyMessages(this.ctx, {
        day, messages, provider: route.provider, model: route.model,
        sessionId: route.sessionId, signal,
      });
      requireValue(settingsMatch(), 'MODEL_SETTINGS_CHANGED',
      '私人日记模型设置已变化；生成内容未写入。', 409);
      requireValue(!store.privateDb.prepare(
        "SELECT 1 FROM entries WHERE author='tidal-auto' AND day_key=? LIMIT 1").get(day),
      'JOURNAL_DAY_ALREADY_WRITTEN', '目标日期已存在自动日记；未追加重复内容。', 409);
      const sourceIds = messages.slice(0, 40).map(message => `session-event:${message.id}`);
      store.appendAutomaticPrivateEntry({
        content: summary.markdown.trim(),
        sourceIds, sourceSession: route.sessionId, dayKey: day,
      });
      const result = { state: 'completed', day, at: this.clock().toISOString(),
        sessionCount: sessionIds.length, messageCount: messages.length,
        provider: route.provider, model: route.model, calls: summary.calls };
      this.saveAutoJournalStatus(store, result);
      if (this.lastError?.operation === 'private-daily-summary' && this.lastError.space === store.name)
        this.lastError = null;
      return result;
    } catch (error) {
      const code = error.code ?? 'PRIVATE_DAILY_SUMMARY_FAILED';
      const result = { state: 'failed', day, at: this.clock().toISOString(),
        sessionCount: 0, messageCount: 0, provider: '', model: '', code };
      try { this.saveAutoJournalStatus(store, result); } catch {}
      this.noteError(code, '私人日记汇总未完成；会话正文不会写入普通状态或错误日志。', {
        operation: 'private-daily-summary', space: store.name,
      });
      return { state: 'failed', day, code, automatic, message: error instanceof MemoryError
        ? error.message : '私人日记汇总未完成；请检查状态后重试。' };
    }
  }
  readOnlyStatus(name) {
    const directory = this.directoryFor(name);
    const databaseFiles = [
      ...Object.values(LAYERS).map(info => join(directory, info.directory, info.file)),
      join(directory, 'system', 'operations.sqlite3'),
      join(directory, 'private', 'journal.sqlite3'),
      privateJournalDatabasePath(directory),
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
      const privateFile = existsSync(privateJournalDatabasePath(directory)) ? privateJournalDatabasePath(directory) :
        join(directory, 'private', 'journal.sqlite3');
      const privateDb = open(privateFile);
      const count = privateDb ? privateJournalStatus(privateDb, join(directory, 'private')) :
        { count: 0, lastWritten: null, dailyCount: 0, legacyCount: 0, firstDay: null, lastDay: null, organization: null, failure: null };
      let bytes = 0;
      for (const file of [privateFile, `${privateFile}-wal`]) {
        try { bytes += statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      bytes += count.bytes ?? 0;
      return {
        space: name, directory, layers, errors: [], searchIndex,
        private: { ...count, bytes, directory: join(directory, 'private'), indexFile: privateFile, authors: this.config.privateWriters,
          contentVisible: false, generation: '默认关闭；启用后只从精确绑定工作区会话生成私人 Markdown 日记。' },
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
        const agents = [...this.ctx.agents.list()].filter(agent =>
          this.bindingAt(agent.session.header.cwd)?.space === name);
        if (agents.some(agent => agent.status === 'running')) {
          results.push({ space: name, waitingForConversation: true, day });
          continue;
        }
        if (now.getTime() - (this.workspaceActivity.get(name) ?? this.lastActivity) < this.config.idleMinutes * 60000) {
          results.push({ space: name, waiting: true, day });
          continue;
        }
        const previousDue = new Date(due);
        previousDue.setDate(previousDue.getDate() - 1);
        const privateDailySummary = this.config.privateAutoJournalEnabled
          ? await this.runPrivateDailySummary(store, dateKey(previousDue), { automatic: true })
          : { state: 'disabled', day: dateKey(previousDue) };
        if (store.dailyConsolidationStatus()?.day >= day) {
          results.push({ space: name, alreadyRun: true, day, privateDailySummary,
            modelOrganization: this.modelOrganizationStatus(name) });
          continue;
        }
        try {
          const backup = automaticBackup(store, this.root, { force: true });
          const privateOrganization = this.runPrivateOrganization(store, now, due);
          const from = store.system.prepare("SELECT value FROM metadata WHERE key='sleep-reencoding-until'").get()?.value ??
            previousDue.toISOString();
          const modelOrganization = await this.runModelDeepSleep(store);
          const result = store.dailyConsolidation(day, {
            missed: now.getTime() - due.getTime() > 60000, backup, from, until: now.toISOString(),
            modelOrganization,
          });
          if (this.lastError?.operation === 'consolidation' && this.lastError.space === name) this.lastError = null;
          results.push({ space: name, ...result, privateOrganization, privateDailySummary,
            modelOrganization, modelExtraction: modelOrganization });
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
    if (method === 'GET' && path === '/workspaces') return { items: this.refreshWorkspaceFolders() };
    const spaceName = slug(query.get('space') ?? 'default');
    if (method === 'POST' && path === '/workspace-binding') return this.changeBinding(spaceName, body);
    if (method === 'POST' && path === '/workspace-selection') {
      const key = body.setting, selection = body.selection;
      requireValue(ROUTE_SETTINGS.includes(key), 'INVALID_INPUT', '未知的会话用途。');
      requireValue(this.bindingIn(spaceName), 'UNBOUND_WORKSPACE', '请先绑定有效的 DSH 工作区。', 409);
      const remaining = this.config[key].filter(item => item.space !== spaceName);
      if (selection !== null) {
        const catalog = await this.workspaceSessionChoices(spaceName, 0, true);
        const found = catalog.items.find(item => item.id === selection?.sessionId);
        requireValue(found && (!found.child || key === 'deepOrganizationSessions'),
          'SESSION_UNAVAILABLE', '会话已不可选；请刷新后重新选择。', 409);
        requireValue(found.provider && found.model && found.provider === selection.provider && found.model === selection.model,
          'SESSION_MODEL_CHANGED', '模型路由缺失或已变化；请在 DSH 中选定模型，刷新后重新确认。', 409);
        remaining.push({ space: spaceName, sessionId: found.id, provider: found.provider, model: found.model });
      }
      await this.saveSettings({ [key]: remaining }, body.revision);
      return { saved: true };
    }
    if (method === 'GET' && path === '/workspace-sessions') {
      try { return await this.workspaceSessionChoices(spaceName, Number(query.get('offset') ?? 0), query.get('view') === 'picker'); }
      catch (error) {
        if (error instanceof MemoryError) throw error;
        throw new MemoryError(error?.name === 'TimeoutError' ? 'WORKSPACE_SESSIONS_TIMEOUT' : 'WORKSPACE_SESSIONS_READ_FAILED',
          '读取工作区会话失败或超时，请重试；主会话选择和授权未改动。', 503);
      }
    }
    if (method === 'GET' && path === '/status') {
      let details;
      try {
        this.directoryFor(spaceName);
        details = this.spaces.get(spaceName)?.status() ?? this.readOnlyStatus(spaceName);
      } catch (error) {
        if (error.code !== 'SPACE_BUSY' && !String(error.code).startsWith('WORKSPACE_')) throw error;
        details = { space: spaceName, unavailable: true, spaceError: { code: error.code, message: error.message }, layers: [] };
      }
      const localDirectory = details.directory || this.localWorkspaces.get(spaceName)?.memoryDirectory || join(this.root, 'spaces', spaceName);
      const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` :
        `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(fileURLToPath(
        new URL('../scripts/setup-model.mjs', import.meta.url)))}`;
      return { version: PACKAGE_VERSION, root: this.root, spaces: this.names(), ...details,
        paths: { plugin: fileURLToPath(new URL('../', import.meta.url)), models: join(this.root, 'models'), memoryDirectory: localDirectory,
          semanticIndex: join(localDirectory, 'indexes', 'semantic.sqlite3'),
          topicIndex: join(localDirectory, 'indexes', 'topics.sqlite3'),
          graphIndex: join(localDirectory, 'indexes', 'graph.sqlite3'),
          backups: join(this.root, 'backups', spaceName),
          backupKey: automaticKeyStatus(this.root).path,
          privateSessionRegistry: join(this.root, 'system', 'private-sessions.sqlite3'),
          forgetLedger: join(this.root, 'system', 'forget-ledger.sqlite3') },
        backupProtection: { mode: this.config.autoBackupMode, ...automaticKeyStatus(this.root) },
        modelApiKey: (({ supported, configured }) => ({ supported, configured }))(modelApiKeyStatus(this.root)),
        modelPacks: modelInventory(this.root).map(item => ({ ...item,
          installCommand: `${command} --edition ${item.edition} --root ${quote(this.root)}` })),
        semantic: { ...this.embedding.state, index: this.spaces.get(spaceName)?.semanticIndex?.status() ?? null,
          tasks: [...this.semanticTasks].filter(task => task.space === spaceName)
            .map(task => ({ kind: task.kind, state: task.state })),
          lastTask: this.lastSemanticTask.get(spaceName) ?? null },
        graph: this.spaces.get(spaceName)?.graphIndex?.status() ??
          { state: 'unprepared', progress: { phase: 'waiting', scanned: 0 }, indexed: 0, error: null },
        config: this.config, legacyModelExtractionIgnored: this.legacyModelExtractionIgnored,
        organizationModels: { ordinary: this.modelOrganizationStatus(spaceName),
          private: { mode: this.config.privateOrganizationMode, authorAvailable: false,
            code: 'PRIVATE_MODEL_ROUTE_UNVERIFIED',
            message: '作者模型映射及私人调用审计尚未验证，作者模型选项暂不可用。' } },
        dailyConsolidation: details.dailyConsolidation ?? null,
        nextDailyConsolidationAt: this.config.enabled && this.config.dailyConsolidateAt && !details.unavailable ?
          nextScheduledAt(this.clock(), this.config.dailyConsolidateAt, details.dailyConsolidation?.day) : null,
        settingsRevision: this.descriptor()?.revision ?? null, busy: this.busy,
        error: this.lastError?.space && this.lastError.space !== spaceName ? null : this.lastError,
        spaceErrors: Object.fromEntries(this.spaceErrors),
        sessions: this.liveSessionChoices(spaceName) };
    }
    if (method === 'POST' && path === '/config') {
      requireValue(body && typeof body.patch === 'object' && body.patch !== null, 'INVALID_CONFIG', '配置补丁无效。');
      const keys = Object.keys(body.patch);
      requireValue(keys.every(key => Object.hasOwn(this.config, key)), 'INVALID_CONFIG', '包含未知配置项。');
      // Older clients include unchanged scope fields in ordinary settings saves.
      const scoped = key => key === 'bindings' || ROUTE_SETTINGS.includes(key);
      requireValue(keys.every(key => !scoped(key) || JSON.stringify(body.patch[key]) === JSON.stringify(this.config[key])),
        'INVALID_CONFIG', '请使用工作区设置入口修改绑定或授权。');
      await this.saveSettings(Object.fromEntries(keys.filter(key => !scoped(key)).map(key => [key, body.patch[key]])), body.revision);
      return { saved: true };
    }
    if (method === 'POST' && path === '/restore') {
      requireValue(!readLocation(this.root, slug(body.name)) && !this.localWorkspaces.has(body.name),
        'SPACE_EXISTS', '已有工作区使用此空间标识，不允许恢复覆盖。', 409);
      const result = restoreBackup(this.root, slug(body.name), body.text, body.password ?? '', this.config);
      return result;
    }
    if (method === 'POST' && path === '/backup/key') return saveAutomaticKey(this.root, body.password);
    if (method === 'POST' && path === '/model-api-key')
      return saveModelApiKey(this.root, body.apiKey);
    if (method === 'POST' && path === '/model-api-key/clear')
      return { cleared: true, ...clearModelApiKey(this.root) };
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
    if (method === 'POST' && path === '/capture/retry') {
      for (const row of store.system.prepare("SELECT session_id,event_seq FROM capture_receipts WHERE state='failed'").all()) {
        if (!store.blockedSessionIds.has(row.session_id))
          store.system.prepare(`UPDATE capture_receipts SET attempts=0 WHERE session_id=? AND event_seq=?`)
            .run(row.session_id, row.event_seq);
      }
      return this.retryLiveCaptures(store, { force: true });
    }
    if (method === 'POST' && path === '/recall') return this.recallAsync(store, ADMIN, body.query, {
      includeArchived: body.includeArchived === true, mode: body.mode ?? 'current', asOf: body.asOf });
    if (method === 'POST' && path === '/topics/read') return store.readEvidence(body, ADMIN);
    if (method === 'GET' && path === '/graph/status') return store.graph().status();
    if (method === 'POST' && path === '/graph/prepare') return this.requestGraphBuild(store);
    if (method === 'POST' && path === '/graph/list') return store.graphList(body, ADMIN);
    if (method === 'POST' && path === '/graph/neighbors') return store.graphNeighbors(body, ADMIN);
    if (method === 'POST' && path === '/graph/suggestions') return this.requestGraphSuggestions(store, body);
    if (method === 'GET' && path === '/graph/record') {
      for (let attempt = 0; attempt < 3; attempt++) {
        store.reconcileForgetLedger();
        const version = store.reconciledForgetVersion, privateVersion = store.reconciledPrivateVersion;
        const record = store.rawOrdinary(query.get('id'));
        requireValue(record && store.visible(record, ADMIN), 'NOT_FOUND', '找不到此范围内的普通记忆。', 404);
        if (version === store.forgetVersion() && privateVersion === store.privateVersion()) return record;
      }
      throw new MemoryError('FORGET_CONFLICT', '读取图谱正文期间遗忘或私人隔离状态持续变化，请稍后重试。', 409);
    }
    if (method === 'POST' && path === '/graph/decision') {
      const result = store.graphDecision(body, ADMIN);
      this.invalidateSpace(spaceName);
      return result;
    }
    if (method === 'POST' && path === '/graph/rebuild') {
      const task = this.graphTasks.get(spaceName);
      if (task) {
        task.controller.abort();
        await Promise.allSettled([task.promise]);
      }
      store.graphIndex?.close();
      store.graphIndex = null;
      clearGraphFiles(store.directory);
      return this.requestGraphBuild(store);
    }
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
        this.bindingAt(agent.session.header.cwd)?.space === spaceName),
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
        const modelOrganization = await this.runModelDeepSleep(store);
        return { ...store.manualDeepConsolidation(dateKey(now), {
          backup, from, until: now.toISOString(), modelOrganization,
        }), privateOrganization, modelOrganization, modelExtraction: modelOrganization };
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
    if (method === 'POST' && path === '/private/daily-summary') {
      requireValue(!this.busy, 'MAINTENANCE_BUSY', '整理任务正在运行，请稍后重试。', 409);
      requireValue(this.config.privateAutoJournalEnabled, 'PRIVATE_AUTO_JOURNAL_DISABLED',
        '请先在设置中启用私人日记自动汇总。', 409);
      requireValue(![...this.ctx.agents.list()].some(agent => agent.status === 'running' &&
        this.bindingAt(agent.session.header.cwd)?.space === spaceName),
      'CONVERSATION_BUSY', '当前空间正在生成回复，请等会话空闲后再整理。', 409);
      const day = body.day;
      const parsedDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? Date.parse(`${day}T00:00:00Z`) : NaN;
      requireValue(Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === day &&
        day <= dateKey(this.clock()), 'INVALID_DATE', '私人日记只支持有效的今天或过去日期。');
      this.busy = true;
      try {
        const result = await this.runPrivateDailySummary(store, day);
        requireValue(result.state !== 'failed' && result.state !== 'disabled', result.code ??
          'PRIVATE_DAILY_SUMMARY_FAILED', result.message ?? '私人日记汇总未完成；请检查状态后重试。', 409);
        return result;
      } finally {
        this.busy = false;
        this.invalidateSpace(spaceName);
      }
    }
    if (method === 'POST' && path === '/private/organize') {
      requireValue(!this.busy, 'MAINTENANCE_BUSY', '整理任务正在运行，请稍后重试。', 409);
      requireValue(![...this.ctx.agents.list()].some(agent => agent.status === 'running' &&
        this.bindingAt(agent.session.header.cwd)?.space === spaceName),
      'CONVERSATION_BUSY', '当前空间正在生成回复，请等会话空闲后再整理。', 409);
      const now = this.clock();
      const due = this.config.dailyConsolidateAt ? latestScheduledAt(now, this.config.dailyConsolidateAt) : now;
      const result = this.runPrivateOrganization(store, now, due);
      requireValue(!['failed', 'unavailable'].includes(result.state), result.code,
        result.message ?? '私人整理未完成，请检查状态后重试。', 409);
      return result;
    }
    if (method === 'POST' && path === '/private/clear') {
      requireValue(!this.busy, 'MAINTENANCE_BUSY', '私人日记正在整理，请稍后重试。', 409);
      return store.clearPrivate(ADMIN, body.confirmation);
    }
    if (method === 'POST' && path === '/backup') return { filename: `tidal-${spaceName}-${Date.now()}.${body.password ? 'encrypted' : 'json'}`,
      text: packBackup(store, body.password ?? '') };
    if (method === 'POST' && path === '/history/import-preview')
      return this.previewHistoryImport(store, body);
    if (method === 'POST' && path === '/history/import-apply') {
      const plan = this.plans.get(body.id);
      requireValue(plan?.kind === 'history' && plan.expires >= this.clock().getTime() && plan.space === spaceName,
        'PREVIEW_EXPIRED', '历史补录预览已过期或空间已切换，请重新预览。', 409);
      return this.applyHistoryImport(store, plan, body.selected);
    }
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
    for (const dispose of this.privateAgentDisposers.values()) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    this.privateAgentDisposers.clear();
    for (const task of this.semanticTasks) task.controller.abort();
    for (const task of this.graphTasks.values()) task.controller.abort();
    for (const task of this.graphSuggestionTasks.values()) task.controller.abort();
    try { await this.embedding.close(); } catch (error) { errors.push(error); }
    await Promise.allSettled([...this.jobs]);
    for (const store of this.spaces.values()) {
      try { store.close(); } catch (error) { errors.push(error); }
    }
    this.spaces.clear();
    this.plans.clear();
    this.privateCandidates.clear();
    this.pendingPrivateObservations.clear();
    try { this.privateSessions?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '部分潮汐记忆资源未能关闭。');
  }
}
