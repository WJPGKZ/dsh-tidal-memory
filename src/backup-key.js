import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicFile } from './database.js';
import { MemoryError, requireValue, string } from './model.js';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const automaticKeyPath = root => join(root, 'secrets', 'automatic-backup.dpapi');
export const modelApiKeyPath = root => join(root, 'secrets', 'deep-organization-api.dpapi');
export function automaticKeyStatus(root) {
  const path = automaticKeyPath(root);
  return { path, supported: process.platform === 'win32' && existsSync(powershell), configured: existsSync(path) };
}
function dpapi(operation, bytes, purpose = 'backup') {
  const isModelKey = purpose === 'model';
  const unsupportedCode = isModelKey ? 'MODEL_API_KEY_UNSUPPORTED' : 'BACKUP_KEY_UNSUPPORTED';
  const unavailableCode = isModelKey ? 'MODEL_API_KEY_UNAVAILABLE' : 'BACKUP_KEY_UNAVAILABLE';
  const description = isModelKey ? '整理 API 密钥' : '自动加密口令';
  requireValue(process.platform === 'win32' && existsSync(powershell), unsupportedCode,
    isModelKey ? 'API 密钥仅支持 Windows 当前用户 DPAPI 保护；未改用明文存储。' :
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
  if (failure) throw new MemoryError(unavailableCode,
    `Windows 账户口令保护${failure}；${isModelKey ? '未保存或读取 API 密钥。' : '未写入明文备份。'}`, 503);
  return Buffer.from(output, 'base64');
}
export function modelApiKeyStatus(root) {
  return { path: modelApiKeyPath(root), supported: process.platform === 'win32' && existsSync(powershell),
    configured: existsSync(modelApiKeyPath(root)) };
}
export function saveModelApiKey(root, value) {
  const secret = string(value, '整理 API 密钥', 4096);
  requireValue(secret.length >= 8, 'INVALID_MODEL_API_KEY', '整理 API 密钥长度无效。');
  const plain = Buffer.from(secret, 'utf8');
  let sealed;
  try {
    sealed = dpapi('protect', plain, 'model');
    const reopened = dpapi('unprotect', sealed, 'model');
    try {
      requireValue(plain.length === reopened.length && timingSafeEqual(plain, reopened),
        'MODEL_API_KEY_UNAVAILABLE', 'Windows 账户口令保护验证失败；API 密钥未保存。', 503);
    } finally { reopened.fill(0); }
    atomicFile(modelApiKeyPath(root), JSON.stringify({ format: 'tidal-windows-dpapi',
      version: 1, protected: sealed.toString('base64') }));
    return { saved: true, ...modelApiKeyStatus(root) };
  } finally { plain.fill(0); sealed?.fill(0); }
}
export function readModelApiKey(root) {
  const state = modelApiKeyStatus(root);
  requireValue(state.supported, 'MODEL_API_KEY_UNSUPPORTED',
    'API 密钥仅支持 Windows 当前用户 DPAPI 保护；未改用明文存储。', 503);
  requireValue(state.configured, 'MODEL_API_KEY_UNAVAILABLE', '尚未保存整理 API 密钥。', 503);
  let document;
  try { document = JSON.parse(readFileSync(state.path, 'utf8')); }
  catch { throw new MemoryError('MODEL_API_KEY_UNAVAILABLE', '无法读取受保护的整理 API 密钥。', 503); }
  requireValue(document?.format === 'tidal-windows-dpapi' && document.version === 1 &&
    typeof document.protected === 'string' && document.protected.length <= 16384 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(document.protected),
  'MODEL_API_KEY_UNAVAILABLE', '受保护的整理 API 密钥格式无效。', 503);
  return dpapi('unprotect', Buffer.from(document.protected, 'base64'), 'model');
}
export function clearModelApiKey(root) {
  const state = modelApiKeyStatus(root);
  if (state.configured) rmSync(state.path, { force: true });
  return modelApiKeyStatus(root);
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
