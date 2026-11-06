import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicFile } from './database.js';
import { MemoryError, requireValue, string } from './model.js';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const automaticKeyPath = root => join(root, 'secrets', 'automatic-backup.dpapi');
export function automaticKeyStatus(root) {
  const path = automaticKeyPath(root);
  return { path, supported: process.platform === 'win32' && existsSync(powershell), configured: existsSync(path) };
}
function dpapi(operation, bytes) {
  requireValue(process.platform === 'win32' && existsSync(powershell), 'BACKUP_KEY_UNSUPPORTED',
    '自动加密口令保护目前仅支持 Windows 当前用户 DPAPI；不会改用明文备份。', 503);
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
try {
  $result=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
} finally {
  [Array]::Clear($inputBytes,0,$inputBytes.Length)
  if ($result) { [Array]::Clear($result,0,$result.Length) }
}`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16384,
  });
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const failure = result.error?.code === 'ETIMEDOUT' ? '响应超时' :
    result.error ? '程序无法启动' : result.status !== 0 ? '程序执行失败' :
      !/^[A-Za-z0-9+/]+={0,2}$/.test(output) ? '程序返回无效格式' : null;
  if (failure) throw new MemoryError('BACKUP_KEY_UNAVAILABLE',
    `Windows 账户口令保护${failure}；未写入明文备份。`, 503);
  return Buffer.from(output, 'base64');
}
function validPassword(password) {
  string(password, '自动备份口令', 256);
  requireValue(password.length >= 12, 'WEAK_PASSWORD', '自动加密口令至少 12 个字符，需自行离线保管。');
}
export function saveAutomaticKey(root, password) {
  validPassword(password);
  const plain = Buffer.from(password, 'utf8');
  let reopened;
  try {
    const sealed = dpapi('protect', plain);
    reopened = dpapi('unprotect', sealed);
    requireValue(plain.length === reopened.length && timingSafeEqual(plain, reopened),
      'BACKUP_KEY_UNAVAILABLE', 'Windows 账户口令保护验证失败；原设置未改变。', 503);
    const id = randomUUID();
    atomicFile(automaticKeyPath(root), JSON.stringify({ format: 'tidal-windows-dpapi', version: 1,
      id, protected: sealed.toString('base64') }));
    return { saved: true, ...automaticKeyStatus(root) };
  } finally {
    plain.fill(0);
    reopened?.fill(0);
  }
}
export function readAutomaticKey(root) {
  const state = automaticKeyStatus(root);
  requireValue(state.supported, 'BACKUP_KEY_UNSUPPORTED',
    '自动加密口令保护目前仅支持 Windows 当前用户 DPAPI；不会改用明文备份。', 503);
  requireValue(state.configured, 'BACKUP_KEY_UNAVAILABLE', '未设置自动加密口令；不会改用明文备份。', 503);
  let document;
  try { document = JSON.parse(readFileSync(state.path, 'utf8')); }
  catch { throw new MemoryError('BACKUP_KEY_UNAVAILABLE', '无法读取受保护的自动备份口令；不会改用明文备份。', 503); }
  requireValue(document?.format === 'tidal-windows-dpapi' && document.version === 1 &&
    typeof document.id === 'string' && /^[a-f0-9-]{36}$/.test(document.id) &&
    typeof document.protected === 'string' && document.protected.length <= 16384 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(document.protected),
  'BACKUP_KEY_UNAVAILABLE', '受保护的自动备份口令格式无效；不会改用明文备份。', 503);
  const plain = dpapi('unprotect', Buffer.from(document.protected, 'base64'));
  try {
    const password = plain.toString('utf8');
    validPassword(password);
    return { id: document.id, password };
  } finally { plain.fill(0); }
}
