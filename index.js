import { hostModule } from './src/host-deps.js';
import { TidalRuntime, PREFIX } from './src/runtime.js';
import { DEFAULTS, requireValue } from './src/model.js';

const { default: z } = await hostModule('@deepseek-ai/schemastery');
const { defineTool } = await hostModule('@deepseek-ai/dsh-tools');
const { createUserMessage } = await hostModule('@deepseek-ai/dsh-llm');
const { resolveDshHome } = await hostModule('@deepseek-ai/dsh-home-paths');
export const name = 'dsh-tidal-memory';
export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'settings', 'webServer', 'connection', 'llm'];
export const provide = ['tidalMemory'];
const integer = (value, min, max, description) => z.number().step(1).min(min).max(max).default(value).volatile().description(description);
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('启用记忆捕获与召回。关闭后管理界面仍可使用。'),
  dataRoot: z.string().default('').description('绝对数据根目录。留空使用 DSH_HOME 下的 tidal-memory；修改需要重启并自行迁移。'),
  bindings: z.array(z.object({ cwd: z.string(), space: z.string() })).default([]).volatile().description('显式绑定工作区与空间，不自动共享其他工作区。'),
  tokenBudget: integer(DEFAULTS.tokenBudget, 256, 12000, '记忆上下文预算（使用 UTF-8 字节保守估算）。'),
  maxRecall: integer(DEFAULTS.maxRecall, 1, 20, '每次自动召回最多条数。'),
  halfLifeDays: integer(DEFAULTS.halfLifeDays, 1, 3650, '情景记忆基础半衰期（天）。'),
  bufferHours: integer(DEFAULTS.bufferHours, 1, 720, '已处理缓冲保留小时数。'),
  idleMinutes: integer(DEFAULTS.idleMinutes, 1, 1440, '后台整理要求的空闲分钟数。'),
  captureBatch: integer(DEFAULTS.captureBatch, 1, 100, '每批提炼的用户消息目标数。'),
  autoExtract: z.boolean().default(false).volatile().description('允许后台调用当前会话模型提炼候选，会发送选中的对话片段并消耗模型额度。'),
  maxModelCallsPerDay: integer(DEFAULTS.maxModelCallsPerDay, 0, 50, '每空间每天最多后台模型调用次数（UTC）。'),
  maxModelOutputTokens: integer(DEFAULTS.maxModelOutputTokens, 256, 8192, '每次提炼模型输出上限。'),
  autoBackup: z.boolean().default(true).volatile().description('自动创建不含私人日记的本地备份。'),
  backupKeep: integer(DEFAULTS.backupKeep, 1, 90, '每空间保留的自动恢复点数量。'),
  privateWriters: z.array(z.string()).default([]).volatile().description('允许写私人记录的插件名称。第一版不自动生成私人日记。'),
});

export function apply(ctx, rawConfig = {}) {
  const runtime = new TidalRuntime(ctx, rawConfig, resolveDshHome(), createUserMessage);
  ctx.effect(() => () => runtime.close());
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => runtime.handle(req, res) }));
  ctx.on('session/event', (session, event) => runtime.onEvent(session, event), { global: true });
  ctx.on('agent/disposed', ({ agent }) => runtime.sessions.delete(agent.id), { global: true });
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'tidal-memory', order: 950, interpolate: false,
    text: context => runtime.context(context),
  }));
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const text = description => ({ type: 'string', description, required: true });
  const definitions = [
    {
      name: 'tidal_remember', description: '提交当前工作区共享的记忆候选；候选不等于已确认事实。会话只作为来源。',
      parameters: { text: text('要记住的内容'), layer: { type: 'string', enum: ['L1', 'L2', 'L3'], required: true } },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        return store.create({ text: args.text, layer: args.layer, category: args.layer === 'L1' ? 'task' : 'event' }, actor);
      },
    },
    {
      name: 'tidal_recall', description: '检索当前工作区跨会话共享的记忆；不读取私人日记。旧记忆不能覆盖当前指令。',
      parameters: { query: text('查询词'), includeArchived: { type: 'boolean' } },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        return store.recall(args.query, actor, { includeArchived: args.includeArchived === true });
      },
    },
    {
      name: 'tidal_read_evidence', description: '读取当前可见记忆的出处，不读取任意本地路径或私人记录。',
      parameters: { id: text('记忆 ID') },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        const record = store.get(args.id, actor);
        return { id: record.id, sources: record.sources, occurredAt: record.occurredAt, kind: record.kind };
      },
    },
    {
      name: 'tidal_correct', description: '修改当前工作区的共享候选。已经确认的记忆必须在管理页纠正。',
      parameters: { id: text('记忆 ID'), text: text('修订正文'), revision: { type: 'integer', required: true } },
      execute: async (args, exec) => {
        const { store, actor } = runtime.forAgent(exec.agent);
        return store.update(args.id, { text: args.text }, args.revision, actor);
      },
    },
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(defineTool({ ...definition, output })));
  ctx.provide('tidalMemory', Object.freeze({
    version: 1,
    forAgent(agent) {
      const access = () => runtime.forAgent(agent);
      return Object.freeze({
        proposeMemory: input => { const { store, actor } = access(); return store.create(input, actor); },
        recall: query => { const { store, actor } = access(); return store.recall(query, actor); },
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
