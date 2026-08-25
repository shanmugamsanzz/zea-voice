import assert from 'node:assert/strict';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import {
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
    embed: async () => [0.1, 0.2],
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
  'assignedToolSchemas', 'contractVersion', 'currentQuestion', 'evidence', 'memory',
  'permittedSourceIds', 'sourceMap', 'workflowAuthorization',
].sort());
assert.equal(llm.currentQuestion, input.latestQuestion);
assert.ok(llm.evidence.length <= 5);
assert.equal(llm.sourceMap.length, llm.evidence.length);
assert.ok(llm.sourceMap.every((source, index) => source.sourceId === `source_${index + 1}`));
assert.equal(llm.memory.recentTurns.length, 2);
assert.equal(llm.memory.collectedToolFields.reference, 'A-10');
assert.equal(llm.workflowAuthorization.length, 1);
assert.equal(llm.assignedToolSchemas[0].name, 'submit_tenant_request');
assert.equal(llm.assignedToolSchemas[0].authorizationEvidenceId,
  llm.workflowAuthorization[0].workflowEvidenceId);
assert.ok(llm.permittedSourceIds.response.length > 0);
assert.equal(llm.permittedSourceIds.tool.length, 1);
assert.equal(JSON.stringify(llm).includes('routingCandidates'), false);
assert.equal(JSON.stringify(llm).includes('providerScores'), false);

console.log(JSON.stringify({
  tasks: [4, 5, 6], passed: true,
  fusedRecords: result.authoritative.fusion.candidates.length,
  hydratedRecords: result.authoritative.evidence.length,
  hydrationQueries,
  llmEvidenceRecords: llm.evidence.length,
  workflowAuthorizations: llm.workflowAuthorization.length,
}, null, 2));
