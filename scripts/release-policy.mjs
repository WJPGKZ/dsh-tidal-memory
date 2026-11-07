import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const SOURCE_FILES = Object.freeze([
  'backup-key.js', 'database.js', 'edition.json', 'embedding-worker.js', 'embedding.js',
  'forget-ledger.js', 'graph-index.js', 'graph-semantic.js', 'graph.js', 'host-deps.js', 'model-packs.js',
  'model.js', 'private-journal.js', 'runtime.js', 'semantic-index.js', 'sleep-context.js',
  'store.js', 'topic-index.js', 'transfer.js',
]);
export const PACKAGE_FILES = Object.freeze([
  'index.js', 'index.d.ts', 'client.js', ...SOURCE_FILES.map(name => `src/${name}`),
  'scripts/setup-model.mjs', 'scripts/bench-topics.mjs', 'scripts/bench-backup.mjs',
  'cordis.patch.yml', 'README.md', 'CONTRIBUTING.md', 'LICENSE',
]);

const absolute = (root, path) => join(root, ...path.split('/'));

function regularFile(root, path) {
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error(`Release input is not a regular file or directory: ${path}`);
  }
}

export function validateReleaseInputs(root, manifest) {
  const declared = manifest.files;
  if (!Array.isArray(declared) || declared.length !== PACKAGE_FILES.length ||
      new Set(declared).size !== PACKAGE_FILES.length || declared.some(path => !PACKAGE_FILES.includes(path)))
    throw new Error('Package manifest does not match the explicit release file allowlist.');
  const source = join(root, 'src');
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
    throw new Error('Release source directory must not be a symbolic link.');
  const entries = readdirSync(source);
  if (entries.length !== SOURCE_FILES.length || entries.some(name => !SOURCE_FILES.includes(name)))
    throw new Error('Unexpected or missing entry in the release source directory.');
  for (const path of ['package.json', ...PACKAGE_FILES]) regularFile(root, path);
}

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid release archive header.');
  return Number.parseInt(value, 8);
}

function archiveText(bytes) {
  return bytes.toString('utf8').replace(/\0.*$/, '');
}

export function verifyReleaseArchive(archive, staging, manifest) {
  const data = gunzipSync(readFileSync(archive), { maxOutputLength: 16 * 1024 * 1024 });
  const expected = new Set(['package.json', ...PACKAGE_FILES]);
  const seen = new Set();
  let offset = 0, ended = false;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (data.length - offset < 1024 || !data.subarray(offset).every(byte => byte === 0))
        throw new Error('Invalid release archive ending.');
      ended = true;
      break;
    }
    const checksum = octal(header.subarray(148, 156));
    let calculated = 0;
    for (let i = 0; i < 512; i++) calculated += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== calculated) throw new Error('Release archive header checksum mismatch.');
    const prefix = archiveText(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ''}${archiveText(header.subarray(0, 100))}`;
    const path = name.startsWith('package/') ? name.slice('package/'.length) : '';
    const type = header[156];
    const size = octal(header.subarray(124, 136));
    if (!expected.has(path) || seen.has(path) || (type !== 0 && type !== 48))
      throw new Error('Release archive contains an unexpected, duplicate or non-regular entry.');
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > data.length)
      throw new Error('Release archive entry has an invalid size.');
    const contents = data.subarray(offset + 512, offset + 512 + size);
    if (path === 'package.json') {
      const expectedManifest = { ...manifest };
      delete expectedManifest.packageManager;
      if (!isDeepStrictEqual(JSON.parse(contents.toString('utf8')), expectedManifest))
        throw new Error('Packaged manifest does not match the release input.');
    } else if (!contents.equals(readFileSync(absolute(staging, path)))) {
      throw new Error(`Packaged file differs from its release input: ${path}`);
    }
    seen.add(path);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || seen.size !== expected.size) throw new Error('Release archive is incomplete.');
  return [...seen].sort();
}
