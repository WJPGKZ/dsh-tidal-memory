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
const fixture = JSON.parse(readFileSync(join('tests', 'host-fixture', 'package.json'), 'utf8'));
const host = manifest.engines.dsh;
if (!host || manifest.peerDependencies['@deepseek-ai/dsh'] !== host ||
    Object.entries(fixture.dependencies).some(([name, version]) => name.startsWith('@deepseek-ai/dsh-') && version !== host))
  throw new Error('Host compatibility declarations and fixture dependencies must match.');
console.log('Syntax and package checks passed.');
