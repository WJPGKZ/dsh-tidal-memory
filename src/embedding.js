import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { hash, requireValue, MemoryError, number } from './model.js';
import { MODEL_PACKS } from './model-packs.js';

export function packFile(directory, path) {
  requireValue(typeof path === 'string' && path.length > 0 && !isAbsolute(path), 'INVALID_MODEL_PACK', '模型包路径必须是包内相对路径。');
  const file = resolve(directory, path);
  const part = relative(directory, file);
  requireValue(part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part),
    'INVALID_MODEL_PACK', '模型包不能引用包外文件。');
  return file;
}
export function readModelPack(directory) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new MemoryError('MODEL_NOT_INSTALLED', '本地模型尚未安装，请使用模型安装脚本或选择已准备好的模型包。', 503);
    throw error;
  }
  requireValue(manifest.schema === 'tidal-local-embedding' && manifest.version === 1 &&
    ['transformers', 'llama'].includes(manifest.driver), 'INVALID_MODEL_PACK', '模型包格式不受支持。');
  number(manifest.dimension, 32, 8192, '向量维数', true);
  number(manifest.chunkSize, 64, 4096, '语义分块', true);
  number(manifest.minScore, 0, 1, '语义最低分');
  number(manifest.relativeFloor, 0, 1, '语义相对门槛');
  requireValue(typeof manifest.queryPrefix === 'string' && manifest.queryPrefix.length < 1000 &&
    manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files) &&
    Object.keys(manifest.files).length > 0, 'INVALID_MODEL_PACK', '模型包缺少查询格式或校验清单。');
  for (const [path, digest] of Object.entries(manifest.files)) {
    packFile(directory, path);
    requireValue(/^[a-f0-9]{64}$/.test(digest), 'INVALID_MODEL_PACK', '模型文件校验值无效。');
  }
  packFile(directory, manifest.model);
  const checksummed = new Set(Object.keys(manifest.files).map(path => packFile(directory, path)));
  const weight = manifest.driver === 'llama' ? manifest.model : join(manifest.model, 'onnx', 'model.onnx');
  requireValue(checksummed.has(packFile(directory, weight)), 'INVALID_MODEL_PACK', '模型权重不在校验清单中。');
  if (manifest.driver === 'llama') requireValue(checksummed.has(packFile(directory, manifest.engine)),
    'INVALID_MODEL_PACK', '本地推理引擎不在校验清单中。');
  return { ...manifest, directory, fingerprint: hash(JSON.stringify(manifest)) };
}
export function normalizedVector(input, dimension) {
  requireValue(Array.isArray(input) || ArrayBuffer.isView(input), 'INVALID_EMBEDDING', '本地模型未返回数值向量。');
  requireValue(input.length === dimension && Array.from(input).every(Number.isFinite),
    'INVALID_EMBEDDING', '本地向量维数或数值无效。');
  const norm = Math.sqrt(Array.from(input).reduce((sum, x) => sum + x * x, 0));
  requireValue(norm > 0 && Number.isFinite(norm), 'INVALID_EMBEDDING', '本地模型返回了空向量。');
  return Float32Array.from(input, x => x / norm);
}

export function modelInventory(root) {
  return Object.entries(MODEL_PACKS).map(([edition, spec]) => {
    const directory = join(root, 'models', spec.directory);
    const item = { edition, directory, modelId: spec.modelId, dimension: spec.dimension,
      weightFile: spec.driver === 'transformers' ? join(directory, 'model', 'onnx', 'model.onnx') : join(directory, spec.model),
      manifestFile: join(directory, 'manifest.json'),
      runtimeDirectory: join(directory, spec.driver === 'transformers' ? 'node_modules' : 'engine'),
      weightBytes: spec.weightBytes, license: spec.license,
      sourceUrl: `https://huggingface.co/${spec.repository}/tree/${spec.revision}`,
      installed: false, fingerprint: null };
    if (!existsSync(join(directory, 'manifest.json'))) return item;
    try {
      const pack = readModelPack(directory);
      return { ...item, installed: Object.keys(pack.files).every(file => existsSync(packFile(directory, file))),
        fingerprint: pack.fingerprint };
    } catch (error) { return { ...item, error: { code: error.code ?? 'INVALID_MODEL_PACK', message: error.message } }; }
  });
}

export class LocalEmbedding {
  constructor(root) {
    this.root = root;
    this.requests = new Map();
    this.sequence = 0;
    this.closed = false;
    this.state = { mode: 'off', ready: false };
  }
  configure(config) {
    const directory = config.embeddingModelPath || join(this.root, 'models', MODEL_PACKS[config.embeddingMode]?.directory ?? 'disabled');
    const key = JSON.stringify([config.embeddingMode, directory, config.embeddingDevice]);
    if (key === this.configurationKey) return;
    this.configurationKey = key;
    this.configurationRevision = (this.configurationRevision ?? 0) + 1;
    this.key = `${key}:${this.configurationRevision}`;
    this.config = config;
    this.directory = directory;
    this.shutdownWorker();
    this.pack = null;
    this.state = { mode: config.embeddingMode, ready: false, directory, device: config.embeddingDevice };
  }
  shutdownWorker() {
    this.rejectStarting?.(new MemoryError('MODEL_CHANGED', '本地模型已切换或停止。', 409));
    this.rejectStarting = null;
    for (const request of this.requests.values()) request.reject(new MemoryError('MODEL_CHANGED', '本地模型已切换或停止。', 409));
    this.requests.clear();
    if (this.worker) {
      const worker = this.worker;
      worker.postMessage({ type: 'close' });
      const timer = setTimeout(() => worker.terminate(), 3000);
      timer.unref();
      worker.once('exit', () => clearTimeout(timer));
    }
    this.worker = null;
    this.starting = null;
  }
  reload() { this.configurationKey = null; this.configure(this.config); }
  async ready() {
    requireValue(!this.closed && this.config?.embeddingMode !== 'off', 'SEMANTIC_DISABLED', '本地语义检索未启用。', 503);
    if (this.starting) return this.starting;
    const key = this.key;
    try { this.pack = readModelPack(this.directory); }
    catch (error) { this.state.error = { code: error.code ?? 'MODEL_INVALID', message: error.message }; throw error; }
    const worker = new Worker(new URL('./embedding-worker.js', import.meta.url), {
      workerData: { pack: this.pack, device: this.config.embeddingDevice },
      execArgv: [],
    });
    this.worker = worker;
    this.starting = new Promise((resolveReady, rejectReady) => {
      this.rejectStarting = rejectReady;
      const fail = error => {
        if (this.worker !== worker) return;
        this.state.ready = false;
        this.state.error = { code: error.code ?? 'LOCAL_MODEL_FAILED', message: error.message };
        rejectReady(error);
        for (const request of this.requests.values()) request.reject(error);
        this.requests.clear();
      };
      worker.on('error', fail);
      worker.on('exit', code => {
        if (worker.enginePid) {
          try { process.kill(worker.enginePid); }
          catch (error) { if (error.code !== 'ESRCH') this.state.error = { code: 'ENGINE_STOP_FAILED', message: error.message }; }
        }
        if (this.worker === worker) {
          fail(new MemoryError('LOCAL_MODEL_EXITED', `本地模型工作进程已退出（${code}）。`, 503));
          this.worker = null;
          this.starting = null;
        }
      });
      worker.on('message', message => {
        if (message.type === 'engine') { worker.enginePid = message.pid; return; }
        if (message.type === 'engine-exit') { worker.enginePid = null; return; }
        if (this.key !== key || this.worker !== worker) return;
        if (message.type === 'ready') {
          this.state = { ...this.state, ready: true, error: null, model: this.pack.modelId,
            fingerprint: this.pack.fingerprint, dimension: this.pack.dimension, runtimeVersion: this.pack.runtimeVersion };
          resolveReady(this.pack);
          this.rejectStarting = null;
        } else if (message.type === 'fatal') {
          fail(new MemoryError(message.code ?? 'LOCAL_MODEL_FAILED', message.message, 503));
        } else {
          const request = this.requests.get(message.id);
          if (!request) return;
          this.requests.delete(message.id);
          if (message.error) request.reject(new MemoryError(message.error.code, message.error.message, 503));
          else request.resolve(message.vectors);
        }
      });
    });
    return this.starting;
  }
  async embed(texts, kind = 'document') {
    const key = this.key;
    const pack = await this.ready();
    requireValue(this.key === key && this.worker, 'MODEL_CHANGED', '本地模型已切换，请重试。', 409);
    const vectors = await new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'embed', id, texts, kind });
    });
    requireValue(this.key === key && vectors.length === texts.length, 'INVALID_EMBEDDING', '本地向量返回数量或模型版本不一致。');
    return vectors.map(vector => normalizedVector(vector, pack.dimension));
  }
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.shutdownWorker();
    if (worker) await new Promise(resolve => worker.once('exit', resolve));
  }
}
