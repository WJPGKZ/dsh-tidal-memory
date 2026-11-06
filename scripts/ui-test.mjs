import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startPreview } from './preview.mjs';
import { MemorySpace } from '../src/store.js';
import { unpackBackup } from '../src/transfer.js';

const preview = await startPreview();
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const candidates = [
  process.env.TIDAL_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = candidates.find(path => existsSync(path));
let browser;
let owner;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(preview.url);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '潮汐记忆', exact: true }).click();
  await page.getByText('同工作区共享，不按会话分库', { exact: true }).waitFor();
  await page.waitForFunction(expected =>
    document.querySelector('.tidal .brand .version')?.textContent === expected, `v${packageVersion}`);
  await page.getByRole('tab', { name: '分层记忆' }).click();
  await page.getByText('测试工作区使用蓝色主题。', { exact: true }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('测试工作区使用绿色主题。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await page.getByRole('button', { name: '激活与生命周期', exact: true }).click();
  await page.getByText('激活是排序线索，不是事实可信度。', { exact: true }).waitFor();
  await page.getByLabel('状态', { exact: true }).selectOption('archived');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '激活与生命周期', exact: true }).click();
  await page.getByText(/归档原因：人工归档/).waitFor();
  await page.getByRole('button', { name: '撤销归档', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已撤销归档' }).waitFor();
  assert.equal(await page.getByLabel('状态', { exact: true }).inputValue(), 'active');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('UI 创建的跨会话共享记录');
  await page.getByLabel('主题（逗号分隔，用于关联和检索，不改变层级）').fill('人工体验,项目导航');
  await page.getByLabel('实体别名（逗号分隔，仅当前工作区）').fill('别名一,别名二');
  await page.getByLabel('状态', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('UI 创建的跨会话共享记录', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '私人日记' }).click();
  await page.getByText('私人记录，不展示正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('私人日记整理方式').inputValue(), 'local');
  assert.equal(await page.getByRole('option', { name: /调用作者自己的模型/ }).evaluate(option => option.disabled), true);
  await page.getByRole('button', { name: '重试私人轻整理', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '私人轻整理完成' }).waitFor();
  const writers = page.getByLabel('允许的作者插件名称（逗号分隔）');
  await writers.fill('');
  await writers.pressSequentially('demo-author,second-author');
  assert.equal(await writers.inputValue(), 'demo-author,second-author');
  await page.getByRole('button', { name: '保存作者权限', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  assert.deepEqual(preview.runtime.config.privateWriters, ['demo-author', 'second-author']);
  assert.equal((await page.locator('body').innerText()).includes('PRIVATE_CANARY_SYNTHETIC_9038'), false);
  const privateResponse = await page.request.get(`${preview.url}/tidal-memory/private?space=default`);
  assert.equal((await privateResponse.text()).includes('PRIVATE_CANARY'), false);
  const rejected = await page.request.post(`${preview.url}/tidal-memory/memories`, { data: { text: 'csrf' } });
  assert.equal(rejected.status(), 403);
  await page.getByRole('tab', { name: '设置与迁移' }).click();
  await page.getByText(/工作区名称尽量使用英文/).waitFor();
  assert.equal(await page.getByLabel('普通深度整理方式').inputValue(), 'local');
  assert.equal(await page.getByRole('option', { name: /宿主自选模型/ }).evaluate(option => option.disabled), true);
  await page.getByRole('heading', { name: '文件位置', exact: true }).waitFor();
  await page.getByText('当前空间的派生主题索引', { exact: true }).waitFor();
  await page.getByText('自动备份受保护口令', { exact: true }).waitFor();
  await page.getByText('同谱系恢复的遗忘标记（无正文）', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '模型文件与下载', exact: true }).waitFor();
  const backupMode = page.getByLabel('自动恢复点方式');
  assert.equal(await backupMode.inputValue(), 'plain');
  const password = 'synthetic-ui-offline-password-123';
  if (process.platform === 'win32') {
    await backupMode.selectOption('encrypted-private');
    await page.getByRole('button', { name: '保存自动备份方式', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未设置自动加密口令' }).waitFor();
    await page.getByLabel('设置自动备份口令（至少 12 字符）').fill(password);
    await page.getByRole('button', { name: '保存受保护的自动备份口令', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '请离线保存原口令' }).waitFor();
    assert.equal(await page.getByLabel('设置自动备份口令（至少 12 字符）').inputValue(), '');
    await backupMode.selectOption('encrypted-private');
    await page.getByRole('button', { name: '保存自动备份方式', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
    assert.equal(preview.runtime.config.autoBackupMode, 'encrypted-private');
  } else {
    assert.equal(await page.getByRole('option', { name: '加密普通记忆和私人日记' }).isDisabled(), true);
  }
  await page.getByText(/空间空闲时只为已启用的本地语义组合准备普通索引/).waitFor();
  assert.equal(await page.getByRole('link', { name: '查看固定版本的模型下载来源' }).count(), 2);
  await page.getByLabel('本地语义组合', { exact: true }).selectOption('cpu');
  await page.getByRole('button', { name: '保存语义设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  await page.getByRole('button', { name: '准备本地语义索引', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /本地模型尚未安装/ }).first().waitFor();
  await page.getByLabel('本地语义组合', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: '保存语义设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  await page.getByLabel('总预算（UTF-8 字节估算）').fill('48000');
  await page.getByLabel('L3 常驻范围').selectOption('core');
  await page.getByLabel('近期用户消息窗口').fill('4');
  await page.getByLabel('L1 工作记忆有效时长（小时，0 不自动到期）').fill('48');
  await page.getByLabel('每日深度整理时间（本机时间，留空关闭）').fill('04:30');
  assert.equal(await page.getByLabel('自动记录并召回用户陈述（本地规则，无需审核）').isChecked(), true);
  assert.equal(await page.getByLabel('额外保存助手全文到短期 L0（默认关闭）').isChecked(), false);
  await page.getByLabel('最低相关性分数').fill('0.5');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  const status = await (await page.request.get(`${preview.url}/tidal-memory/status?space=default`)).json();
  assert.equal(status.data.config.tokenBudget, 48000);
  assert.equal(status.data.config.residentMode, 'core');
  assert.equal(status.data.config.contextMessages, 4);
  assert.equal(status.data.config.workingHours, 48);
  assert.equal(status.data.config.dailyConsolidateAt, '04:30');
  assert.equal(status.data.config.minScore, 0.5);
  await page.getByRole('button', { name: '立即深度整理一次' }).click();
  await page.getByRole('status').filter({ hasText: '深度整理完成' }).waitFor();
  await page.getByText(/上次深度整理：.*手动.*提炼/).waitFor();
  if (process.platform === 'win32') {
    const directory = join(preview.runtime.root, 'backups', 'default');
    const encrypted = readdirSync(directory).find(name => name.endsWith('.encrypted.json'));
    assert.ok(encrypted);
    const backup = readFileSync(join(directory, encrypted));
    assert.equal(backup.includes(Buffer.from('PRIVATE_CANARY_SYNTHETIC_9038')), false);
    assert.equal(unpackBackup(backup.toString('utf8'), password).privateEntries.length, 1);
    await page.getByLabel('恢复到新空间（不得与现有空间重名）').fill('ui-recovered');
    await page.getByLabel('选择备份文件').setInputFiles({
      name: 'synthetic.encrypted', mimeType: 'application/octet-stream', buffer: backup,
    });
    await page.getByLabel('手动备份 / 恢复口令（至少 12 字符；手动加密备份包含私人记录）').fill('incorrect-synthetic-password');
    await page.getByRole('button', { name: '恢复到新空间', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '备份口令错误或加密文件已损坏' }).waitFor();
    await page.getByLabel('手动备份 / 恢复口令（至少 12 字符；手动加密备份包含私人记录）').fill(password);
    await page.getByRole('button', { name: '恢复到新空间', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已恢复到 ui-recovered' }).waitFor();
    await page.getByText(/已应用本机同谱系遗忘标记/).waitFor();
    assert.equal(preview.runtime.space('ui-recovered').privateStatus().count, 1);
  }
  await page.getByRole('button', { name: '重建搜索索引', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '搜索索引已重建' }).waitFor();
  await page.getByRole('tab', { name: '回忆与整理' }).click();
  await page.getByRole('textbox', { name: '检索内容' }).fill('UI 创建的跨会话共享记录');
  await page.getByRole('button', { name: '普通召回' }).click();
  await page.getByText('按需查看关联主题', { exact: true }).waitFor();
  await page.getByRole('button', { name: '人工体验 · 1 条', exact: true }).click();
  await page.getByText(/ID .* · 1 个出处/).waitFor();
  await page.getByText('查看出处', { exact: true }).click();
  await page.getByText(/"kind": "manual"/).waitFor();
  const store = preview.runtime.space('default');
  const large = store.create({ layer: 'L2', text: 'UI 验证大来源展示', status: 'active', topics: ['多出处'] },
    { admin: true });
  const sources = Array.from({ length: 1100 }, (_, index) =>
    ({ kind: 'manual', id: `evidence-${index}`, excerpt: 'x'.repeat(1000) }));
  store.persist({ ...large, sources, revision: large.revision + 1 });
  await page.getByRole('textbox', { name: '检索内容' }).fill('UI 验证大来源展示');
  await page.getByRole('button', { name: '普通召回' }).click();
  await page.getByRole('button', { name: '多出处 · 1 条', exact: true }).click();
  await page.getByText(/1100 个出处（本页仅显示数量）/).waitFor();
  await page.getByRole('button', { name: '读取完整出处', exact: true }).click();
  await page.getByText('查看出处', { exact: true }).click();
  await page.getByText(/"id": "evidence-1099"/).waitFor();
  await page.getByRole('textbox', { name: '检索内容' }).fill('unique query with no saved match');
  await page.getByRole('button', { name: '普通召回' }).click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.tidal button')].find(item => item.textContent === '普通召回');
    return button && !button.disabled;
  });
  await page.getByRole('tab', { name: '总览' }).click();
  await page.getByRole('tab', { name: '回忆与整理' }).click();
  await page.locator('.tidal .panel details').first().locator('summary').click();
  await page.getByText(/没有查询匹配；仍附带/).waitFor();
  const shared = preview.runtime.space('default').all().find(r => r.text === 'UI 创建的跨会话共享记录');
  assert.equal(shared.status, 'active');
  assert.deepEqual(shared.topics, ['人工体验', '项目导航']);
  assert.deepEqual(shared.aliases, ['别名一', '别名二']);
  assert.equal(preview.runtime.space('default').get(shared.id, { sessionId: 'another-session' }).text, shared.text);
  await page.getByRole('tab', { name: '总览' }).click();
  await page.evaluate(() => document.documentElement.style.setProperty('--dsw-alias-label-primary', 'rgb(42, 53, 64)'));
  assert.equal(await page.locator('.tidal').evaluate(el => getComputedStyle(el).color), 'rgb(42, 53, 64)');
  mkdirSync('.preview', { recursive: true });
  await page.screenshot({ path: join('.preview', 'overview.png'), fullPage: true });
  await page.getByRole('combobox', { name: '记忆空间' }).selectOption('workspace-b');
  await page.getByRole('tab', { name: '分层记忆' }).click();
  await page.getByText('这一层还没有记忆。', { exact: true }).waitFor();
  owner = new MemorySpace(preview.runtime.root, 'contended');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('combobox', { name: '记忆空间' }).selectOption('contended');
  await page.getByText('当前空间不可用，未保存或召回记忆', { exact: true }).waitFor();
  owner.close();
  await page.getByRole('button', { name: '重试打开空间', exact: true }).click();
  await page.getByText('当前空间不可用，未保存或召回记忆', { exact: true }).waitFor({ state: 'hidden' });
  preview.runtime.rawConfig.bindings = preview.runtime.rawConfig.bindings.filter(binding => binding.space === 'workspace-b');
  preview.runtime.space('workspace-b').appendPrivate('demo-author', 'PRIVATE_SINGLE_SPACE_CANARY');
  const singleSpacePage = await browser.newPage();
  singleSpacePage.on('pageerror', error => errors.push(error.message));
  await singleSpacePage.goto(preview.url);
  await singleSpacePage.getByRole('button', { name: '设置', exact: true }).click();
  await singleSpacePage.getByRole('button', { name: '潮汐记忆', exact: true }).click();
  await singleSpacePage.waitForFunction(() =>
    document.querySelector('select[aria-label="记忆空间"]')?.value === 'workspace-b');
  await singleSpacePage.getByRole('tab', { name: '私人日记' }).click();
  await singleSpacePage.getByText(/^1 篇 ·/).waitFor();
  assert.equal((await singleSpacePage.locator('body').innerText()).includes('PRIVATE_SINGLE_SPACE_CANARY'), false);
  await singleSpacePage.getByRole('combobox', { name: '记忆空间' }).selectOption('default');
  await singleSpacePage.getByRole('button', { name: '刷新', exact: true }).click();
  await singleSpacePage.getByText('空间：default', { exact: true }).waitFor();
  assert.equal(await singleSpacePage.getByRole('combobox', { name: '记忆空间' }).inputValue(), 'default');
  await singleSpacePage.close();
  const unavailablePage = await browser.newPage();
  unavailablePage.on('pageerror', error => errors.push(error.message));
  await unavailablePage.route('**/tidal-memory/status?*', route => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { message: 'synthetic status unavailable' } }),
  }));
  await unavailablePage.goto(preview.url);
  await unavailablePage.getByRole('button', { name: '设置', exact: true }).click();
  await unavailablePage.getByRole('button', { name: '潮汐记忆', exact: true }).click();
  await unavailablePage.getByRole('alert').filter({ hasText: 'synthetic status unavailable' }).waitFor();
  assert.equal(await unavailablePage.locator('.tidal .brand .version').innerText(), '版本未知');
  await unavailablePage.close();
  assert.deepEqual(errors, []);
  console.log('Browser UI checks passed: CRUD, workspace sharing/isolation, settings, privacy, index repair, lock retry, CSRF.');
} finally {
  owner?.close();
  await browser?.close();
  await preview.close();
}
