import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemorySpace } from './store.js';
import { automaticBackup, applyImport, importPreview, packBackup, restoreBackup } from './transfer.js';
import { extractBatch } from './extraction.js';
import { bindingFor, configOf, MemoryError, requireValue, slug, string } from './model.js';

export const ADMIN = Object.freeze({ admin: true });
export const PREFIX = '/tidal-memory';
const MAX_BODY = 12 * 1024 * 1024;
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text')
  .map(block => block.text).join('\n').toWellFormed();

export class TidalRuntime {
  constructor(ctx, rawConfig, home, createUserMessage) {
    this.ctx = ctx;
    this.rawConfig = rawConfig;
    this.config = configOf(rawConfig);
    this.root = resolve(this.config.dataRoot || join(home, 'tidal-memory'));
    this.createUserMessage = createUserMessage;
    this.spaces = new Map();
    this.plans = new Map();
    this.sessions = new Map();
    this.controllers = new Set();
    this.jobs = new Set();
    this.lastActivity = Date.now();
    this.workspaceActivity = new Map();
    this.disposed = false;
    this.lastError = null;
    this.busy = false;
    this.space('default');
  }
  syncConfig() {
    const config = configOf(this.rawConfig);
    requireValue(!config.dataRoot || resolve(config.dataRoot) === this.root, 'ROOT_RESTART_REQUIRED', '数据目录已变化。请停止插件并迁移数据后重新启动。', 409);
    const changed = JSON.stringify(config) !== JSON.stringify(this.config);
    this.config = config;
    for (const store of this.spaces.values()) store.setConfig(config);
    if (changed) {
      for (const state of this.sessions.values()) state.context = null;
      for (const controller of this.controllers) controller.abort(new Error('Memory configuration changed'));
    }
    return this.config;
  }
  space(name) {
    slug(name);
    requireValue(!this.disposed, 'CLOSED', '插件已停止。', 503);
    if (!this.spaces.has(name)) this.spaces.set(name, new MemorySpace(this.root, name, { config: this.config }));
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
    return { store: this.space(binding.space), actor: { sessionId: agent.id } };
  }
  noteError(code, message) {
    this.lastError = { code, message, at: new Date().toISOString() };
    this.ctx.logger?.warn?.(`[tidal-memory] ${code}: ${message}`);
  }
  onEvent(session, event) {
    if (this.disposed) return;
    try {
      this.syncConfig();
      if (!this.config.enabled || session.header.origin === 'subagent') return;
      const binding = bindingFor(this.config, session.header.cwd);
      if (!binding) return;
      let state = this.sessions.get(session.id);
      if (!state) {
        state = { query: '', context: null, turn: null, lastSeen: Date.now() };
        this.sessions.set(session.id, state);
      }
      state.lastSeen = Date.now();
      this.lastActivity = state.lastSeen;
      this.workspaceActivity.set(binding.space, state.lastSeen);
      if (event.type === 'turn/start') { state.context = null; state.turn = event.data.turn; }
      const message = event.type === 'user/message' ? event.data :
        event.type === 'assistant/message' ? event.data.message : null;
      if (!message) return;
      if (event.type === 'user/message' && message.source?.kind !== 'user') return;
      if (event.type === 'assistant/message' && event.data.interrupted) return;
      const text = textOf(message);
      if (!text.trim()) return;
      if (text.length > 16000) {
        this.noteError('CAPTURE_TOO_LARGE', '一条消息超过缓冲上限，未保存；原文仍由 DSH 管理。');
        return;
      }
      const store = this.space(binding.space);
      const source = store.capture({
        sessionId: session.id, eventId: event.seq, text, role: message.role,
        at: new Date(event.time).toISOString(),
      });
      if (message.role === 'user') {
        state.query = text;
        state.context = null;
        const explicit = text.match(/^(?:请)?(?:记住|记一下|remember)\s*[:：,，]?\s+([\s\S]+)$/i) ??
          text.match(/^(?:请)?(?:记住|记一下)[:：]([\s\S]+)$/);
        if (explicit && explicit[1].trim()) {
          store.promote(source.id, { layer: 'L3', text: explicit[1].trim(), category: 'knowledge',
            kind: 'user_statement', status: 'active' }, ADMIN);
        }
      }
    } catch (error) {
      this.noteError(error.code ?? 'CAPTURE_FAILED', '记忆捕获未完成，请在管理页检查。');
    }
  }
  context({ agent }) {
    try {
      this.syncConfig();
      if (!this.config.enabled || !agent?.session || agent.session.header.origin === 'subagent') return '';
      if (!bindingFor(this.config, agent.session.header.cwd)) return '';
      const { store, actor } = this.forAgent(agent);
      let state = this.sessions.get(agent.id);
      if (!state) {
        const events = agent.session.snapshotEvents();
        const last = [...events].reverse().find(e => e.type === 'user/message' && e.data.source?.kind === 'user');
        state = { query: last ? textOf(last.data) : '', context: null, turn: null, lastSeen: Date.now() };
        this.sessions.set(agent.id, state);
      }
      if (state.context === null) state.context = store.recall(state.query, actor).text;
      return state.context;
    } catch (error) {
      this.noteError(error.code ?? 'RECALL_FAILED', '记忆召回不可用，不应声称已经读取历史。');
      return '[潮汐记忆暂不可用：请勿声称已检索到历史记录。]';
    }
  }
  async generate(agent, system, prompt, signal) {
    const route = agent.session.requestHeader()?.config;
    requireValue(route?.provider && route?.model && this.ctx.llm, 'MODEL_UNAVAILABLE', '会话尚无可用模型路由。', 503);
    const blocks = new Map();
    let usage, finish;
    const request = {
      provider: route.provider, model: route.model, system,
      messages: [this.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      maxTokens: this.config.maxModelOutputTokens, tools: [], signal, sessionId: agent.id,
    };
    for await (const chunk of this.ctx.llm.stream(request)) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    requireValue(finish === 'stop', 'EXTRACTION_INCOMPLETE', '提炼输出未正常结束，候选未写入。');
    const text = [...blocks].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
    return { text, usage };
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
        if (!force && Date.now() - (this.workspaceActivity.get(name) ?? this.lastActivity) < this.config.idleMinutes * 60000) {
          results.push({ space: name, waiting: true }); continue;
        }
        const store = this.space(name);
        results.push({ space: name, ...store.maintenance() });
        if (this.config.autoExtract) {
          const pending = store.db('L0').prepare("SELECT data FROM memories WHERE status='pending' ORDER BY created_at,id LIMIT 200")
            .all().map(row => JSON.parse(row.data));
          const routeAgent = agents.find(agent => agent.session.requestHeader()?.config?.model);
          if (pending.length && routeAgent) {
            const records = [], limit = 24000;
            let size = 0, users = 0;
            for (const record of pending) {
              if ((record.source.role === 'user' && users >= this.config.captureBatch) || size + record.text.length > limit) break;
              records.push(record); size += record.text.length; users += Number(record.source.role === 'user');
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(new Error('Extraction timeout')), 90000);
            this.controllers.add(controller);
            try {
              results.push(await extractBatch(store, records,
                (system, prompt, signal) => this.generate(routeAgent, system, prompt, signal),
                controller.signal));
            } catch (error) {
              store.logError(error.code ?? 'EXTRACTION_FAILED', '提炼未完成；来源保留，可在修复后重试。');
              this.noteError(error.code ?? 'EXTRACTION_FAILED', '后台提炼未完成，来源保留。');
            } finally {
              clearTimeout(timeout);
              this.controllers.delete(controller);
            }
          }
        }
        if (this.config.autoBackup) automaticBackup(store, this.root);
      }
      for (const state of this.sessions.values()) state.context = null;
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
    this.requestMaintenance().catch(error => this.noteError(error.code ?? 'MAINTENANCE_FAILED', '后台维护失败，请检查数据目录和设置。'));
  }
  descriptor() {
    return this.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'tidal-memory');
  }
  async api(method, path, query, body) {
    this.syncConfig();
    const spaceName = slug(query.get('space') ?? 'default');
    if (method === 'GET' && path === '/status') {
      return { version: '0.1.0', root: this.root, spaces: this.names(), ...this.space(spaceName).status(),
        config: this.config, settingsRevision: this.descriptor()?.revision ?? null, busy: this.busy,
        error: this.lastError,
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
    if (method === 'POST' && path === '/memories') return store.create(body, ADMIN);
    if (method === 'POST' && path === '/update') return store.update(body.id, body.patch, body.revision, ADMIN);
    if (method === 'POST' && path === '/promote') return store.promote(body.id, body.target, ADMIN);
    if (method === 'POST' && path === '/forget') {
      requireValue(body.confirmation === 'DELETE', 'CONFIRMATION_REQUIRED', '请输入 DELETE 确认删除。');
      return store.forget(body.id, ADMIN);
    }
    if (method === 'POST' && path === '/confirm') return store.reinforce(body.id, `ui:${randomUUID()}`, ADMIN);
    if (method === 'GET' && path === '/history') return store.revisions(query.get('id'), ADMIN);
    if (method === 'GET' && path === '/evidence') return store.get(query.get('id'), ADMIN).sources;
    if (method === 'GET' && path === '/traces') return store.traces(ADMIN);
    if (method === 'POST' && path === '/recall') return store.recall(body.query, ADMIN, { includeArchived: body.includeArchived === true });
    if (method === 'POST' && path === '/maintenance') return this.requestMaintenance(true, spaceName);
    if (method === 'POST' && path === '/rebuild') { store.rebuildViews(); return { rebuilt: true }; }
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
    for (const controller of this.controllers) controller.abort(new Error('Plugin disposed'));
    await Promise.allSettled([...this.jobs]);
    for (const store of this.spaces.values()) store.close();
    this.spaces.clear();
    this.plans.clear();
  }
}
