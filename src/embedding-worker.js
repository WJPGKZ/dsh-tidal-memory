import { parentPort, workerData } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { packFile } from './embedding.js';
import { requireValue } from './model.js';

const { pack, device } = workerData;
let engine, pipeline, endpoint, closing = false;
const key = randomUUID();
const alias = `tidal-${randomUUID()}`;
async function digest(file) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function initialize() {
  for (const [file, expected] of Object.entries(pack.files)) {
    requireValue(await digest(packFile(pack.directory, file)) === expected,
      'MODEL_CHECKSUM', `本地模型文件校验失败：${file}`);
  }
  if (closing) return;
  if (pack.driver === 'transformers') {
    const require = createRequire(join(pack.directory, 'package.json'));
    const imported = await import(pathToFileURL(require.resolve('@huggingface/transformers')));
    const { env, pipeline: buildPipeline } = imported.default ?? imported;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = pack.directory;
    if (closing) return;
    pipeline = await buildPipeline('feature-extraction', pack.model, { dtype: 'fp32', device: 'cpu', local_files_only: true });
    if (closing) await pipeline.dispose();
  } else {
    const port = await freePort();
    if (closing) return;
    endpoint = `http://127.0.0.1:${port}`;
    engine = spawn(packFile(pack.directory, pack.engine), [
      '--model', packFile(pack.directory, pack.model), '--embedding', '--pooling', pack.pooling,
      '--embd-normalize', '2',
      '--host', '127.0.0.1', '--port', String(port), '--api-key', key, '--alias', alias,
      '--ctx-size', '8192', '--batch-size', '8192', '--ubatch-size', '8192',
      '--parallel', '1', '--n-gpu-layers', device === 'cpu' ? '0' : '99', '--threads', '4', '--log-disable',
    ], { cwd: dirname(packFile(pack.directory, pack.engine)), windowsHide: true, stdio: 'ignore' });
    let spawnError;
    if (engine.pid) parentPort.postMessage({ type: 'engine', pid: engine.pid });
    engine.on('exit', () => parentPort.postMessage({ type: 'engine-exit' }));
    engine.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 120000;
    while (!closing) {
      if (spawnError) throw spawnError;
      requireValue(engine.exitCode === null, 'LOCAL_ENGINE_EXITED', `本地推理引擎启动失败（${engine.exitCode}）。请检查驱动或选择 CPU。`);
      try {
        const response = await fetch(`${endpoint}/health`, { headers: { authorization: `Bearer ${key}` },
          redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const models = await fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${key}` },
            redirect: 'error', signal: AbortSignal.timeout(1000) });
          requireValue(models.ok && (await models.json()).data?.some(model => model.id === alias),
            'LOCAL_ENGINE_MISMATCH', '此端口不是本插件启动的模型实例，拒绝发送记忆。');
          break;
        }
      } catch (error) {
        if (!['TimeoutError', 'TypeError'].includes(error.name)) throw error;
      }
      requireValue(Date.now() < deadline, 'LOCAL_ENGINE_TIMEOUT', '本地推理引擎启动超时。');
      await delay(200);
    }
  }
}
async function embed(texts, kind) {
  requireValue(Array.isArray(texts) && texts.length > 0 && texts.length <= 32 &&
    texts.every(text => typeof text === 'string' && text.length <= 10000),
  'INVALID_EMBEDDING_INPUT', '本地模型批次输入无效。');
  const input = texts.map(text => kind === 'query' ? pack.queryPrefix + text : text);
  if (pipeline) {
    const tokens = await pipeline.tokenizer(input, { padding: true, truncation: false });
    requireValue(tokens.input_ids.dims[1] <= 512, 'EMBEDDING_INPUT_TOO_LONG', '语义块超过模型上限，未静默截断。');
    const output = await pipeline(input, { pooling: pack.pooling, normalize: true, truncation: false });
    return output.tolist();
  }
  const response = await fetch(`${endpoint}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ input, model: alias, encoding_format: 'float' }),
    redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  requireValue(response.ok, 'LOCAL_EMBEDDING_HTTP', `本地推理请求失败（HTTP ${response.status}）。`);
  const body = await response.json();
  requireValue(Array.isArray(body.data) && body.data.length === input.length, 'INVALID_EMBEDDING', '本地推理返回数量不符。');
  return body.data.sort((a, b) => a.index - b.index).map(row => row.embedding);
}
async function close() {
  closing = true;
  if (engine && engine.exitCode === null) engine.kill();
  await pipeline?.dispose();
  parentPort.close();
}
parentPort.on('close', () => { if (engine && engine.exitCode === null) engine.kill(); });
process.on('exit', () => { if (engine && engine.exitCode === null) engine.kill(); });
let queue = initialize().then(() => {
  if (!closing) parentPort.postMessage({ type: 'ready' });
}).catch(async error => {
  parentPort.postMessage({ type: 'fatal', code: error.code ?? 'LOCAL_MODEL_FAILED', message: error.message });
  await close();
});
parentPort.on('message', message => {
  if (message.type === 'close') { close(); return; }
  if (message.type !== 'embed' || closing) return;
  queue = queue.then(async () => {
    if (closing) return;
    try { parentPort.postMessage({ id: message.id, vectors: await embed(message.texts, message.kind) }); }
    catch (error) { parentPort.postMessage({ id: message.id,
      error: { code: error.code ?? 'LOCAL_EMBEDDING_FAILED', message: error.message } }); }
  });
});
