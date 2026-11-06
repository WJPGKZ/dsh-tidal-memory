import { hostModule } from './src/host-deps.js';
import { TidalRuntime, PREFIX } from './src/runtime.js';
import { DEFAULTS, MAX_CONTEXT_BUDGET, requireValue } from './src/model.js';

const { default: z } = await hostModule('@deepseek-ai/schemastery');
const { defineTool } = await hostModule('@deepseek-ai/dsh-tools');
const { resolveDshHome } = await hostModule('@deepseek-ai/dsh-home-paths');
export const name = 'dsh-tidal-memory';
export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'settings', 'webServer', 'connection'];
export const provide = ['tidalMemory'];
const integer = (value, min, max, description) => z.number().step(1).min(min).max(max).default(value).volatile().description(description);
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('启用记忆捕获与召回。关闭后管理界面仍可使用。'),
  dataRoot: z.string().default('').description('绝对数据根目录。留空使用 DSH_HOME 下的 tidal-memory；修改需要重启并自行迁移。'),
  bindings: z.array(z.object({ cwd: z.string(), space: z.string() })).default([]).volatile().description('显式绑定工作区与空间，不自动共享其他工作区。'),
  tokenBudget: integer(DEFAULTS.tokenBudget, 256, MAX_CONTEXT_BUDGET, '总上下文预算（UTF-8 字节估算，包含 L3 常驻）。'),
  maxRecall: integer(DEFAULTS.maxRecall, 1, 100, '相关记忆最多条数；L3 常驻及最多 5 条明确来源关联另计。'),
  residentMode: z.string().default(DEFAULTS.residentMode).volatile().description('L3 常驻：all 全部有效条目 / core 身份偏好约定及固定项 / pinned 仅固定项。'),
  residentBudget: integer(DEFAULTS.residentBudget, 0, MAX_CONTEXT_BUDGET, 'L3 常驻额度（UTF-8 字节），仍受总预算约束。0 关闭常驻输出。'),
  contextMessages: integer(DEFAULTS.contextMessages, 1, 10, '自动召回参考最近多少条用户消息。'),
  embeddingMode: z.string().default(DEFAULTS.embeddingMode).volatile().description('off 标准 / cpu 本地语义 / enhanced 本地增强；共用同一记忆库，不自动下载模型。'),
  embeddingModelPath: z.string().default(DEFAULTS.embeddingModelPath).volatile().description('本地模型包绝对目录；留空使用数据根 models 下的组合默认模型。'),
  embeddingDevice: z.string().default(DEFAULTS.embeddingDevice).volatile().description('auto：增强版使用 Vulkan GPU，语义版使用 CPU；cpu：强制 CPU。'),
  embeddingTimeoutSeconds: integer(DEFAULTS.embeddingTimeoutSeconds, 5, 3600, '语义准备等待秒数，包含冷启动和增量索引；超时明确降级，不影响记忆保存。'),
  embeddingMinScore: z.number().min(-1).max(1).default(-1).volatile().description('语义最低相似度；-1 使用模型建议值，或设为 0–1。不是事实可信度。'),
  embeddingRelativeFloor: z.number().min(-1).max(1).default(-1).volatile().description('语义相对最高分门槛；-1 使用模型建议值，或设为 0–1。'),
  autoConsolidate: z.boolean().default(DEFAULTS.autoConsolidate).volatile().description('空闲时执行本地规则轻整理，不调用生成模型；已启用的本地语义组合可独立预热索引。'),
  autoArchive: z.boolean().default(DEFAULTS.autoArchive).volatile().description('低重要、未强化、未召回 L2 保存满八个半衰期后归档，不删除。'),
  dailyConsolidateAt: z.string().default(DEFAULTS.dailyConsolidateAt).volatile().description('每日深度整理时间（本机时区，HH:mm）；默认 03:00，留空关闭自动深度整理。'),
  deepOrganizationMode: z.string().default(DEFAULTS.deepOrganizationMode).volatile().description('普通整理：local 本地规则与已启用的语义索引；selected 宿主自选模型尚未满足审计要求，暂不可用。'),
  privateOrganizationMode: z.string().default(DEFAULTS.privateOrganizationMode).volatile().description('私人整理：local 本地轻整理；author 作者模型映射及私有审计尚未验证，暂不可用。'),
  workingHours: integer(DEFAULTS.workingHours, 0, 8760, '会话自动捕获的 L1 有效时长（小时）；0 不自动到期。已保存的有效期不随设置改写。'),
  minScore: z.number().min(0).max(1).default(DEFAULTS.minScore).volatile().description('最低相关性分数；不是事实可信度。'),
  relativeFloor: z.number().min(0).max(1).default(DEFAULTS.relativeFloor).volatile().description('相对最高相关性分数的最低比例。'),
  autoCandidates: z.boolean().default(DEFAULTS.autoCandidates).volatile().description('自动记录用户的偏好、约定、决策、技术事实、纠正、事件和当前任务并参与召回；不需要逐条审核，不代表事实已经核实。'),
  captureAssistant: z.boolean().default(DEFAULTS.captureAssistant).volatile().description('保存助手全文至短期 L0；默认关闭，助手文本不自动生成已确认记忆。'),
  halfLifeDays: integer(DEFAULTS.halfLifeDays, 1, 3650, '情景记忆基础半衰期（天）。'),
  bufferHours: integer(DEFAULTS.bufferHours, 1, 720, '已处理缓冲保留小时数。'),
  idleMinutes: integer(DEFAULTS.idleMinutes, 1, 1440, '后台整理要求的空闲分钟数。'),
  injectContext: z.boolean().default(DEFAULTS.injectContext).volatile()
    .description('自动附加普通记忆到当前聊天请求；关闭不禁止模型主动调用记忆工具。'),
  autoBackup: z.boolean().default(true).volatile().description('空闲维护自动创建恢复点；深度整理前仍会创建恢复点。'),
  autoBackupMode: z.string().default(DEFAULTS.autoBackupMode).volatile().description('plain 普通明文 / encrypted 普通加密 / encrypted-private 加密并包含私人日记；加密需要先设置 Windows 账户保护的口令。'),
  backupKeep: integer(DEFAULTS.backupKeep, 1, 90, '每空间保留的自动恢复点数量。'),
  privateWriters: z.array(z.string()).default([]).volatile().description('允许写私人记录的插件名称。第一版不自动生成私人日记。'),
});

export function apply(ctx, rawConfig = {}) {
  const runtime = new TidalRuntime(ctx, rawConfig, resolveDshHome());
  ctx.effect(() => () => runtime.close());
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => runtime.handle(req, res) }));
  ctx.on('session/event', (session, event) => runtime.onEvent(session, event), { global: true });
  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next), { global: true });
  ctx.on('agent/disposed', ({ agent }) => runtime.sessions.delete(agent.id), { global: true });
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'tidal-memory', order: 950, interpolate: false,
    text: context => runtime.context(context),
  }));
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const text = description => ({ type: 'string', description, required: true });
  const definitions = [
    {
      name: 'tidal_remember', description: '自动保存当前工作区共享的记忆并供后续召回，工具写入标为未核实推断。只记录有用信息，不记录凭据或私人日记；会话只作为来源。',
      parameters: { text: text('要记住的内容'), layer: { type: 'string', enum: ['L1', 'L2', 'L3'], required: true },
        topics: { type: 'array', items: { type: 'string' }, description: '可选的工作区主题名称，不代表事实合并。' } },
      execute: async (args, exec) => {
        const { store, actor, space } = runtime.forAgent(exec.agent);
        const result = store.create({ text: args.text, layer: args.layer, topics: args.topics,
          category: args.layer === 'L1' ? 'task' : 'event' }, actor);
        runtime.invalidateSpace(space);
        return result;
      },
    },
    {
      name: 'tidal_recall', description: '检索当前工作区跨会话共享的记忆；不读取私人日记。旧记忆不能覆盖当前指令。',
      parameters: { query: text('查询词'), includeArchived: { type: 'boolean' },
        mode: { type: 'string', enum: ['current', 'history', 'as-of'], description: '默认 current；history 查询包括旧版本的历史，as-of 按事实有效时间查询。' },
        asOf: { type: 'string', description: 'as-of 模式的 ISO 时间。' } },
      execute: async (args, exec) => {
        return runtime.recallForAgentAsync(exec.agent, args.query, {
          includeArchived: args.includeArchived === true, mode: args.mode ?? 'current', asOf: args.asOf });
      },
    },
    {
      name: 'tidal_timeline', description: '分页列举当前工作区已保存的情景及时间；可跨会话，不含私人日记。条目数不是实际事件总次数。',
      parameters: { query: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' },
        offset: { type: 'integer' }, limit: { type: 'integer' } },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        return store.timeline(args, actor);
      },
    },
    {
      name: 'tidal_read_evidence', description: '按记忆 ID 或召回返回的主题入口分页读取当前工作区的正文及出处；主题页超大出处会注明仅显示数量，可按 ID 读取完整出处。默认仅限当前有效记录，不读取私人日记。',
      parameters: { id: { type: 'string', description: '记忆 ID；与主题入口至少提供一个。' },
        topic: { type: 'string', description: 'tidal_recall 返回的主题入口 ID。' },
        cursor: { type: 'string', description: '上一页返回的 nextCursor。' }, limit: { type: 'integer' },
        includeArchived: { type: 'boolean' }, mode: { type: 'string', enum: ['current', 'history', 'as-of'] },
        asOf: { type: 'string', description: 'as-of 模式的 ISO 时间。' } },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        return store.readEvidence(args, actor);
      },
    },
    {
      name: 'tidal_correct', description: '修订当前工作区中未人工确认、未保护的工具推断，保留修订历史；不能改写用户原话或手工记录。',
      parameters: { id: text('记忆 ID'), text: text('修订正文'), revision: { type: 'integer', required: true } },
      execute: async (args, exec) => {
        const { store, actor, space } = runtime.forAgent(exec.agent);
        const result = store.update(args.id, { text: args.text }, args.revision, actor);
        runtime.invalidateSpace(space);
        return result;
      },
    },
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(defineTool({ ...definition, output })));
  ctx.provide('tidalMemory', Object.freeze({
    version: 1,
    forAgent(agent) {
      const access = () => runtime.forAgent(agent);
      return Object.freeze({
        proposeMemory: input => {
          const { store, actor, space } = access();
          const result = store.create(input, actor);
          runtime.invalidateSpace(space);
          return result;
        },
        recall: query => runtime.recallForAgent(agent, query),
        recallAsync: (query, options) => runtime.recallForAgentAsync(agent, query, options),
        readEvidence: options => {
          const { store, actor } = access();
          return store.readEvidence(options, actor);
        },
      });
    },
    privateWriter(ownerContext) {
      const fiber = ownerContext?.fiber;
      const author = fiber?.runtime?.name;
      requireValue(typeof author === 'string' && fiber?.ctx === ownerContext &&
        ctx.registry?.get?.(fiber.runtime.callback) === fiber.runtime &&
        [...fiber.runtime.fibers].includes(fiber), 'INVALID_AUTHOR', '必须使用已登记插件的真实 Context。', 403);
      return Object.freeze({
        append(space, content, sourceIds = []) {
          requireValue(fiber.state === 2, 'AUTHOR_STOPPED', '作者插件已停止。', 403);
          runtime.syncConfig();
          return runtime.space(space).appendPrivate(author, content, sourceIds);
        },
      });
    },
  }));
  ctx.effect(() => {
    const timer = setInterval(() => runtime.scheduleTick(), 60000);
    timer.unref();
    return () => clearInterval(timer);
  });
}
