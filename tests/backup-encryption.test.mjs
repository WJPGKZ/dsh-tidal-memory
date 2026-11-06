import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySpace } from '../src/store.js';
import { automaticKeyPath, automaticKeyStatus, readAutomaticKey, saveAutomaticKey } from '../src/backup-key.js';
import { automaticBackup, restoreBackup, unpackBackup } from '../src/transfer.js';

const admin = { admin: true };
const password = 'synthetic-offline-password-123';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-encrypted-'));
  const offline = mkdtempSync(join(tmpdir(), 'tidal-offline-'));
  const spaces = [];
  const open = (base, name, config = {}) => {
    const space = new MemorySpace(base, name, { config: { privateWriters: ['test-author'], ...config } });
    spaces.push(space);
    return space;
  };
  t.after(() => {
    for (const space of spaces) space.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(offline, { recursive: true, force: true });
  });
  return { root, offline, open, space: open(root, 'shared') };
}

test('encrypted automatic backup fails closed when protected key is unavailable', t => {
  const { root, space } = fixture(t);
  space.create({ layer: 'L2', text: 'BACKUP_NORMAL_CANARY' }, admin);
  space.setConfig({ ...space.config, autoBackupMode: 'encrypted-private' });
  assert.throws(() => automaticBackup(space, root, { force: true }),
    error => ['BACKUP_KEY_UNAVAILABLE', 'BACKUP_KEY_UNSUPPORTED'].includes(error.code));
  assert.equal(existsSync(join(root, 'backups', 'shared')), false);
  assert.throws(() => saveAutomaticKey(root, 'short'), { code: 'WEAK_PASSWORD' });
});

test('Windows DPAPI failures are classified without leaking secrets or replacing an existing key', {
  skip: process.platform !== 'win32',
}, t => {
  const { root, space } = fixture(t);
  const keyPath = automaticKeyPath(root);
  const previous = JSON.stringify({ format: 'tidal-windows-dpapi', version: 1,
    id: '00000000-0000-0000-0000-000000000000', protected: 'AA==' });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(keyPath, previous);
  space.setConfig({ ...space.config, autoBackupMode: 'encrypted-private' });
  let result;
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (_command, _args, options) => {
    calls++;
    assert.equal(options.timeout, 30000);
    return typeof result === 'function' ? result(calls) : result;
  });
  syncBuiltinESMExports();
  try {
    for (const [failure, reason] of [
      [{ error: { code: 'ETIMEDOUT' }, status: null, stdout: null }, '响应超时'],
      [{ error: { code: 'EACCES' }, status: null, stdout: null }, '程序无法启动'],
      [{ status: 1, stdout: '', stderr: password }, '程序执行失败'],
      [{ status: 0, stdout: `invalid:${password}`, stderr: '' }, '程序返回无效格式'],
    ]) {
      result = failure;
      const check = error => error.code === 'BACKUP_KEY_UNAVAILABLE' && error.status === 503 &&
        error.message.includes(reason) && !error.message.includes(password);
      assert.throws(() => saveAutomaticKey(root, password), check);
      assert.equal(readFileSync(keyPath, 'utf8'), previous);
      assert.throws(() => automaticBackup(space, root, { force: true }), check);
      assert.equal(existsSync(join(root, 'backups', 'shared')), false);
    }
    calls = 0;
    result = call => call === 1 ? { status: 0, stdout: 'AA==' } :
      { error: { code: 'ETIMEDOUT' }, status: null, stdout: null };
    assert.throws(() => saveAutomaticKey(root, password), /响应超时/);
    assert.equal(calls, 2);
    assert.equal(readFileSync(keyPath, 'utf8'), previous);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Windows DPAPI automatic backups preserve old plaintext and restore offline with only the passphrase', {
  skip: process.platform !== 'win32',
}, t => {
  const { root, offline, open, space } = fixture(t);
  const saved = space.create({ layer: 'L2', text: 'BACKUP_NORMAL_CANARY', topics: ['orchid'] }, admin);
  space.appendPrivate('test-author', 'BACKUP_PRIVATE_CANARY');
  const plaintext = automaticBackup(space, root, { force: true });
  const keyStatus = saveAutomaticKey(root, password);
  assert.equal(keyStatus.supported, true);
  assert.equal(keyStatus.configured, true);
  assert.equal(readFileSync(automaticKeyPath(root), 'utf8').includes(password), false);
  assert.equal(readAutomaticKey(root).password, password);
  space.setConfig({ ...space.config, autoBackupMode: 'encrypted-private', backupKeep: 1 });
  const encrypted = automaticBackup(space, root, { force: true });
  const directory = join(root, 'backups', 'shared');
  const file = readFileSync(join(directory, encrypted), 'utf8');
  assert.ok(encrypted.endsWith('.encrypted.json'));
  assert.equal(file.includes('BACKUP_NORMAL_CANARY'), false);
  assert.equal(file.includes('BACKUP_PRIVATE_CANARY'), false);
  assert.equal(unpackBackup(file, password).privateEntries.length, 1);
  assert.throws(() => unpackBackup(file, 'incorrect-password-123'), { code: 'BACKUP_AUTH_FAILED' });
  assert.equal(automaticKeyStatus(offline).configured, false);
  const result = restoreBackup(offline, 'recovered', file, password, space.config);
  assert.equal(result.privateCount, 1);
  const restored = open(offline, 'recovered');
  assert.equal(restored.get(saved.id, admin).text, 'BACKUP_NORMAL_CANARY');
  assert.equal(restored.privateDb.prepare('SELECT content FROM entries').get().content, 'BACKUP_PRIVATE_CANARY');
  assert.deepEqual(restored.get(saved.id, admin).topics, ['orchid']);
  const second = automaticBackup(space, root, { force: true });
  assert.ok(existsSync(join(directory, plaintext)));
  assert.ok(existsSync(join(directory, second)));
  assert.equal(existsSync(join(directory, encrypted)), false);
  const before = readdirSync(directory).sort();
  rmSync(automaticKeyPath(root));
  assert.throws(() => automaticBackup(space, root, { force: true }), { code: 'BACKUP_KEY_UNAVAILABLE' });
  assert.deepEqual(readdirSync(directory).sort(), before);
  writeFileSync(automaticKeyPath(root), '{broken');
  assert.throws(() => automaticBackup(space, root, { force: true }), { code: 'BACKUP_KEY_UNAVAILABLE' });
  assert.deepEqual(readdirSync(directory).sort(), before);
});

test('Windows encrypted ordinary backups exclude private entries and key rotation makes a new point', {
  skip: process.platform !== 'win32',
}, t => {
  const { root, space } = fixture(t);
  space.create({ layer: 'L3', text: 'ordinary' }, admin);
  space.appendPrivate('test-author', 'PRIVATE_EXCLUDED_CANARY');
  saveAutomaticKey(root, password);
  space.setConfig({ ...space.config, autoBackupMode: 'encrypted' });
  const first = automaticBackup(space, root);
  assert.equal(automaticBackup(space, root), undefined);
  const document = unpackBackup(readFileSync(join(root, 'backups', 'shared', first), 'utf8'), password);
  assert.equal(Object.hasOwn(document, 'privateEntries'), false);
  saveAutomaticKey(root, 'different-offline-password-123');
  const second = automaticBackup(space, root);
  assert.notEqual(first, second);
  assert.ok(existsSync(join(root, 'backups', 'shared', first)));
});
