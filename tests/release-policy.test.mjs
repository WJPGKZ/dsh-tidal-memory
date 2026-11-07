import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PACKAGE_FILES, validateReleaseInputs, verifyReleaseArchive } from '../scripts/release-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pathFor = (directory, path) => join(directory, ...path.split('/'));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tidal-release-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['package.json', ...PACKAGE_FILES]) {
    const target = pathFor(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(pathFor(root, path), target);
  }
  return directory;
}

function tarEntry(name, contents, type = '0') {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(value, offset, length, 'ascii');
  const number = (value, offset, length) => write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  write(name, 0, 100);
  number(0o644, 100, 8);
  number(0, 108, 8);
  number(0, 116, 8);
  number(contents.length, 124, 12);
  number(0, 136, 12);
  header.fill(32, 148, 156);
  write(type, 156, 1);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512)]);
}

function syntheticArchive(directory, { extra = [], alter = null, link = null } = {}) {
  const packedManifest = { ...manifest };
  delete packedManifest.packageManager;
  const entries = ['package.json', ...PACKAGE_FILES].map(path => {
    let contents = path === 'package.json' ? Buffer.from(JSON.stringify(packedManifest)) : readFileSync(pathFor(directory, path));
    if (path === alter) contents = Buffer.from('SYNTHETIC_TAMPER_CANARY');
    return tarEntry(`package/${path}`, path === link ? Buffer.alloc(0) : contents, path === link ? '2' : '0');
  });
  const archive = join(directory, 'synthetic.tgz');
  writeFileSync(archive, gzipSync(Buffer.concat([...entries, ...extra, Buffer.alloc(1024)])));
  return archive;
}

test('release inputs reject a synthetic unlisted database canary and manifest drift', t => {
  const directory = fixture(t);
  validateReleaseInputs(directory, manifest);
  writeFileSync(join(directory, 'src', 'PRIVATE_SYNTHETIC_CANARY.sqlite3'), 'synthetic private data');
  assert.throws(() => validateReleaseInputs(directory, manifest), /Unexpected or missing entry/);
  assert.throws(() => validateReleaseInputs(root, { ...manifest, files: [...manifest.files, 'src'] }), /allowlist/);
});

test('release inputs reject symbolic links instead of following them', t => {
  const directory = fixture(t);
  const target = join(directory, 'src', 'graph.js');
  rmSync(target);
  try { symlinkSync(join(directory, 'src', 'graph-index.js'), target, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('The operating system does not allow creating a file symbolic link.');
      return;
    }
    throw error;
  }
  assert.throws(() => validateReleaseInputs(directory, manifest), /not a regular file/);
});

test('release inputs reject a linked source directory', t => {
  const directory = fixture(t);
  const source = join(directory, 'src'), moved = join(directory, 'synthetic-source');
  renameSync(source, moved);
  try { symlinkSync(moved, source, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('The operating system does not allow creating a directory link.');
      return;
    }
    throw error;
  }
  assert.throws(() => validateReleaseInputs(directory, manifest), /must not be a symbolic link/);
});

test('release inputs reject a linked intermediate directory', t => {
  const directory = fixture(t);
  const scripts = join(directory, 'scripts'), moved = join(directory, 'synthetic-scripts');
  renameSync(scripts, moved);
  try { symlinkSync(moved, scripts, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('The operating system does not allow creating a directory link.');
      return;
    }
    throw error;
  }
  assert.throws(() => validateReleaseInputs(directory, manifest), /not a regular file/);
});

test('archive verification rejects extra, non-regular, duplicate and modified entries', t => {
  const directory = fixture(t);
  assert.equal(verifyReleaseArchive(syntheticArchive(directory), directory, manifest).length, PACKAGE_FILES.length + 1);
  const canary = tarEntry('package/src/PRIVATE_SYNTHETIC_CANARY.sqlite3', Buffer.from('synthetic private data'));
  assert.throws(() => verifyReleaseArchive(syntheticArchive(directory, { extra: [canary] }), directory, manifest),
    /unexpected, duplicate or non-regular/);
  const duplicate = tarEntry('package/src/graph.js', Buffer.from('duplicate'));
  assert.throws(() => verifyReleaseArchive(syntheticArchive(directory, { extra: [duplicate] }), directory, manifest),
    /unexpected, duplicate or non-regular/);
  assert.throws(() => verifyReleaseArchive(syntheticArchive(directory, { link: 'src/graph.js' }), directory, manifest),
    /unexpected, duplicate or non-regular/);
  assert.throws(() => verifyReleaseArchive(syntheticArchive(directory, { alter: 'src/graph.js' }), directory, manifest),
    /differs from its release input/);
});
