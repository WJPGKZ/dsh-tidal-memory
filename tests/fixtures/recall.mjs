// Synthetic statements only. Semantic probes deliberately expose lexical limits.
export const facts = [
  ['theme', '界面主题使用蓝色，夜间降低亮度。', 'L3'],
  ['package', '项目包管理器使用 pnpm，不使用 npm。', 'L3'],
  ['port', '开发服务器的 HTTP 端口固定为 5173。', 'L3'],
  ['database', '本项目数据库采用 SQLite，文件写入使用 WAL。', 'L3'],
  ['concise', '回答偏好简短中文，不要冗长说明。', 'L3'],
  ['shell', '运行命令使用 PowerShell，避免 cmd 语法。', 'L3'],
  ['decision', '决定迁移构建缓存到本地磁盘。', 'L2'],
  ['task', '当前任务：发布前检查备份恢复。', 'L1'],
  ['tests', '单元测试使用 Node 内置测试运行器。', 'L3'],
  ['privacy', '私人日记不进入普通搜索和明文备份。', 'L3'],
  ['identifier', '代码标识符 FooBarClient 必须保持大小写。', 'L3'],
  ['layout', '设置页面继承宿主主题，不创建独立主题切换。', 'L3'],
];
export const probes = [
  ['蓝色 主题', ['theme']],
  ['包管理器 pnpm', ['package']],
  ['开发服务器 HTTP 端口 5173', ['port']],
  ['数据库 SQLite WAL', ['database']],
  ['回答 简短 中文', ['concise']],
  ['PowerShell 命令', ['shell']],
  ['迁移 构建 缓存 本地 磁盘', ['decision']],
  ['发布前 备份 恢复', ['task']],
  ['Node 单元测试', ['tests']],
  ['私人 日记 明文 备份', ['privacy']],
  ['FooBarClient', ['identifier']],
  ['设置 页面 宿主 主题', ['layout']],
  ['pnpm', ['package']],
  ['HTTP 5173', ['port']],
  ['蓝色', ['theme']],
  ['北京明天是否下雨', []],
  ['杭州到上海高铁票价', []],
  ['晚饭红烧茄子怎么做', []],
  ['项目 鹦鹉 羽毛 摄影', []],
  ['数据库 海豚 深海 潜水', []],
  ['日志 火星 探险 火箭', []],
  ['文档 咖啡 烘焙 咖啡豆', []],
  ['发布 香蕉 苹果 葡萄', []],
  ['任务 海浪 潮汐 沙滩', []],
  ['项目', []],
  ['别啰嗦', ['concise'], 'semantic'],
  ['给窗口换个配色', ['theme'], 'semantic'],
  ['落盘持久化选了什么引擎', ['database'], 'semantic'],
];
const noise = [
  '项目例行检查已经记录，等待周会确认。',
  '文档拼写修订已经排期，随后检查链接。',
  '日志归档按照例行流程进行，尚未发现异常。',
  '发布通知需要等待审批，不能提前发送。',
  '依赖清单已核对，后续继续检查许可证。',
  '任务进度需要重新核对，保留现有排期。',
  '数据库演练记录需要审核，稍后完成整理。',
  '测试结果需要人工复查，再更新汇总。',
];
export function corpus(count) {
  return [
    ...facts.map(([key, text, layer]) => ({ key, text, layer })),
    ...Array.from({ length: Math.max(0, count - facts.length) }, (_, index) => ({
      key: `noise-${index}`, text: `合成条目 ${index}：${noise[index % noise.length]}`,
      layer: index % 5 === 0 ? 'L1' : index % 5 === 1 ? 'L3' : 'L2',
    })),
  ];
}
