import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startPreview } from './preview.mjs';

const preview = await startPreview();
const candidates = [
  process.env.TIDAL_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = candidates.find(path => existsSync(path));
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(preview.url);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '潮汐记忆', exact: true }).click();
  await page.getByText('同工作区共享，不按会话分库', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '分层记忆' }).click();
  await page.getByText('测试工作区使用蓝色主题。', { exact: true }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('测试工作区使用绿色主题。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('UI 创建的跨会话共享记录');
  await page.getByLabel('状态', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('UI 创建的跨会话共享记录', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '私人日记' }).click();
  await page.getByText('私人记录，不展示正文', { exact: true }).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('PRIVATE_CANARY_SYNTHETIC_9038'), false);
  const privateResponse = await page.request.get(`${preview.url}/tidal-memory/private?space=default`);
  assert.equal((await privateResponse.text()).includes('PRIVATE_CANARY'), false);
  const rejected = await page.request.post(`${preview.url}/tidal-memory/memories`, { data: { text: 'csrf' } });
  assert.equal(rejected.status(), 403);
  await page.getByRole('tab', { name: '设置与迁移' }).click();
  await page.getByLabel('上下文预算（保守估算）').fill('2048');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  const status = await (await page.request.get(`${preview.url}/tidal-memory/status?space=default`)).json();
  assert.equal(status.data.config.tokenBudget, 2048);
  const shared = preview.runtime.space('default').all().find(r => r.text === 'UI 创建的跨会话共享记录');
  assert.equal(preview.runtime.space('default').get(shared.id, { sessionId: 'another-session' }).text, shared.text);
  await page.getByRole('tab', { name: '总览' }).click();
  await page.evaluate(() => document.documentElement.style.setProperty('--dsw-alias-label-primary', 'rgb(42, 53, 64)'));
  assert.equal(await page.locator('.tidal').evaluate(el => getComputedStyle(el).color), 'rgb(42, 53, 64)');
  mkdirSync('.preview', { recursive: true });
  await page.screenshot({ path: join('.preview', 'overview.png'), fullPage: true });
  await page.getByRole('combobox', { name: '记忆空间' }).selectOption('workspace-b');
  await page.getByRole('tab', { name: '分层记忆' }).click();
  await page.getByText('这一层还没有记忆。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Browser UI checks passed: CRUD, workspace sharing/isolation, settings, privacy, CSRF.');
} finally {
  await browser?.close();
  await preview.close();
}
