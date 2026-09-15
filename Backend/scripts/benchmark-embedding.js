import { benchmarkEmbedding } from '../src/rag/embedding.client.js';

try {
  const result = await benchmarkEmbedding();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Embedding benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
