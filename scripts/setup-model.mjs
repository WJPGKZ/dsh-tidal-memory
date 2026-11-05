import { mkdirSync, existsSync, createWriteStream, createReadStream, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { MODEL_PACKS } from '../src/model-packs.js';
import { readModelPack, packFile } from '../src/embedding.js';
import { atomicFile } from '../src/database.js';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const mode = option('--edition');
if (!args.includes('--edition') || !MODEL_PACKS[mode] || !args.includes('--root'))
  throw new Error('Usage: node scripts\\setup-model.mjs --edition cpu|enhanced --root <absolute dataRoot> [--manager <pnpm.cjs or npm-cli.js>]');
if (!isAbsolute(option('--root'))) throw new Error('--root must be an absolute data directory.');
const root = resolve(option('--root')), spec = MODEL_PACKS[mode];
if (mode === 'enhanced' && (process.platform !== 'win32' || process.arch !== 'x64'))
  throw new Error('The supplied enhanced engine pack supports Windows x64. Use the CPU edition or supply a separately verified local model pack.');
const destination = join(root, 'models', spec.directory);
if (existsSync(join(destination, 'manifest.json'))) {
  const installed = readModelPack(destination);
  for (const [file, expected] of Object.entries(installed.files))
    if (await digest(packFile(destination, file)) !== expected) throw new Error(`Installed file checksum mismatch: ${file}`);
  if (installed.driver === 'transformers') createRequire(join(destination, 'package.json')).resolve('@huggingface/transformers');
  console.log(`Existing model pack verified: ${destination}`);
  process.exit(0);
}
if (existsSync(destination)) throw new Error(`Incomplete model directory exists; inspect it before retrying: ${destination}`);
const staging = `${destination}.install-${randomUUID()}`;
mkdirSync(staging, { recursive: true });
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, file, expected) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(900000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  mkdirSync(dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  const actual = await digest(file);
  if (expected && actual !== expected) throw new Error(`Checksum mismatch: ${file}`);
  return actual;
}
async function run(file, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: staging, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installer exited with ${code}`)));
  });
}
const files = {};
try {
  if (mode === 'cpu') {
    atomicFile(join(staging, 'package.json'), JSON.stringify({ name: 'tidal-local-cpu-runtime', private: true,
      type: 'module', dependencies: { '@huggingface/transformers': '3.8.1' } }, null, 2));
    const candidates = [
      args.includes('--manager') ? option('--manager') : '',
      process.env.npm_execpath ?? '',
      resolve(dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const manager = candidates.find(file => file && existsSync(file));
    if (!manager) throw new Error('No local npm/pnpm CLI found. Pass --manager with its absolute JavaScript path.');
    const pnpm = /pnpm/i.test(manager);
    await run(process.execPath, [manager, 'install', '--ignore-scripts', ...(pnpm ?
      ['--ignore-workspace', '--no-frozen-lockfile', '--node-linker=hoisted', '--package-import-method=copy'] : ['--no-audit', '--no-fund'])]);
    for (const file of spec.files) {
      const relative = join('model', ...file.split('/'));
      files[relative] = await download(`https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${file}`,
        join(staging, relative), file.endsWith('.onnx') ? spec.weightHash : undefined);
    }
    files['package.json'] = await digest(join(staging, 'package.json'));
    for (const file of ['pnpm-lock.yaml', 'package-lock.json']) if (existsSync(join(staging, file))) files[file] = await digest(join(staging, file));
  } else {
    files[spec.model] = await download(`https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${spec.model}`,
      join(staging, spec.model), spec.weightHash);
    const archive = join(staging, 'engine.zip'), engine = join(staging, 'engine');
    await download(spec.engineUrl, archive, spec.engineHash);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:TIDAL_MODEL_ARCHIVE -DestinationPath $env:TIDAL_MODEL_ENGINE'],
    { TIDAL_MODEL_ARCHIVE: archive, TIDAL_MODEL_ENGINE: engine });
    rmSync(archive);
    const entries = readdirSync(engine, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    for (const entry of entries) {
      const absolute = join(entry.parentPath, entry.name);
      const relative = absolute.slice(staging.length + 1);
      files[relative] = await digest(absolute);
    }
    const server = Object.keys(files).find(file => file.endsWith('llama-server.exe'));
    if (!server) throw new Error('Official engine archive did not contain llama-server.exe');
    spec.engine = server;
  }
  const { files: unused, weightHash, engineUrl, engineHash, ...manifest } = spec;
  atomicFile(join(staging, 'manifest.json'), JSON.stringify({
    schema: 'tidal-local-embedding', version: 1, ...manifest, files,
  }, null, 2));
  renameSync(staging, destination);
  console.log(`Installed and checksummed: ${destination}`);
  console.log('Select the matching local semantic edition in DSH settings. No memory text was uploaded.');
} catch (error) {
  console.error(`Installation incomplete; staged files retained for inspection: ${staging}`);
  throw error;
}
