import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TidalRuntime } from '../src/runtime.js';
import { configOf } from '../src/model.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
export async function startPreview(port = 0, { embedding } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tidal-preview-'));
  const cwd = join(root, 'workspace-a'), otherCwd = join(root, 'workspace-b');
  const config = configOf({
    dataRoot: join(root, 'data'),
    bindings: [{ cwd, space: 'default' }, { cwd: otherCwd, space: 'workspace-b' }],
    privateWriters: ['demo-author'], autoBackup: false,
  });
  let revision = 0;
  const agents = [
    { id: 'demo-a', status: 'idle', session: { header: { cwd }, snapshotEvents: () => [] } },
    { id: 'demo-b', status: 'idle', session: { header: { cwd }, snapshotEvents: () => [] } },
  ];
  const ctx = {
    agents: { list: () => agents, get: id => agents.find(a => a.id === id) },
    settings: {
      describe: () => [{ ns: 'tidal-memory', revision, value: config }],
      update: async (_ns, patch, expected) => {
        if (expected !== revision) throw new Error('stale settings');
        Object.assign(config, configOf({ ...config, ...patch })); revision++;
      },
    },
    connection: { requestRejection: req => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return 403;
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return 403;
      return undefined;
    } },
    logger: { warn: message => console.warn(message) },
  };
  const runtime = new TidalRuntime(ctx, config, root, { embedding });
  const store = runtime.space('default');
  store.create({ layer: 'L3', text: '测试工作区使用蓝色主题。', status: 'active', kind: 'user_statement',
    category: 'preference', source: { kind: 'synthetic-fixture' } }, { admin: true });
  store.create({ layer: 'L1', text: '完成四层记忆管理页面的可用性检查。', status: 'active', kind: 'observation',
    category: 'task', tags: ['图谱体验'], source: { kind: 'synthetic-fixture' } }, { admin: true });
  store.create({ layer: 'L2', text: '一次合成测试确认了跨会话共享，不同工作区保持隔离。', status: 'active',
    kind: 'historical', occurredAt: '2026-01-01T10:00:00Z', source: { kind: 'synthetic-fixture' } }, { admin: true });
  store.appendPrivate('demo-author', 'PRIVATE_CANARY_SYNTHETIC_9038');
  runtime.space('workspace-b');
  const bundled = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      const root = createRoot(document.getElementById('root'));
      document.getElementById('open-settings').onclick = () => document.getElementById('settings').hidden = false;
      window.__ModuleLoader__ = { load(descriptor) {
        const plugin = descriptor.factory(name => {
          if (name !== 'react') throw new Error('Unexpected dependency: ' + name);
          return React;
        });
        plugin.apply({
          effect: fn => fn(),
          slots: {
            inject: (name, fn) => fn(),
            register: (options, Component) => {
              const entry = document.createElement('button');
              entry.textContent = options.label();
              entry.onclick = () => root.render(React.createElement(Component));
              document.getElementById('sections').append(entry);
              return () => { entry.remove(); root.unmount(); };
            }
          }
        });
      }};
    `, resolveDir: repository, loader: 'js' },
    bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    if (req.url.startsWith('/tidal-memory')) { runtime.handle(req, res); return; }
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/bootstrap.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(bundled.outputFiles[0].contents);
    } else if (req.url === '/client.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(readFileSync(join(repository, 'client.js')));
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tidal Memory Preview</title>
        <style>body{margin:24px;font-family:Segoe UI,Microsoft YaHei,sans-serif}button{font:inherit;padding:8px 14px;cursor:pointer}#settings{margin:24px auto;padding:24px;border:1px solid #bbb;border-radius:16px;max-width:1180px}#settings:not([hidden]){display:flex;gap:28px}#sections{min-width:130px}#root{min-width:0;flex:1}@media(max-width:760px){#settings:not([hidden]){display:block}}</style>
        </head><body><p>隔离设置预览 · 仅合成数据 · 非真实 DSH 桌面</p><button id="open-settings">设置</button>
        <section id="settings" hidden><aside id="sections"><h2>设置</h2></aside><div id="root">选择左侧插件入口。</div></section>
        <script src="/bootstrap.js"></script><script src="/client.js"></script></body></html>`);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    runtime, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const preview = await startPreview(Number(process.env.PORT || 4319));
  console.log(`${preview.url} — synthetic data only; Ctrl+C to stop.`);
  const close = async () => { await preview.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
