import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareHost() {
  const root = process.env.TIDAL_HOST_MODULES || fileURLToPath(new URL('./host-fixture/node_modules/', import.meta.url));
  const fixture = JSON.parse(readFileSync(new URL('./host-fixture/package.json', import.meta.url), 'utf8'));
  for (const [name, expected] of Object.entries(fixture.dependencies)) {
    let actual;
    try {
      actual = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')).version;
    } catch (cause) {
      throw new Error(`Required rc5 host dependency ${name} is missing. Run pnpm install:host; host tests never skip.`, { cause });
    }
    if (actual !== expected) throw new Error(`Host dependency ${name}: expected ${expected}, got ${actual}.`);
  }
  process.env.TIDAL_HOST_MODULES = root;
}
