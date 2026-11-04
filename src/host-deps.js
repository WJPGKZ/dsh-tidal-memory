import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function fromDirectory(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.'];
  const path = typeof entry === 'string' ? entry : entry?.import ?? entry?.default ?? manifest.module ?? manifest.main;
  return import(pathToFileURL(join(directory, path)).href);
}
export async function hostModule(name) {
  if (process.env.TIDAL_HOST_MODULES) return fromDirectory(join(process.env.TIDAL_HOST_MODULES, name));
  try {
    return await import(name);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(`Cannot find package '${name}'`) || !process.argv[1]) throw error;
    // Desktop profiles need not expose every package from the host's module tree.
    const hostRequire = createRequire(pathToFileURL(process.argv[1]));
    return fromDirectory(dirname(hostRequire.resolve(`${name}/package.json`)));
  }
}
