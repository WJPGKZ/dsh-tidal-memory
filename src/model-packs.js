export const MODEL_PACKS = Object.freeze({
  cpu: {
    directory: 'bge-small-zh-v1.5', driver: 'transformers', model: 'model',
    modelId: 'BAAI/bge-small-zh-v1.5', dimension: 512, chunkSize: 384, weightBytes: 94851877,
    queryPrefix: '为这个句子生成表示以用于检索相关文章：', pooling: 'cls',
    minScore: 0.5, relativeFloor: 0.92, runtimeVersion: 'transformers-3.8.1',
    repository: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    license: 'MIT (BAAI base model)',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'onnx/model.onnx'],
    weightHash: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a',
  },
  enhanced: {
    directory: 'qwen3-embedding-0.6b', driver: 'llama', model: 'Qwen3-Embedding-0.6B-f16.gguf',
    modelId: 'Qwen/Qwen3-Embedding-0.6B', dimension: 1024, chunkSize: 1024, weightBytes: 1197629632,
    queryPrefix: 'Instruct: Given a question, retrieve relevant passages from saved memories.\nQuery: ',
    pooling: 'last', minScore: 0.55, relativeFloor: 0.92,
    runtimeVersion: 'llama.cpp-b12110-vulkan', repository: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    revision: '370f27d7550e0def9b39c1f16d3fbaa13aa67728', license: 'Apache-2.0',
    weightHash: '421a27e58d165478cc7acb984a688c2aa41404968b0203e7cd743ece44c54340',
    engineUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-vulkan-x64.zip',
    engineHash: '9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f',
  },
});
