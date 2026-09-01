import assert from 'node:assert/strict';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import {
  buildGroundingEnvelope,
  buildUnifiedGroundingEnvelope,
} from '../src/voice/interaction/grounded-llm-response.js';
import {
  buildGroundedLlmInput,
  retrieveRankHydrateGroundedTurn,
} from '../src/knowledge-bases/grounded-turn-evidence.js';

const tenantId = '94000000-0000-4000-8000-000000000001';
const agentId = '94000000-0000-4000-8000-000000000002';
const callId = '94000000-0000-4000-8000-000000000003';
const knowledgeBaseId = '94000000-0000-4000-8000-000000000004';
const job = {
  tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
  targetRevision: 9, knowledge_base_usage: 'both', assigned_agent_ids: [agentId],
};

function faq(index) {
  return {
    record_id: `94000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
    record_type: 'faq',
    document_id: `94000000-0000-4000-8002-${String(index).padStart(12, '0')}`,
    document_version_id: `94000000-0000-4000-8003-${String(index).padStart(12, '0')}`,
    usage_direction: 'both', language: 'mul', source_page_start: index,
    question: `Tenant question ${index}`,
    answer: `Published answer ${index}`,
    content: `tenant lookup published answer ${index}`,
    entity_aliases: [`tenant query ${index}`], entity_category_aliases: [],
    entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
  };
}

const records = Array.from({ length: 7 }, (_, index) => faq(index + 1));
const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
const workflow = {
  ...faq(20), record_type: 'workflow_rule',
  question: 'Submit tenant request', content: 'tenant lookup submit request',
  answer: 'Use the assigned tenant action.', entity_name: 'Submit request',
  entity_aliases: ['submit tenant request'],
  entity_metadata: {
    conditions: { examples: ['submit tenant request'], intentClass: 'ACTION_TOOL_REQUEST' },
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'submit_tenant_request' },
  },
};
records.push(workflow);
const bundle = buildPublicationIndexes(job, records);
const sparseIndex = buildRevisionSparseIndex(job, bundle.records);
const input = createKnowledgeEngineInput({
  tenantId, agentId, callId, usageDirection: 'inbound',
  utterance: 'tenant lookup submit request',
  requestedFacts: ['details'],
  memory: {
    activeEntity: { recordId: records[0].record_id, key: 'tenant-record', name: 'Tenant record' },
    recentTurns: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier grounded response' },
    ],
    activeTool: { name: 'submit_tenant_request', status: 'collecting_information' },
    collectedToolFields: { reference: 'A-10' },
  },
});
const classification = Object.freeze({
  tenantId, agentId, callId, intentClass: 'UNKNOWN',
  retrievalPlan: Object.freeze({ indexes: Object.freeze([
    'FAQ', 'WORKFLOW', 'BM25', 'SEMANTIC',
  ]) }),
});
const resolution = Object.freeze({
  candidate: null, candidateNamespace: null, routingCandidates: Object.freeze([]),
  namespaceCandidates: Object.freeze({}), action: 'RETRIEVE',
});
let hydrationQueries = 0;
const result = await retrieveRankHydrateGroundedTurn({
  auth: { tenantId }, input, classification, resolution,
  publicationBundles: [bundle], sparseIndexes: [sparseIndex],
  runtimeProfile: {
    tools: [{
      id: 'tool-1', name: 'submit_tenant_request',
      inputSchema: {
        type: 'object', required: ['reference'],
        properties: { reference: { type: 'string', question: 'Which reference?' } },
      },
    }],
  },
}, {
  minProviderScore: 0,
  retrieval: {
    embed: async () => {
      await wait(220);
      return [0.1, 0.2];
    },
    search: async () => records.map((record, index) => ({
      id: record.record_id, score: 0.99 - index * 0.01,
      payload: {
        tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
        publication_revision: 9, record_type: record.record_type.toUpperCase(),
        record_id: record.record_id, agent_usage: 'both',
      },
    })),
  },
  hydration: {
    contextRunner: async (_auth, callback) => callback({
      query: async (_sql, parameters) => {
        hydrationQueries += 1;
        await wait(180);
        const requested = JSON.parse(parameters[3]);
        return { rows: requested.map((candidate) => {
          const published = records.find((record) => record.record_id === candidate.record_id);
          const isWorkflow = candidate.record_type === 'WORKFLOW_RULE';
          return {
            record_type: candidate.record_type,
            record_id: candidate.record_id,
            knowledge_base_id: candidate.knowledge_base_id,
            tenant_id: tenantId,
            publication_revision: candidate.publication_revision,
            document_id: published.document_id,
            document_version_id: published.document_version_id,
            document_name: `tenant-source-${candidate.rank}.txt`,
            document_display_name: `Tenant Source ${candidate.rank}`,
            document_type: 'txt',
            document_status: 'ready', document_version_status: 'ready',
            document_version_is_current: true,
            source_page_start: published.source_page_start,
            source_page_end: published.source_page_start,
            source_section: published.question,
            source_line_start: candidate.rank * 10,
            source_line_end: candidate.rank * 10 + 4,
            language: 'mul',
            content: published.content,
            caller_facing: !isWorkflow,
            authoritative_data: isWorkflow ? {
              intent: 'submit_request', actionType: 'configured_tool',
              actionConfig: { toolIdentifier: 'submit_tenant_request' },
            } : { question: published.question, answer: published.answer },
            rank: candidate.rank, rrf_score: candidate.rrf_score,
          };
        }) };
      },
    }),
  },
});

assert.equal(hydrationQueries, 1, 'All selected IDs must be hydrated in one PostgreSQL query');
assert.ok(result.latency.retrievalMs > 150,
  'A retrieval target breach must still complete and proceed to hydration');
assert.ok(result.latency.retrievalMs < 1250,
  'The delayed retrieval must remain inside the production completion deadline');
assert.ok(result.latency.hydrationMs >= 180,
  'The authoritative PostgreSQL hydration must complete before evidence is evaluated');
assert.equal(result.authoritative.hydrationQueryCount, 1);
assert.ok(result.authoritative.fusion.candidates.length <= 5);
assert.ok(result.authoritative.evidence.length <= 5);
assert.equal(new Set(result.authoritative.fusion.candidates
  .map((candidate) => candidate.recordId)).size,
result.authoritative.fusion.candidates.length, 'RRF output must be deduplicated by record ID');
assert.ok(result.authoritative.evidence.every((source) => (
  source.tenantId === tenantId
  && source.agentId === agentId
  && source.knowledgeBaseId === knowledgeBaseId
  && source.publicationRevision === 9
  && source.documentId
  && source.documentVersionId
  && source.provenance.uploadedFilename
  && source.provenance.pageNumber
)));

const llm = result.llmInput;
assert.deepEqual(Object.keys(llm).sort(), [
  'ambiguityCandidates', 'canonicalMemory', 'currentQuestion', 'hydratedRecords',
  'clarificationContext', 'meaning', 'need', 'recentRelevantTurns', 'requestedFact', 'sourceMap',
  'toolSchemas', 'workflowAuthorization',
].sort());
assert.equal(llm.currentQuestion, input.latestQuestion);
assert.equal(llm.meaning.authority, 'GROUNDED_LLM');
assert.equal(llm.meaning.interpretationRequired, true);
assert.ok(Array.isArray(llm.meaning.entityCandidates));
assert.ok(Array.isArray(llm.meaning.phoneticCandidates));
assert.ok(llm.hydratedRecords.length <= 5);
assert.deepEqual(llm.hydratedRecords.filter((source) => source.callerFacing)
  .map((source) => source.sourceId), llm.hydratedRecords
  .filter((source) => source.callerFacing)
  .map((_source, index) => `source_${index + 1}`));
assert.equal(llm.hydratedRecords.filter((source) => !source.callerFacing)
  .every((source) => source.sourceId === null), true);
assert.deepEqual(llm.sourceMap.map((mapping) => mapping.sourceId),
  llm.hydratedRecords.filter((source) => source.callerFacing).map((source) => source.sourceId));
assert.ok(llm.sourceMap.every((mapping) => (
  mapping.publishedEvidenceId
  && mapping.authoritativeRecordId === mapping.recordId
  && mapping.canonicalRecordIdentityKey
)));
assert.equal(llm.recentRelevantTurns.length, 2);
assert.equal(llm.canonicalMemory.collectedToolFields.reference, 'A-10');
assert.equal(llm.workflowAuthorization.length, 1);
assert.equal(llm.toolSchemas[0].name, 'submit_tenant_request');
assert.equal(llm.toolSchemas[0].authorizationEvidenceId,
  llm.workflowAuthorization[0].workflowEvidenceId);
assert.equal(JSON.stringify(llm).includes('routingCandidates'), false);
assert.equal(JSON.stringify(llm).includes('providerScores'), false);

const strictUnifiedKnowledge = {
  found: true, route: 'knowledge_engine',
  content: 'Legacy content must not enter unified grounding.',
  matches: [{ id: 'legacy-match', content: 'Legacy match must not enter.' }],
  workflowHints: [{ responseMode: 'exact', content: 'Legacy workflow hint.' }],
  rankedEvidence: [{ content: 'Legacy ranked evidence.', route: 'legacy' }],
  tenantEvidence: {
    guidanceEvidence: [{
      recordId: 'legacy-guidance', recordType: 'CONVERSATION_NODE',
      callerFacing: true, content: 'Legacy guidance must not enter.',
      authoritativeData: { responseMode: 'exact' },
    }],
    llmEvidenceBundle: {
      decisionInput: { hydratedRecords: llm.hydratedRecords },
      sourceMap: llm.sourceMap, entities: [],
    },
  },
};
const strictEnvelope = buildUnifiedGroundingEnvelope(strictUnifiedKnowledge, {
  includePublishedMap: false, maximumSources: 5,
});
assert.deepEqual(strictEnvelope.sources.map((source) => source.id),
  llm.sourceMap.map((mapping) => mapping.sourceId),
  'Unified grounding must contain only mapped hydrated caller-facing records');
assert.equal(JSON.stringify(strictEnvelope).includes('Legacy'), false,
  'Legacy supplemental content must not enter a unified grounding envelope');
assert.throws(() => buildUnifiedGroundingEnvelope({
  found: true,
  content: 'A legacy content-only result must never enter a normal voice prompt.',
  matches: [{ content: 'Legacy supplemental result.' }],
  tenantEvidence: { sources: llm.hydratedRecords },
}), (error) => error.code === 'KNOWLEDGE_UNIFIED_EVIDENCE_BUNDLE_REQUIRED',
'Normal voice packaging must reject every non-unified legacy evidence shape');

const tamperedSourceMap = llm.sourceMap.map((mapping, index) => index === 0
  ? { ...mapping, tenantId: 'wrong-tenant' } : mapping);
assert.throws(() => buildGroundingEnvelope({
  ...strictUnifiedKnowledge,
  tenantEvidence: {
    llmEvidenceBundle: {
      ...strictUnifiedKnowledge.tenantEvidence.llmEvidenceBundle,
      sourceMap: tamperedSourceMap,
    },
  },
}), (error) => error.code === 'KNOWLEDGE_GROUNDED_SOURCE_MAP_INVALID',
'Cross-tenant or wrong-scope source mappings must fail closed');

assert.throws(() => buildGroundingEnvelope({
  ...strictUnifiedKnowledge,
  tenantEvidence: {
    llmEvidenceBundle: {
      ...strictUnifiedKnowledge.tenantEvidence.llmEvidenceBundle,
      sourceMap: [...llm.sourceMap, llm.sourceMap[0]],
    },
  },
}), (error) => error.code === 'KNOWLEDGE_GROUNDED_SOURCE_MAP_INCOMPLETE',
'Duplicate source mappings must fail one-to-one validation');
const namespaceFiltered = buildGroundedLlmInput({
  input,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: {
    candidateNamespace: 'CATALOG',
    candidate: { recordId: 'catalog-1', evidenceRecordIds: ['catalog-1'], explicit: true },
  },
  authoritative: {
    evidence: [
      {
        id: 'catalog-source', recordId: 'catalog-1', recordType: 'CATALOG_ITEM',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { itemKey: 'tenant-item', name: 'Tenant Item' },
      },
      {
        id: 'faq-source', recordId: 'faq-1', recordType: 'FAQ',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { question: 'Unrelated question', answer: 'Unrelated answer' },
      },
      {
        id: 'catalog-source-2', recordId: 'catalog-2', recordType: 'CATALOG_ITEM',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { itemKey: 'other-item', name: 'Other Item' },
      },
      {
        id: 'workflow-source', recordId: 'workflow-1', recordType: 'WORKFLOW_RULE',
        callerFacing: false, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { actionType: 'configured_tool', actionConfig: { toolIdentifier: 'other' } },
      },
    ].map((source, index) => ({
      ...source, tenantId, agentId, knowledgeBaseId, publicationRevision: 9,
      documentId: `namespace-document-${index}`,
      documentVersionId: `namespace-version-${index}`,
    })),
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(namespaceFiltered.hydratedRecords.map((source) => source.recordId),
  ['catalog-1', 'faq-1', 'catalog-2', 'workflow-1'],
  'Grounded packaging must preserve the verified hydration result without a second filter');

const currentConcernEvidence = buildGroundedLlmInput({
  input: {
    ...input,
    latestQuestion: 'A current tenant concern without a Catalog entity.',
    queryUnderstanding: {
      explicitEntities: [], explicitCategories: [], comparisonEntities: [],
      contextDependent: false,
      currentRouteSignal: { recordId: 'support-1', recordType: 'WORKFLOW_RULE' },
    },
    memory: {
      ...input.memory,
      activeTool: null,
      activeEntity: { recordId: 'stale-catalog', key: 'stale-item', name: 'Stale Item' },
    },
  },
  classification: { intentClass: 'KNOWN_INFORMATION' },
  resolution: {
    candidateNamespace: 'CATALOG', contextDependent: false,
    candidate: { recordId: 'stale-catalog', recordType: 'CATALOG_ITEM', explicit: false },
  },
  authoritative: {
    evidence: [
      {
        id: 'stale-source', recordId: 'stale-catalog', recordType: 'CATALOG_ITEM',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { itemKey: 'stale-item', name: 'Stale Item' },
      },
      {
        id: 'support-source', recordId: 'support-1', recordType: 'WORKFLOW_RULE',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { actionType: 'respond', responseTemplate: 'Published support response.' },
      },
      {
        id: 'general-source', recordId: 'general-1', recordType: 'KNOWLEDGE_CHUNK',
        callerFacing: true, hydrationValidated: true, publicationValidated: true,
        authoritativeData: { content: 'Published general support boundary.' },
      },
    ].map((source, index) => ({
      ...source, tenantId, agentId, knowledgeBaseId, publicationRevision: 9,
      documentId: `concern-document-${index}`,
      documentVersionId: `concern-version-${index}`,
    })),
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(currentConcernEvidence.hydratedRecords.map((source) => source.recordId),
  ['stale-catalog', 'support-1', 'general-1'],
  'Packaging must not reinterpret or remove the verified hydration result');
assert.ok(currentConcernEvidence.hydratedRecords.every((source) => source.sourceId),
  'Every caller-facing current-concern record must receive an LLM source ID');

const scopedCatalogEvidence = [
  ['reserved-item-a', 'CATALOG_ITEM', { itemKey: 'item-a', name: 'Item A' }],
  ['reserved-item-b', 'CATALOG_ITEM', { itemKey: 'item-b', name: 'Item B' }],
  ['reserved-category', 'CATALOG_CATEGORY', {
    categoryKey: 'category-a', category: 'Category A', children: [],
  }],
].map(([recordId, recordType, authoritativeData], index) => ({
  id: `published:${recordType.toLocaleLowerCase()}:${recordId}`,
  recordId, recordType, tenantId, agentId, knowledgeBaseId, publicationRevision: 9,
  callerFacing: true, hydrationValidated: true, publicationValidated: true,
  rank: index + 1, authoritativeData,
}));
const scopedReservation = (recordId, recordType, reason) => ({
  tenantId, knowledgeBaseId, publicationRevision: 9, recordId, recordType, reason,
});
const packagedIds = (options) => buildGroundedLlmInput({
  input: {
    ...input,
    queryUnderstanding: options.understanding,
    canonicalCallMemory: options.memory ?? {},
    memory: options.memory ?? {},
  },
  classification: { intentClass: options.intentClass ?? 'KNOWN_INFORMATION' },
  resolution: options.resolution ?? {
    candidate: null, candidateNamespace: null, contextDependent: false,
  },
  authoritative: {
    tenantId, agentId, callId,
    evidence: scopedCatalogEvidence,
    reservations: options.reservations,
  },
  runtimeProfile: { tools: [] },
}).hydratedRecords.map((source) => source.recordId);

assert.deepEqual(packagedIds({
  understanding: {
    explicitEntities: [{ recordId: 'reserved-item-a', recordType: 'CATALOG_ITEM' }],
    explicitCategories: [], comparisonEntities: [], contextDependent: false,
  },
  resolution: {
    candidate: {
      recordId: 'reserved-item-a', recordType: 'CATALOG_ITEM',
      entityType: 'ITEM', explicit: true,
    },
    candidateNamespace: 'CATALOG', contextDependent: false,
  },
  reservations: [scopedReservation('reserved-item-a', 'CATALOG_ITEM', 'explicit_entity')],
}), ['reserved-item-a', 'reserved-item-b', 'reserved-category'],
'Verified records must pass through packaging unchanged after explicit-item retrieval');

assert.deepEqual(packagedIds({
  understanding: {
    explicitEntities: [],
    explicitCategories: [{
      recordId: 'reserved-category', recordType: 'CATALOG_CATEGORY', entityType: 'CATEGORY',
    }],
    comparisonEntities: [], contextDependent: false,
  },
  resolution: {
    candidate: {
      recordId: 'reserved-category', recordType: 'CATALOG_CATEGORY',
      entityType: 'CATEGORY', explicit: true,
    },
    candidateNamespace: 'CATALOG', contextDependent: false,
  },
  reservations: [scopedReservation(
    'reserved-category', 'CATALOG_CATEGORY', 'explicit_entity',
  )],
}), ['reserved-item-a', 'reserved-item-b', 'reserved-category'],
'Verified records must pass through packaging unchanged after category retrieval');

assert.deepEqual(packagedIds({
  understanding: {
    explicitEntities: [], explicitCategories: [], comparisonEntities: [], contextDependent: true,
  },
  memory: {
    activeEntity: {
      recordId: 'reserved-item-a', recordType: 'CATALOG_ITEM',
      key: 'item-a', name: 'Item A',
    },
  },
  resolution: { candidate: null, candidateNamespace: null, contextDependent: true },
  reservations: [scopedReservation('reserved-item-a', 'CATALOG_ITEM', 'canonical_memory')],
}), ['reserved-item-a', 'reserved-item-b', 'reserved-category'],
'Verified records must pass through packaging unchanged after contextual retrieval');

assert.deepEqual(packagedIds({
  understanding: {
    explicitEntities: [], explicitCategories: [], contextDependent: false,
    comparisonEntities: [
      { recordId: 'reserved-item-a', recordType: 'CATALOG_ITEM', entityType: 'ITEM' },
      { recordId: 'reserved-item-b', recordType: 'CATALOG_ITEM', entityType: 'ITEM' },
    ],
  },
  intentClass: 'COMPARISON_COMPLEX',
  reservations: [
    scopedReservation('reserved-item-a', 'CATALOG_ITEM', 'explicit_comparison'),
    scopedReservation('reserved-item-b', 'CATALOG_ITEM', 'explicit_comparison'),
  ],
}), ['reserved-item-a', 'reserved-item-b', 'reserved-category'],
'Verified comparison records must pass through packaging without a destructive filter');

console.log(JSON.stringify({
  tasks: [4, 5, 6], passed: true,
  fusedRecords: result.authoritative.fusion.candidates.length,
  hydratedRecords: result.authoritative.evidence.length,
  hydrationQueries,
  llmEvidenceRecords: llm.hydratedRecords.length,
  workflowAuthorizations: llm.workflowAuthorization.length,
}, null, 2));
