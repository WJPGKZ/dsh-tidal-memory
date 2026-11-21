import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { canonicalCwd, hash, LAYERS, MemoryError, requireValue, slug } from './model.js';

export const LOCAL_FOLDER = '.tidal-memory';
const marker = '.tidal-owner.json';
const ignore = '# Local DSH memories and private journals. Never commit.\n*\n';
const receiptDir = root => join(root, 'system', 'workspace-locations');
const receiptPath = (root, space) => join(receiptDir(root), `${slug(space)}.json`);
const stat = file => lstatSync(file, { throwIfNoEntry: false });
const fail = (code, message) => { throw new MemoryError(code, message, 409); };
const samePath = (a, b) => canonicalCwd(a) === canonicalCwd(b);
const inside = (file, dir) => samePath(file, dir) || canonicalCwd(file).startsWith(canonicalCwd(dir) + (process.platform === 'win32' ? '\\' : '/'));
let sid;
function protect(dir) {
  if (process.platform !== 'win32') return;
  const sys = join(process.env.SystemRoot, 'System32');
  if (!sid) {
    const user = spawnSync(join(sys, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    if (user.status === 0) sid = user.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
  }
  const acl = sid && spawnSync(join(sys, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r',
    ...[sid, 'S-1-5-18', 'S-1-5-32-544'].map(s => `*${s}:(OI)(CI)F`)], { windowsHide: true });
  requireValue(acl?.status === 0, 'WORKSPACE_ACL_UNAVAILABLE', '无法限制记忆目录的本机访问权限；未写入数据。', 409);
}

export function readLocation(root, space) {
  const file = receiptPath(root, space), info = stat(file);
  if (!info) return null;
  requireValue(info.isFile() && !info.isSymbolicLink(), 'WORKSPACE_RECEIPT_INVALID', '工作区位置登记无效。', 409);
  const row = JSON.parse(readFileSync(file, 'utf8'));
  requireValue(row?.version === 1 && row.space === space && canonicalCwd(row.cwd) && typeof row.id === 'string' &&
    typeof row.token === 'string' && row.token.length === 36, 'WORKSPACE_RECEIPT_INVALID', '工作区位置登记不完整。', 409);
  return row;
}
export function locations(root) {
  const dir = receiptDir(root);
  return existsSync(dir) ? readdirSync(dir).filter(n => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(n))
    .map(n => readLocation(root, n.slice(0, -5))) : [];
}
function workspaceRoot(root, cwd) {
  requireValue(canonicalCwd(cwd) && stat(cwd)?.isDirectory() && samePath(realpathSync.native(cwd), cwd) &&
    !inside(cwd, root) && !cwd.split(/[\\/]/).includes(LOCAL_FOLDER),
  'WORKSPACE_PATH_UNAVAILABLE', '工作区目录不存在、已重定向或与记忆系统目录冲突；未新建工作区。', 409);
  return join(cwd, LOCAL_FOLDER);
}
function checkGit(cwd) {
  for (let p = cwd;; p = dirname(p)) {
    if (stat(join(p, '.git'))) {
      const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'ls-files', '-z', '--', LOCAL_FOLDER],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      requireValue(result.status === 0 && result.stdout === '', 'WORKSPACE_GIT_TRACKED',
        '无法确认记忆目录未被 Git 跟踪；请先检查仓库，未写入私人数据。', 409);
      break;
    }
    if (dirname(p) === p) break;
  }
}
function digest(file) {
  const h = createHash('sha256'), buf = Buffer.alloc(256 * 1024), fd = openSync(file, 'r');
  try { for (let n; (n = readSync(fd, buf)) > 0;) h.update(buf.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest('hex');
}
function visit(dir, fn) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name), s = lstatSync(full);
    requireValue(!s.isSymbolicLink() && (s.isDirectory() || (s.isFile() && s.nlink === 1)),
      'WORKSPACE_UNSAFE_FILE', '记忆目录含链接或特殊文件，已停止。', 409);
    fn(full, s);
    if (s.isDirectory()) visit(full, fn);
  }
}
function verifyOwned(target, receipt, deep) {
  requireValue(stat(target)?.isDirectory() && samePath(realpathSync.native(target), target) &&
    stat(join(target, marker))?.isFile() && stat(join(target, '.gitignore'))?.isFile() &&
    readFileSync(join(target, '.gitignore'), 'utf8') === ignore &&
    readFileSync(join(target, marker), 'utf8') === JSON.stringify(receipt),
  'WORKSPACE_FOLDER_CONFLICT', '此工作区已有未匹配的记忆目录；不会打开、合并或覆盖它。', 409);
  if (deep) visit(target, () => {});
}
export function verifiedLocalDirectory(root, row, space, deep = false) {
  const target = workspaceRoot(root, row.cwd), receipt = readLocation(root, space);
  requireValue(receipt?.id === row.id && samePath(receipt.cwd, row.cwd), 'WORKSPACE_CHANGED',
    '工作区身份或位置已变化；记忆读写已暂停。', 409);
  if (stat(join(root, 'spaces', space))) fail('WORKSPACE_MIGRATION_REQUIRED', '旧记忆仍在集中目录；须在 DSH 退出后迁移，未开启第二个写入位置。');
  verifyOwned(target, receipt, deep);
  return target;
}

// Registration never consumes a directory supplied by a project or picks up another workspace's identity.
export function prepareWorkspace(root, row, space, { migrate = false } = {}) {
  slug(space);
  const target = workspaceRoot(root, row.cwd), old = join(root, 'spaces', space);
  let receipt = readLocation(root, space);
  if (receipt && (receipt.id !== row.id || !samePath(receipt.cwd, row.cwd)))
    fail('WORKSPACE_CHANGED', '空间已登记给另一工作区；未重新绑定。');
  if (stat(target)) {
    if (!receipt) fail('WORKSPACE_FOLDER_CONFLICT', '工作区已有未登记的 .tidal-memory；不会接管或覆盖。');
    return verifiedLocalDirectory(root, row, space, true);
  }
  if (receipt && !stat(old)) fail('WORKSPACE_FOLDER_MISSING', '已登记的记忆目录不在原位，未用空库替代。');
  if (stat(old) && !migrate)
    fail('WORKSPACE_MIGRATION_REQUIRED', '已有旧记忆；请在 DSH 退出时迁移，未创建空库。');
  checkGit(row.cwd);
  const newReceipt = !receipt;
  if (newReceipt) {
    receipt = { version: 1, id: row.id, cwd: row.cwd, space, token: randomUUID() };
    mkdirSync(receiptDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath(root, space), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  }
  let stage, lock, retired, published = false;
  try {
    stage = mkdtempSync(join(row.cwd, `${LOCAL_FOLDER}-init-`));
    protect(stage);
    writeFileSync(join(stage, '.gitignore'), ignore, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(stage, marker), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    if (stat(old)) {
      requireValue(stat(old).isDirectory() && samePath(realpathSync.native(old), old), 'WORKSPACE_UNSAFE_FILE', '旧库根目录是链接，未迁移。', 409);
      visit(old, () => {});
      requireValue(!stat(join(old, marker)) && !stat(join(old, '.gitignore')), 'WORKSPACE_FOLDER_CONFLICT', '旧库含冲突标记，未迁移。', 409);
      const owner = join(old, 'system', 'owner.sqlite3');
      requireValue(stat(owner)?.isFile(), 'WORKSPACE_MIGRATION_REQUIRED', '旧库缺少写锁文件；不能确认可安全离线迁移。', 409);
      lock = new DatabaseSync(owner);
      try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
      catch { fail('SPACE_BUSY', '旧库有活动写入者；请先退出 DSH。'); }
      visit(old, (file, s) => {
        const dst = join(stage, relative(old, file));
        if (s.isDirectory()) mkdirSync(dst, { mode: 0o700 });
        else {
          copyFileSync(file, dst);
          requireValue(digest(file) === digest(dst), 'WORKSPACE_COPY_FAILED', '迁移副本校验失败；原库保留。', 409);
        }
      });
    }
    for (const dir of [...Object.values(LAYERS).map(layer => layer.directory), 'private', 'indexes', 'system'])
      mkdirSync(join(stage, dir), { recursive: true, mode: 0o700 });
    checkGit(row.cwd);
    requireValue(!stat(target), 'WORKSPACE_FOLDER_CONFLICT', '迁移期间目标目录发生变化。', 409);
    // Keep a verified cold recovery copy on the original volume; never leave two active locations.
    if (lock) {
      lock.close(); lock = null;
      const recovery = join(root, 'recovery', `pre-workspace-${receipt.token}`);
      mkdirSync(dirname(recovery), { recursive: true, mode: 0o700 });
      renameSync(old, recovery); retired = recovery;
    }
    renameSync(stage, target); published = true;
    return target;
  } finally {
    lock?.close();
    if (!published) {
      if (retired) renameSync(retired, old);
      if (stage) rmSync(stage, { recursive: true, force: true });
      if (newReceipt && !stat(target)) rmSync(receiptPath(root, space), { force: true });
    }
  }
}
export function suggestedSpace(row, occupied) {
  const prefix = `mem-${hash(row.id).slice(0, 12)}`;
  let key = prefix;
  for (let i = 2; occupied.has(key); i++) key = `${prefix}-${i}`;
  return key;
}
