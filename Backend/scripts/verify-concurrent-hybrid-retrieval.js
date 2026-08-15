import assert from 'node:assert/strict';
import { searchHybridPublishedKnowledge } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { sparseIndexCacheKey } from '../src/knowledge-bases/knowledge-map.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
const documentId = '55555555-5555-4555-8555-555555555555';
const versionId = '66666666-6666-4666-8666-666666666666';
let embeddingStartedAt;
let bm25StartedAt;

const sparse = {
  algorithm: 'bm25', tenantId, knowledgeBaseId, publicationRevision: 1,
  documents: [{
    id: recordId, recordType: 'KNOWLEDGE_CHUNK', tenantId, knowledgeBaseId,
    documentId, documentVersionId: versionId, publicationRevision: 1,
    language: 'en', usageDirection: 'both', tokens: ['branch', 'located', 'downtown'],
    content: 'The branch is located downtown.',
  }],
};
const cache = {
  status: 'ready',
  async get(key) {
    if (key === sparseIndexCacheKey(tenantId, knowledgeBaseId, 1)) {
      bm25StartedAt = performance.now();
      return JSON.stringify(sparse);
    }
    return null;
  },
  async set() { return 'OK'; },
};
const startedAt = performance.now();
const result = await searchHybridPublishedKnowledge({ tenantId }, {
  agentId, query: 'branch located', usageDirection: 'inbound', language: 'en',
}, {
  cache, ragEnabled: true,
  contextRunner: async (_auth, operation) => operation({
    async query(sql, values) {
      if (!String(sql).includes('jsonb_to_recordset')) return {
        rows: [{ agent_usage: 'both', knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 1 }] }],
      };
      const candidate = JSON.parse(values[3])[0];
      return { rows: [{
        record_type: 'KNOWLEDGE_CHUNK', record_id: recordId, knowledge_base_id: knowledgeBaseId,
        document_id: documentId, document_version_id: versionId, document_name: 'knowledge.txt',
        source_page_start: 1, source_page_end: 1, language: 'en',
        content: 'The branch is located downtown.', caller_facing: true,
        authoritative_data: { content: 'The branch is located downtown.' },
        rank: candidate.rank, score: candidate.score,
      }] };
    },
  }),
  embed: async () => {
    embeddingStartedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return [0.1];
  },
  search: async () => { throw new Error('Timed-out embeddings must not reach Qdrant'); },
});

assert.equal(result.sources[0].content, 'The branch is located downtown.');
assert.ok(Math.abs(embeddingStartedAt - bm25StartedAt) < 30, 'Qdrant and BM25 branches must start concurrently');
assert.ok(performance.now() - startedAt < 600, 'BM25 must return within the bounded semantic deadline');
assert.equal(result.retrieval.lexicalCandidates, 1);

console.log(JSON.stringify({
  task: 'concurrent-hybrid-retrieval', passed: true,
  concurrentStartDeltaMs: Math.round(Math.abs(embeddingStartedAt - bm25StartedAt) * 100) / 100,
  semanticTimeoutFallback: true,
}));
