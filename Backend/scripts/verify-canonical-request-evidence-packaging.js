import assert from 'node:assert/strict';
import { buildContextEnrichedRetrievalQuery } from '../src/knowledge-engine/targeted-retrieval.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';

const scope = [{ id: 'kb-a', publicationRevision: 4 }];
const memoryRecord = { recordId: 'record-memory', name: 'Published Alpha' };
const explicitRecord = { recordId: 'record-current', recordType: 'CATALOG_ITEM', name: 'Published Beta' };
const baseInput = {
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
  usageDirection: 'inbound', latestQuestion: 'What is its configured value?',
  utterance: 'What is its configured value?', requestedFacts: ['configured_value'],
  memory: { activeEntity: memoryRecord, knownEntities: [memoryRecord] },
  canonicalCallMemory: { activeEntity: memoryRecord, knownEntities: [memoryRecord] },
  queryUnderstanding: {
    explicitEntities: [], explicitCategories: [], comparisonEntities: [],
    requestedFacts: ['configured_value'], contextDependent: true,
    canonicalContext: { ...memoryRecord, recordType: 'CATALOG_ITEM' },
  },
};
const classification = { retrievalPlan: { namespace: 'CATALOG' } };
const contextual = buildContextEnrichedRetrievalQuery(
  baseInput, classification, { contextDependent: true }, scope,
);
assert.equal(contextual.canonicalEntity.recordId, memoryRecord.recordId);
assert.equal(contextual.reservedRecords[0].reason, 'canonical_memory');
assert.match(contextual.semanticText, /Published Alpha/u);
assert.match(contextual.semanticText, /configured_value/u);

const explicit = buildContextEnrichedRetrievalQuery({
  ...baseInput,
  latestQuestion: 'Tell me about Published Beta',
  utterance: 'Tell me about Published Beta',
  queryUnderstanding: {
    ...baseInput.queryUnderstanding,
    explicitEntities: [explicitRecord], contextDependent: false,
    canonicalContext: explicitRecord,
  },
}, classification, { contextDependent: false }, scope);
assert.equal(explicit.canonicalEntity.recordId, explicitRecord.recordId);
assert.deepEqual(explicit.reservedRecords.map((entry) => entry.recordId), [explicitRecord.recordId]);

function evidence(recordId, recordType = 'CATALOG_ITEM') {
  return {
    id: `published:${recordType.toLowerCase()}:${recordId}`,
    recordId, recordType, tenantId: 'tenant-a', agentId: 'agent-a',
    hydrationValidated: true, publicationValidated: true, callerFacing: true,
    authoritativeData: recordType === 'CATALOG_ITEM'
      ? { itemKey: recordId, name: recordId }
      : { question: recordId, answer: recordId },
  };
}

const authoritative = {
  reservations: [{
    recordId: memoryRecord.recordId, recordType: 'CATALOG_ITEM', reason: 'canonical_memory',
  }],
  evidence: [
    evidence(memoryRecord.recordId),
    evidence('unrelated-faq', 'FAQ'),
    { ...evidence('unrelated-workflow', 'WORKFLOW_RULE'), callerFacing: false,
      authoritativeData: { actionType: 'configured_tool' } },
  ],
};
const packaged = buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative, runtimeProfile: { tools: [] },
});
assert.deepEqual(packaged.hydratedRecords.map((entry) => entry.recordId), [memoryRecord.recordId]);

assert.throws(() => buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative: { ...authoritative, evidence: [evidence('unrelated-faq', 'FAQ')] },
  runtimeProfile: { tools: [] },
}), (error) => error?.code === 'KNOWLEDGE_CONTEXT_RECORD_NOT_HYDRATED');

const comparisonRecords = ['compare-a', 'compare-b'];
const comparisonInput = {
  ...baseInput,
  queryUnderstanding: {
    explicitEntities: [], explicitCategories: [], contextDependent: false,
    comparisonEntities: comparisonRecords.map((recordId) => ({
      recordId, recordType: 'CATALOG_ITEM', name: recordId,
    })),
  },
};
const comparisonPackage = buildGroundedLlmInput({
  input: comparisonInput,
  classification: { intentClass: 'COMPARISON_COMPLEX' },
  resolution: { candidateNamespace: 'CATALOG' },
  authoritative: {
    reservations: comparisonRecords.map((recordId) => ({
      recordId, recordType: 'CATALOG_ITEM', reason: 'explicit_comparison',
    })),
    evidence: comparisonRecords.map((recordId) => evidence(recordId)),
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(comparisonPackage.hydratedRecords.map((entry) => entry.recordId), comparisonRecords);

console.log(JSON.stringify({
  success: true,
  task: 'Canonical request retrieval and namespace-isolated evidence packaging',
}));
