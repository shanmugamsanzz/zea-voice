import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fuseCandidateRankings } from '../src/knowledge-engine/authoritative-evidence.js';
import { runTemplateEngineHybridRetrieval } from '../src/voice/interaction/template-engine-hybrid-retrieval.js';

const decision = Object.freeze({
  decision: 'SEARCH', response: '', clarification: null,
  search: Object.freeze({
    query: 'selected service price', requestedFact: 'price',
    contextualReference: 'selected service', preferredRecordIds: ['record-1'],
  }),
  tool: null, stateUpdate: null,
});
const state = Object.freeze({
  lastReferencedRecordIds: Object.freeze(['record-1']), comparisonRecordIds: Object.freeze([]),
});
const scope = Object.freeze({
  tenantId: 'tenant-a', agentId: 'agent-a', usageDirection: 'inbound',
  publications: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-a', publicationRevision: 3 }),
  ]),
});
function candidate(recordId, score = 0.8) {
  return {
    tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a',
    publicationRevision: 3, recordId, recordType: 'CATALOG_ITEM', score,
    callerFacingHint: true,
    authorizationHint: false,
    categoryKey: 'category-a',
    tokenCoverage: 0.75,
    namespaceRank: 2,
    deduplicationIdentity: { canonicalKey: `key-${recordId}` },
    evidenceRecordIds: [`child-${recordId}`],
    canonicalIdentity: { tenantId: 'untrusted-tenant' },
  };
}

let started = 0;
let release;
const barrier = new Promise((resolve) => { release = resolve; });
function concurrentSearch(results) {
  return async (request) => {
    started += 1;
    assert.equal(request.scope.tenantId, scope.tenantId);
    assert.equal(request.scope.agentId, scope.agentId);
    assert.deepEqual(request.scope.publications, scope.publications);
    if (started === 3) release();
    await barrier;
    return results;
  };
}
const retrieval = await runTemplateEngineHybridRetrieval({
  decision, state, scope, candidateLimit: 5,
}, {
  searchStructuredPostgres: concurrentSearch([candidate('record-1'), candidate('record-2')]),
  searchBm25: concurrentSearch([candidate('record-2'), candidate('record-3')]),
  searchQdrantE5: concurrentSearch([candidate('record-3'), candidate('record-1')]),
});
assert.equal(started, 3);
assert.equal(retrieval.executionMode, 'parallel');
assert.deepEqual(Object.keys(retrieval.channels), ['structured', 'bm25', 'qdrant']);
assert.equal(retrieval.candidates.length, 3);
assert.equal(retrieval.candidates[0].recordId, 'record-1');
assert.equal(retrieval.candidates[0].preferredRecord, true);
assert.equal(retrieval.channels.structured[0].callerFacingHint, true);
assert.equal(retrieval.channels.structured[0].authorizationHint, false);
assert.equal(retrieval.channels.structured[0].categoryKey, 'category-a');
assert.equal(retrieval.channels.structured[0].tokenCoverage, 0.75);
assert.equal(retrieval.channels.structured[0].score, 0.8);
assert.equal(retrieval.channels.structured[0].providerScore, 0.8);
assert.equal(retrieval.channels.structured[0].namespaceRank, 2);
assert.deepEqual(retrieval.channels.structured[0].deduplicationIdentity,
  { canonicalKey: 'key-record-1' });
assert.deepEqual(retrieval.channels.structured[0].evidenceRecordIds, ['child-record-1']);
assert.equal(retrieval.channels.structured[0].canonicalIdentity.tenantId, 'tenant-a',
  'Canonical identity must be rebuilt from the validated tenant scope');
assert.equal(retrieval.channels.structured[0].canonicalIdentity.recordType, 'CATALOG_ITEM');
assert.ok(retrieval.channels.structured[0].canonicalIdentityKey);
assert.deepEqual(retrieval.candidates.find((entry) => entry.recordId === 'record-2').channels,
  ['structured', 'bm25']);
const authoritativeSelection = fuseCandidateRankings({
  ...retrieval,
  tenantId: scope.tenantId,
  agentId: scope.agentId,
  recordTypes: ['CATALOG_ITEM'],
}, {
  minProviderScore: 0.1,
  highProviderScore: 0.7,
  relevanceScoreMargin: 0.2,
});
assert.ok(authoritativeSelection.candidates.length > 0,
  'Preserved caller-facing metadata and scores must survive authoritative selection');
assert.ok(authoritativeSelection.candidates.some((entry) => entry.recordId === 'record-1'));

const partial = await runTemplateEngineHybridRetrieval({ decision, state, scope }, {
  searchStructuredPostgres: async () => [candidate('record-1')],
  searchBm25: async () => { throw Object.assign(new Error('unavailable'), { code: 'BM25_DOWN' }); },
  searchQdrantE5: async () => [candidate('record-2')],
});
assert.equal(partial.failures.length, 1);
assert.equal(partial.failures[0].channel, 'bm25');
assert.equal(partial.candidates.length, 2);

await assert.rejects(() => runTemplateEngineHybridRetrieval({ decision, state, scope }, {
  searchStructuredPostgres: async () => [{
    ...candidate('foreign-record'), tenantId: 'tenant-b',
  }],
  searchBm25: async () => [],
  searchQdrantE5: async () => [],
}), (error) => error.code === 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_VIOLATION');

await assert.rejects(() => runTemplateEngineHybridRetrieval({ decision, state, scope }, {
  searchStructuredPostgres: async () => { throw new Error('down'); },
  searchBm25: async () => { throw new Error('down'); },
  searchQdrantE5: async () => { throw new Error('down'); },
}), (error) => error.code === 'TEMPLATE_ENGINE_RETRIEVAL_UNAVAILABLE');

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-hybrid-retrieval.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const legacyDependency of ['query-classifier', 'canonical-topic-memory']) {
  assert.equal(source.includes(legacyDependency), false,
    `Hybrid retrieval imports legacy routing: ${legacyDependency}`);
}
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false,
    `Hybrid retrieval contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine hybrid retrieval verification passed.');
