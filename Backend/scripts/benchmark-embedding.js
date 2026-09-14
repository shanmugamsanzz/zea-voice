import { benchmarkEmbedding } from '../src/rag/embedding.client.js';

try {
  const result = await benchmarkEmbedding();
  console.log(JSON.stringify(result, null, 2));
  if (!result.meetsTarget) {
    console.warn(`Embedding p95 ${result.p95Ms}ms is above the ${result.targetP95Ms}ms target.`);
  }
} catch (error) {
  console.error(`Embedding benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
