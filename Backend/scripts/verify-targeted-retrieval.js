import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { resolvePublishedEntityRoute } from '../src/knowledge-engine/entity-route-resolver.js';
import { classifyKnowledgeQuery, knowledgeQueryClasses } from '../src/knowledge-engine/query-classifier.js';
import { retrieveTargetedCandidates } from '../src/knowledge-engine/targeted-retrieval.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';

const tenantId = '80000000-0000-4000-8000-000000000001';
const agentId = '80000000-0000-4000-8000-000000000002';
const callId = '80000000-0000-4000-8000-000000000003';
const knowledgeBaseId = '80000000-0000-4000-8000-000000000004';
const job = {
  tenant_id: tenantId,
  knowledge_base_id: knowledgeBaseId,
  targetRevision: 7,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [agentId],
};

function record(index, type, value) {
  return {
    record_id: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    record_type: type,
    document_id: `81000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    document_version_id: `82000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    usage_direction: 'both', language: 'mul', source_page_start: 1,
    entity_aliases: [], entity_category_aliases: [], entity_metadata: {}, ...value,
  };
}

const alpha = record(1, 'catalog_item', {
  question: 'Alpha option', answer: 'Sensitive alpha fact.', content: 'Sensitive alpha fact.',
  entity_name: 'Alpha option', entity_category: 'Options', entity_aliases: ['alpha'],
  entity_metadata: { itemKey: 'alpha', categoryKey: 'options' },
});
const beta = record(2, 'catalog_item', {
  question: 'Beta option', answer: 'Sensitive beta fact.', content: 'Sensitive beta fact.',
  entity_name: 'Beta option', entity_category: 'Options', entity_aliases: ['beta'],
  entity_metadata: { itemKey: 'beta', categoryKey: 'options' },
});
const faq = record(3, 'faq', {
  question: 'Detail phrase', answer: 'Sensitive FAQ fact.', content: 'Detail phrase sensitive FAQ fact.',
  entity_aliases: ['detail phrase'], entity_metadata: { intentClass: 'DETAILS_OR_PRICE' },
});
const workflow = record(4, 'workflow_rule', {
  question: 'Action phrase', answer: 'Sensitive workflow response.', content: 'Action workflow.',
  entity_name: 'Action route', entity_category: 'action', entity_aliases: ['action phrase'],
  entity_metadata: {
    conditions: { examples: ['action phrase'], intentClass: 'ACTION_TOOL_REQUEST' },
    actionType: 'configured_tool',
    actionConfig: {
      responseMode: 'instruction', toolIdentifier: 'tenant_action',
      requiresCatalogItem: true, scenarioTargetItemKey: 'alpha',
    },
  },
});
const conversation = record(5, 'conversation_node', {
  question: 'Ack route', answer: 'Sensitive acknowledgement.', content: 'Sensitive acknowledgement.',
  entity_name: 'Ack route', entity_category: 'main', entity_aliases: ['ack phrase'],
  entity_metadata: { intentClass: 'ACKNOWLEDGEMENT' },
});
const general = record(6, 'knowledge_chunk', {
  question: null, answer: 'Obscure policy words.', content: 'Obscure policy words and supporting context.',
});

const bundle = buildPublicationIndexes(job, [alpha, beta, faq, workflow, conversation, general]);
const sparseIndex = buildRevisionSparseIndex(job, bundle.records);

function prepared(utterance, options = {}) {
  const input = createKnowledgeEngineInput({
    tenantId, agentId, callId, utterance,
    memory: options.memory ?? {}, requestedFacts: options.requestedFacts ?? [],
  });
  const resolution = resolvePublishedEntityRoute(input, bundle);
  const classification = classifyKnowledgeQuery(input, resolution);
  return { input, resolution, classification };
}

let embedCalls = 0;
let searchCalls = 0;
let startedChannels = [];
const providers = {
  onChannelStart: (channel) => { startedChannels.push(channel); },
  embed: async () => { embedCalls += 1; return [0.1, 0.2]; },
  search: async (_tenant, _vector, options) => {
    searchCalls += 1;
    assert.ok(options.recordTypes.length > 0);
    return [
      {
        id: beta.record_id, score: 0.91,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
          publication_revision: 7, record_type: 'CATALOG_ITEM',
          record_id: beta.record_id, agent_usage: 'BOTH', content: 'must not escape',
        },
      },
      {
        id: workflow.record_id, score: 0.99,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
          publication_revision: 7, record_type: 'WORKFLOW_RULE',
          record_id: workflow.record_id, agent_usage: 'BOTH',
        },
      },
      {
        id: faq.record_id, score: 0.98,
        payload: {
          tenant_id: 'another-tenant', knowledge_base_id: knowledgeBaseId,
          publication_revision: 7, record_type: 'FAQ',
          record_id: faq.record_id, agent_usage: 'BOTH',
        },
      },
    ];
  },
};

let request = prepared('alpha');
let retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: [bundle], sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.KNOWN_INFORMATION);
assert.deepEqual(retrieval.channels.structured.map((candidate) => candidate.recordId), [alpha.record_id]);
assert.ok(retrieval.channels.bm25.some((candidate) => candidate.recordId === alpha.record_id));
assert.deepEqual(retrieval.channels.qdrant.map((candidate) => candidate.recordId), [beta.record_id]);
assert.deepEqual(new Set(startedChannels), new Set(['structured', 'bm25', 'qdrant']),
  'Structured, BM25 and Qdrant channels must all be scheduled for normal knowledge turns');
assert.equal(embedCalls, 1);
assert.equal(searchCalls, 1);

request = prepared('detail phrase');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.DETAILS_OR_PRICE);
assert.ok(retrieval.channels.structured.some((candidate) => candidate.recordId === faq.record_id));
assert.ok(retrieval.channels.bm25.some((candidate) => candidate.recordId === faq.record_id));
assert.deepEqual(retrieval.channels.qdrant.map((candidate) => candidate.recordId), [beta.record_id]);

request = prepared('alpha beta');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: [bundle], sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.COMPARISON_COMPLEX);
assert.deepEqual(new Set(retrieval.channels.structured.map((candidate) => candidate.recordId)),
  new Set([alpha.record_id, beta.record_id]));
assert.deepEqual(retrieval.channels.qdrant.map((candidate) => candidate.recordId), [beta.record_id],
  'Qdrant results must be tenant, revision and record-type scoped');
assert.equal(embedCalls, 3);
assert.equal(searchCalls, 3);
assert.ok(!retrieval.recordTypes.includes('WORKFLOW_RULE'));

request = prepared('action phrase');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST);
assert.deepEqual(retrieval.channels.structured.map((candidate) => candidate.recordId), [workflow.record_id]);
assert.equal(retrieval.channels.bm25.length, 0);
assert.equal(retrieval.channels.qdrant.length, 0);
assert.equal(embedCalls, 3);
request = prepared('action phrase alpha');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST);
assert.deepEqual(new Set(retrieval.channels.structured.map((candidate) => candidate.recordId)),
  new Set([workflow.record_id, alpha.record_id]),
  'An explicit action and Catalog item in the same utterance must be hydrated together');
assert.equal(retrieval.channels.bm25.length, 0);
assert.equal(retrieval.channels.qdrant.length, 0);

request = prepared('action phrase', {
  memory: {
    activeEntity: { recordId: alpha.record_id, itemKey: 'alpha' },
    activeTool: { name: 'tenant_action', authorizationRecordId: workflow.record_id },
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.deepEqual(new Set(retrieval.channels.structured.map((candidate) => candidate.recordId)),
  new Set([workflow.record_id, alpha.record_id]),
  'An authorized action must retrieve its Workflow and the active Catalog item in one turn');

request = prepared('tenant field value', {
  memory: {
    activeEntity: { recordId: alpha.record_id, itemKey: 'alpha' },
    activeTool: { name: 'tenant_action', authorizationRecordId: workflow.record_id },
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST);
assert.deepEqual(new Set(retrieval.channels.structured.map((candidate) => candidate.recordId)),
  new Set([workflow.record_id, alpha.record_id]),
  'Tool field answers must preserve the published Workflow and selected Catalog authorization');

request = prepared('obscure policy words extra');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.UNKNOWN);
assert.ok(retrieval.channels.bm25.some((candidate) => candidate.recordId === general.record_id));
assert.deepEqual(retrieval.channels.qdrant.map((candidate) => candidate.recordId), [beta.record_id]);
assert.ok(retrieval.recordTypes.includes('KNOWLEDGE_CHUNK'));
assert.ok(!retrieval.recordTypes.includes('WORKFLOW_RULE'));

request = prepared('Options');
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: [bundle], sparseIndexes: [sparseIndex],
}, providers);
assert.equal(request.classification.intentClass, knowledgeQueryClasses.CATEGORY_OVERVIEW);
assert.equal(retrieval.channels.structured.length, 1,
  'A category must remain one retrieval candidate instead of expanding into competing children');
assert.equal(retrieval.channels.structured[0].recordType, 'CATALOG_CATEGORY');
assert.equal(retrieval.channels.structured[0].categoryKey, 'options');
assert.deepEqual(new Set(retrieval.channels.structured[0].evidenceRecordIds),
  new Set([alpha.record_id, beta.record_id]));
assert.equal(retrieval.channels.bm25.length, 0);
assert.equal(retrieval.channels.qdrant.length, 0);

const serialized = JSON.stringify(retrieval);
for (const forbidden of [
  'Sensitive alpha fact', 'Sensitive beta fact', 'Sensitive FAQ fact',
  'Sensitive workflow response', 'must not escape',
]) assert.doesNotMatch(serialized, new RegExp(forbidden, 'u'));
for (const channel of Object.values(retrieval.channels)) {
  for (const candidate of channel) {
    assert.deepEqual(Object.keys(candidate).sort(), [
      'channel', 'knowledgeBaseId', 'publicationRevision', 'rank',
      'recordId', 'recordType', 'score', ...(candidate.tokenCoverage === undefined ? [] : ['tokenCoverage']),
      ...(candidate.matchMethod === undefined ? [] : ['matchMethod']),
      ...(candidate.categoryKey === undefined ? [] : ['categoryKey']),
      ...(candidate.evidenceRecordIds === undefined ? [] : ['evidenceRecordIds']),
    ].sort());
  }
}

await assert.rejects(() => retrieveTargetedCandidates({
  ...prepared('alpha'),
  publicationBundles: [{ ...bundle, tenantId: 'different-tenant' }],
  sparseIndexes: [sparseIndex],
}, providers), /same-tenant/u);

await assert.rejects(() => retrieveTargetedCandidates({
  ...prepared('alpha'),
  publicationBundles: [{ ...bundle, assignedAgentIds: ['another-agent'] }],
  sparseIndexes: [sparseIndex],
}, providers), /active agent/u);

console.log('Targeted structured, BM25 and Qdrant candidate-only retrieval verified.');
