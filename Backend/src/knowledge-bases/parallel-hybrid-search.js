import { knowledgeSearchIndexes } from '../knowledge-engine/query-classifier.js';
import { retrieveTargetedCandidates } from '../knowledge-engine/targeted-retrieval.js';

export const PARALLEL_HYBRID_SEARCH_VERSION = 1;

function forcedParallelClassification(classification = {}) {
  const indexes = new Set(classification.retrievalPlan?.indexes ?? []);
  indexes.add(knowledgeSearchIndexes.BM25);
  indexes.add(knowledgeSearchIndexes.SEMANTIC);
  return Object.freeze({
    ...classification,
    retrievalPlan: Object.freeze({
      ...(classification.retrievalPlan ?? {}),
      indexes: Object.freeze([...indexes]),
      parallelChannels: Object.freeze(['structured', 'bm25', 'qdrant']),
    }),
  });
}

export async function searchParallelHybridCandidates(request = {}, dependencies = {}) {
  const classification = forcedParallelClassification(request.classification);
  const result = await retrieveTargetedCandidates({
    ...request,
    classification,
  }, dependencies);
  const channels = result.channels ?? {};
  for (const channel of ['structured', 'bm25', 'qdrant']) {
    if (!Array.isArray(channels[channel])) {
      throw new TypeError(`Parallel hybrid search did not return the ${channel} channel`);
    }
  }
  return Object.freeze({
    ...result,
    version: PARALLEL_HYBRID_SEARCH_VERSION,
    executionMode: 'parallel_hybrid',
    classification,
  });
}
