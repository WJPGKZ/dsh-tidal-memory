import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const storeUrl = new URL('../src/store.js', import.meta.url).href;
const holder = `
  import { MemorySpace } from ${JSON.stringify(storeUrl)};
  const [root, space] = process.argv.slice(1);
  const owner = new MemorySpace(root, space);
  console.log('READY');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    for (const command of data.trim().split(/\\s+/)) {
      if (command === 'write') {
        owner.create({ layer: 'L2', text: 'owner still writable' }, { admin: true });
        console.log('WROTE');
      } else if (command === 'normal') {
        owner.close();
        process.exit(0);
      } else if (command === 'abrupt') {
        process.exit(17);
      }
    }
  });
`;
const contender = `
  import { MemorySpace } from ${JSON.stringify(storeUrl)};
  try {
    const space = new MemorySpace(process.argv[1], process.argv[2]);
    space.create({ layer: 'L2', text: 'other process writable' }, { admin: true });
    space.close();
    console.log('OPEN');
  } catch (error) {
    if (error.code !== 'SPACE_BUSY') throw error;
    console.log('SPACE_BUSY');
  }
`;

test('independent writers cannot share a space and normal or abrupt exit releases its lock', { timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'tidal-process-lock-'));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.stdin.write('abrupt\n');
        await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const probe = name => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', contender, root, name],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  for (const mode of ['normal', 'abrupt']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', holder, root, 'shared'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, 'READY');
    assert.equal(probe('shared'), 'SPACE_BUSY');
    assert.equal(probe(`other-${mode}`), 'OPEN');
    child.stdin.write('write\n');
    assert.equal((await lines.next()).value, 'WROTE');
    const exited = once(child, 'exit');
    child.stdin.write(`${mode}\n`);
    const [code] = await exited;
    assert.equal(code, mode === 'normal' ? 0 : 17);
    children.delete(child);
    assert.equal(probe('shared'), 'OPEN');
  }
});
