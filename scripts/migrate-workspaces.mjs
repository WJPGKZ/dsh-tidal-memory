import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { canonicalCwd, configOf, requireValue } from '../src/model.js';
import { LOCAL_FOLDER, locations, prepareWorkspace, suggestedSpace } from '../src/workspace-storage.js';

// rc.5 desktop's file-backed workspace domain. Never list sessions or infer workspaces from folders.
const { values } = parseArgs({ options: { home: { type: 'string' }, apply: { type: 'boolean' } } });
requireValue(values.home && isAbsolute(values.home), 'INVALID_HOME', '使用 --home 指定已停机的 DSH_HOME；默认只预览。');
const profile = join(values.home, 'profiles', 'desktop');
const yaml = createRequire(join(profile, 'package.json'))('yaml');
const patch = yaml.parse(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'));
const matches = patch.filter(row => row.name === 'dsh-tidal-memory' && row.id === 'tidal-memory');
requireValue(matches.length === 1, 'PROFILE_CONFIG_INVALID', '找不到唯一桌面插件配置。');
const config = configOf(matches[0].config), root = config.dataRoot || join(values.home, 'tidal-memory');
const domain = JSON.parse(readFileSync(join(values.home, 'storages', 'workspace.json'), 'utf8'));
requireValue(domain.unit?.name === 'workspace' && domain.unit.version === 2 && domain.global?.initialized &&
  Array.isArray(domain.global.workspaceIds), 'REGISTRY_INVALID', '不支持此工作区目录；未进行迁移。');
const receipts = locations(root), reserved = new Set([...receipts.map(item => item.space),
  ...config.bindings.map(item => item.space),
  ...(existsSync(join(root, 'spaces')) ? readdirSync(join(root, 'spaces')) : [])]);
for (const id of domain.global.workspaceIds) {
  const cwd = domain.tables?.workspaces?.[id]?.path;
  requireValue(canonicalCwd(cwd), 'REGISTRY_INVALID', '登记的工作区路径无效。');
  const row = { id, cwd };
  const binding = config.bindings.find(item => item.workspaceId === id || (!item.workspaceId && canonicalCwd(item.cwd) === canonicalCwd(cwd)));
  const known = receipts.find(item => item.id === id);
  requireValue(!known || !binding || binding.space === known.space, 'WORKSPACE_CHANGED', '工作区和旧绑定的空间键不一致。');
  const space = known?.space ?? binding?.space ?? suggestedSpace(row, reserved);
  reserved.add(space);
  const legacy = existsSync(join(root, 'spaces', space));
  if (values.apply) prepareWorkspace(root, row, space, { migrate: true });
  console.log(JSON.stringify({ workspace: cwd, directory: join(cwd, LOCAL_FOLDER), space,
    legacy, applied: Boolean(values.apply) }));
}
