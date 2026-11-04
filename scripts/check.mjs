import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.preview'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
for (const file of files(process.cwd()).filter(file => /\.(js|mjs)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.engines.dsh !== '0.2.1-rc.5') throw new Error('Unexpected host compatibility declaration');
console.log('Syntax and package checks passed.');
