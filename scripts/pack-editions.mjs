import { copyFileSync, lstatSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicFile } from '../src/database.js';
import { PACKAGE_FILES, validateReleaseInputs, verifyReleaseArchive } from './release-policy.mjs';

const root = process.cwd(), destination = resolve('.preview');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
validateReleaseInputs(root, manifest);
const manager = [process.env.npm_execpath, resolve(dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.cjs')]
  .find(file => file && existsSync(file));
if (!manager || !/pnpm/i.test(manager)) throw new Error('Run with pnpm pack:editions or the DSH-bundled Node/pnpm runtime.');
mkdirSync(destination, { recursive: true });
if (lstatSync(destination).isSymbolicLink()) throw new Error('Release destination must not be a symbolic link.');
const checksums = [];
for (const [name, embeddingMode] of [['standard', 'off'], ['cpu', 'cpu'], ['enhanced', 'enhanced']]) {
  const staging = mkdtempSync(join(destination, 'edition-build-'));
  try {
    for (const path of ['package.json', ...PACKAGE_FILES]) {
      const parts = path.split('/');
      const input = join(root, ...parts), output = join(staging, ...parts);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(input, output);
    }
    atomicFile(join(staging, 'src', 'edition.json'), JSON.stringify({ name, embeddingMode }));
    const result = spawnSync(process.execPath, [manager, 'pack', '--pack-destination', staging],
      { cwd: staging, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Edition packaging failed.');
    const target = join(destination, `${manifest.name}-${manifest.version}-${name}.tgz`);
    const archive = join(staging, `${manifest.name}-${manifest.version}.tgz`);
    const verified = verifyReleaseArchive(archive, staging, manifest);
    renameSync(archive, target);
    checksums.push(`${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${manifest.name}-${manifest.version}-${name}.tgz`);
    console.log(`${target} (${verified.length} verified files)`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
atomicFile(join(destination, 'SHA256SUMS'), checksums.join('\n') + '\n');
