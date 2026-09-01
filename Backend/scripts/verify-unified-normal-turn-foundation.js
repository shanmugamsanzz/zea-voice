import assert from 'node:assert/strict';
import {
  createGroundedLlmOutput,
  createNormalTurnInput,
  deterministicProtocolExceptionTypes,
  groundedLlmOutputTypes,
  isDeterministicProtocolException,
  toKnowledgeEngineInput,
  unifiedNormalTurnContract,
} from '../src/knowledge-bases/normal-turn-contract.js';
import { searchParallelHybridCandidates } from '../src/knowledge-bases/parallel-hybrid-search.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { resolvePublishedEntityRoute } from '../src/knowledge-engine/entity-route-resolver.js';
import { classifyKnowledgeQuery } from '../src/knowledge-engine/query-classifier.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';

const scope = Object.freeze({
  tenantId: '91000000-0000-4000-8000-000000000001',
  agentId: '91000000-0000-4000-8000-000000000002',
  callId: '91000000-0000-4000-8000-000000000003',
});
const normalTurn = createNormalTurnInput({
  ...scope,
  usageDirection: 'inbound',
  finalizedQuestion: 'Tell me more about this option',
  memory: {
    scope,
    activeEntity: {
      recordId: '91000000-0000-4000-8000-000000000011',
      key: 'tenant-option', name: 'Tenant Option', recordType: 'CATALOG_ITEM',
    },
    activeCategory: { key: 'tenant-options', name: 'Tenant Options' },
    requestedFacts: ['details'],
    recentTurns: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `turn ${index}`,
    })),
    pendingClarification: { kind: 'ambiguity', text: 'Which option?' },
    activeTool: {
      name: 'tenant_action', status: 'collecting_information',
      authorizationRecordId: 'workflow-record-1',
      workflowState: {
        version: 1,
        selectedRecord: { recordId: 'workflow-record-1', recordType: 'WORKFLOW_RULE' },
        toolIdentifier: 'tenant_action',
        requiredFields: ['quantity', 'delivery_window'],
        missingFields: ['delivery_window'],
        collectedFields: { quantity: 3 },
        confirmationRequired: true,
        confirmationStatus: 'pending_fields',
      },
    },
    collectedToolFields: { quantity: 3 },
    knownEntities: [{ name: 'must not be copied as unbounded memory' }],
  },
});
assert.deepEqual(unifiedNormalTurnContract.input, ['question', 'memory', 'scope']);
assert.deepEqual(unifiedNormalTurnContract.output, ['RESPONSE', 'TOOL', 'CLARIFY']);
assert.deepEqual(unifiedNormalTurnContract.deterministicProtocolExceptions,
  ['SAFETY_EMERGENCY', 'EXPLICIT_HANGUP']);
assert.equal(Object.isFrozen(unifiedNormalTurnContract), true);
assert.equal(Object.isFrozen(unifiedNormalTurnContract.input), true);
assert.equal(normalTurn.question, 'Tell me more about this option');
assert.equal(normalTurn.currentQuestion, 'Tell me more about this option');
assert.equal(normalTurn.memory.activeEntity.recordId,
  '91000000-0000-4000-8000-000000000011');
assert.equal(normalTurn.memory.recentTurns.length, 8);
assert.equal(normalTurn.memory.knownEntities, undefined);
assert.deepEqual(normalTurn.memory.collectedToolFields, { quantity: 3 });
assert.equal(normalTurn.memory.activeTool.workflowState.selectedRecord.recordId,
  'workflow-record-1');
assert.deepEqual(normalTurn.memory.activeTool.workflowState.missingFields,
  ['delivery_window']);
const engineInput = toKnowledgeEngineInput(normalTurn);
assert.equal(engineInput.latestQuestion, normalTurn.currentQuestion);
assert.equal(engineInput.memory.activeEntity.key, 'tenant-option');
assert.throws(() => createNormalTurnInput({
  ...scope, finalizedQuestion: 'question',
  memory: { scope: { ...scope, callId: 'another-call' } },
}), /does not match the active call scope/u);

for (const type of Object.values(groundedLlmOutputTypes)) {
  const output = createGroundedLlmOutput(type, type === 'RESPONSE' ? {
    text: 'Grounded response.', selectedEvidenceIds: ['source_1'],
  } : type === 'TOOL' ? {
    selectedEvidenceIds: ['source_2'],
    tool: { name: 'tenant_action', authorizationEvidenceId: 'source_2', input: { quantity: 3 } },
  } : { text: 'Which published option do you mean?' });
  assert.equal(output.type, type);
  assert.equal(output.origin, 'GROUNDED_LLM');
}
assert.throws(() => createGroundedLlmOutput('DIRECT', { text: 'invalid' }), /Unsupported/u);
assert.equal(isDeterministicProtocolException(
  deterministicProtocolExceptionTypes.SAFETY_EMERGENCY,
), true);
assert.equal(isDeterministicProtocolException(
  deterministicProtocolExceptionTypes.EXPLICIT_HANGUP,
), true);
assert.equal(isDeterministicProtocolException('CALL_CONTROL'), false);

const knowledgeBaseId = '91000000-0000-4000-8000-000000000004';
const job = {
  tenant_id: scope.tenantId, knowledge_base_id: knowledgeBaseId,
  targetRevision: 2, knowledge_base_usage: 'both', assigned_agent_ids: [scope.agentId],
};
const record = {
  record_id: '91000000-0000-4000-8000-000000000011',
  record_type: 'catalog_item',
  document_id: '92000000-0000-4000-8000-000000000011',
  document_version_id: '93000000-0000-4000-8000-000000000011',
  usage_direction: 'both', language: 'mul', source_page_start: 1,
  question: 'Tenant Option', answer: 'Published tenant answer.', content: 'Published tenant answer.',
  entity_name: 'Tenant Option', entity_aliases: ['tenant choice'],
  entity_category: 'Tenant Options', entity_category_aliases: [],
  entity_metadata: { itemKey: 'tenant-option', categoryKey: 'tenant-options' },
};
const bundle = buildPublicationIndexes(job, [record]);
const sparseIndex = buildRevisionSparseIndex(job, bundle.records);
const retrievalInput = toKnowledgeEngineInput(createNormalTurnInput({
  ...scope, finalizedQuestion: 'tenant choice', usageDirection: 'inbound', memory: { scope },
}));
const resolution = resolvePublishedEntityRoute(retrievalInput, bundle);
const classification = classifyKnowledgeQuery(retrievalInput, resolution);
const started = [];
const retrieval = await searchParallelHybridCandidates({
  input: retrievalInput, classification, resolution,
  publicationBundles: [bundle], sparseIndexes: [sparseIndex],
}, {
  onChannelStart: (channel) => started.push(channel),
  embed: async () => [0.1, 0.2],
  search: async (tenantId, _vector, options) => {
    assert.equal(tenantId, scope.tenantId);
    assert.equal(options.agentId, scope.agentId);
    assert.equal(options.usageDirection, 'inbound');
    assert.deepEqual(options.knowledgeBases, [{ id: knowledgeBaseId, publicationRevision: 2 }]);
    return [{
      id: record.record_id, score: 0.9,
      payload: {
        tenant_id: scope.tenantId, knowledge_base_id: knowledgeBaseId,
        publication_revision: 2, record_type: 'CATALOG_ITEM',
        record_id: record.record_id, agent_usage: 'both',
      },
    }];
  },
});
assert.equal(retrieval.executionMode, 'parallel_hybrid');
assert.deepEqual(new Set(started), new Set(['structured', 'bm25', 'qdrant']));
assert.ok(retrieval.channels.structured.length > 0);
assert.ok(retrieval.channels.bm25.length > 0);
assert.ok(retrieval.channels.qdrant.length > 0);
for (const channel of Object.values(retrieval.channels)) {
  assert.ok(channel.every((candidate) => (
    candidate.knowledgeBaseId === knowledgeBaseId
    && candidate.publicationRevision === 2
  )));
}

await assert.rejects(() => searchParallelHybridCandidates({
  input: retrievalInput, classification, resolution,
  publicationBundles: [{ ...bundle, tenantId: 'another-tenant' }],
  sparseIndexes: [sparseIndex],
}), /same-tenant/u);

console.log(JSON.stringify({
  tasks: [1, 2, 3], passed: true,
  contractOutputs: Object.values(groundedLlmOutputTypes),
  isolatedMemory: true,
  parallelChannels: ['structured', 'bm25', 'qdrant'],
}, null, 2));
