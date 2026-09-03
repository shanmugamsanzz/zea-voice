import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { resolvePublishedEntityRoute } from '../src/knowledge-engine/entity-route-resolver.js';
import {
  classifyKnowledgeQuery,
  knowledgeQueryClasses,
  knowledgeSearchIndexes,
} from '../src/knowledge-engine/query-classifier.js';
import { retrieveTargetedCandidates } from '../src/knowledge-engine/targeted-retrieval.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { QDRANT_SEARCH_LIMIT_MAX } from '../src/rag/qdrant.client.js';

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
    recentRelevantTurns: options.recentRelevantTurns ?? [],
    queryUnderstanding: options.queryUnderstanding ?? null,
  });
  const resolution = resolvePublishedEntityRoute(input, bundle);
  const classification = classifyKnowledgeQuery(input, resolution);
  return { input, resolution, classification };
}

let embedCalls = 0;
let searchCalls = 0;
let embeddedText = null;
let qdrantOptions = null;
let qdrantOptionCalls = [];
let startedChannels = [];
let observedChannelScopes = [];
const providers = {
  onChannelStart: (channel, scope) => {
    startedChannels.push(channel);
    observedChannelScopes.push(scope);
  },
  embed: async (text) => { embedCalls += 1; embeddedText = text; return [0.1, 0.2]; },
  search: async (_tenant, _vector, options) => {
    searchCalls += 1;
    assert.ok(options.recordTypes.length > 0);
    qdrantOptions = options;
    qdrantOptionCalls.push(options);
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
      {
        id: '83000000-0000-4000-8000-000000000099', score: 1,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
          publication_revision: 7, record_type: 'CATALOG_ITEM',
          record_id: '83000000-0000-4000-8000-000000000099',
          agent_usage: 'BOTH',
        },
      },
      {
        id: alpha.record_id, score: 1,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
          publication_revision: 6, record_type: 'CATALOG_ITEM',
          record_id: alpha.record_id, agent_usage: 'BOTH',
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
assert.equal(new Set(observedChannelScopes).size, 1,
  'Every parallel channel must receive the same immutable retrieval scope');
assert.ok(Object.isFrozen(observedChannelScopes[0]));
assert.equal(observedChannelScopes[0].tenantId, tenantId);
assert.equal(observedChannelScopes[0].agentId, agentId);
assert.equal(observedChannelScopes[0], retrieval.retrievalScope);
assert.deepEqual(observedChannelScopes[0].knowledgeBases,
  [{ id: knowledgeBaseId, publicationRevision: 7 }]);
assert.equal(observedChannelScopes[0].usageDirection, 'inbound');
assert.deepEqual(observedChannelScopes[0].namespaces, ['CATALOG']);
assert.deepEqual(new Set(observedChannelScopes[0].recordTypes), new Set(retrieval.recordTypes));
assert.equal(embedCalls, 1);
assert.equal(searchCalls, 1);
assert.ok(retrieval.channels.qdrant.every((candidate) => (
  candidate.recordId !== '83000000-0000-4000-8000-000000000099'
)), 'Qdrant hits absent from the authoritative publication scope must be rejected');

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
assert.equal(searchCalls, 4,
  'Semantic retrieval must query each selected namespace independently');
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

request = prepared('context-only follow-up without preclassified facts', {
  memory: { activeEntity: { recordId: alpha.record_id, itemKey: 'alpha' } },
  queryUnderstanding: {
    contextDependent: true,
    canonicalContext: {
      recordId: alpha.record_id, recordType: 'CATALOG_ITEM',
      entityType: 'ITEM', name: 'Alpha option',
    },
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.ok(retrieval.channels.structured.some((candidate) => (
  candidate.recordId === alpha.record_id && candidate.matchMethod === 'call_memory'
)), 'a genuinely contextual turn must reserve canonical call memory before retrieval ranking');
qdrantOptionCalls = [];
request = prepared('contextual follow-up', {
  memory: {
    activeEntity: {
      recordId: alpha.record_id, itemKey: 'alpha', name: 'Alpha option',
    },
  },
  requestedFacts: ['approved_metric'],
  recentRelevantTurns: [
    { role: 'user', content: 'Earlier caller question about Alpha option.' },
    { role: 'assistant', content: 'Earlier grounded answer about Alpha option.' },
  ],
  queryUnderstanding: {
    contextDependent: true,
    canonicalContext: {
      recordId: alpha.record_id, recordType: 'CATALOG_ITEM',
      entityType: 'ITEM', name: 'Alpha option',
    },
    requestedFacts: ['approved_metric'],
    explicitEntities: [],
    explicitCategories: [],
    comparisonEntities: [],
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(retrieval.queryContext.canonicalEntity.recordId, alpha.record_id);
assert.equal(retrieval.queryContext.relevantNamespace, 'CATALOG');
assert.deepEqual(retrieval.queryContext.filters, {
  tenantId, agentId,
  knowledgeBases: [{ id: knowledgeBaseId, publicationRevision: 7 }],
  usageDirection: 'inbound', namespace: 'CATALOG', namespaces: ['CATALOG'],
});
assert.equal(retrieval.queryContext.reservedRecords[0].recordId, alpha.record_id);
assert.equal(retrieval.queryContext.reservedRecords[0].reason, 'canonical_memory');
assert.match(retrieval.queryContext.contextualText, /Earlier caller question about Alpha option/u);
assert.match(retrieval.queryContext.contextualText, /Earlier grounded answer about Alpha option/u);
assert.equal(retrieval.channels.structured[0].recordId, alpha.record_id);
assert.ok(retrieval.channels.bm25.some((candidate) => candidate.recordId === alpha.record_id));
assert.match(embeddedText, /contextual follow-up Alpha option approved_metric/u);
assert.equal(qdrantOptions.agentId, agentId);
assert.deepEqual(qdrantOptions.knowledgeBases,
  [{ id: knowledgeBaseId, publicationRevision: 7 }]);
assert.equal(qdrantOptions.usageDirection, 'inbound');
assert.ok(qdrantOptionCalls.every((options) => options.recordTypes.length <= 2),
  'Each semantic search must remain isolated to one namespace');
assert.deepEqual(new Set(qdrantOptionCalls.flatMap((options) => options.recordTypes)),
  new Set(retrieval.recordTypes),
  'Independent semantic namespace searches must cover the complete retrieval scope');

qdrantOptionCalls = [];
const allNamespaceRequest = prepared('tenant-wide published information');
const allNamespaceClassification = Object.freeze({
  ...allNamespaceRequest.classification,
  selectedNamespace: 'GENERAL',
  relevantNamespaces: Object.freeze([
    'CATALOG', 'FAQ', 'GENERAL', 'CONVERSATION', 'WORKFLOW',
  ]),
  retrievalPlan: Object.freeze({
    ...allNamespaceRequest.classification.retrievalPlan,
    indexes: Object.freeze([
      knowledgeSearchIndexes.CATALOG,
      knowledgeSearchIndexes.FAQ,
      knowledgeSearchIndexes.GENERAL,
      knowledgeSearchIndexes.CONVERSATION,
      knowledgeSearchIndexes.WORKFLOW,
      knowledgeSearchIndexes.BM25,
      knowledgeSearchIndexes.SEMANTIC,
    ]),
  }),
});
const allNamespaceRetrieval = await retrieveTargetedCandidates({
  input: allNamespaceRequest.input,
  resolution: allNamespaceRequest.resolution,
  classification: allNamespaceClassification,
  publicationBundles: [bundle],
  sparseIndexes: [sparseIndex],
}, providers);
assert.equal(qdrantOptionCalls.length, 5,
  'Catalog, FAQ, General, Conversation and Workflow must be searched independently');
assert.deepEqual(Object.keys(allNamespaceRetrieval.namespaceChannels.qdrant).sort(),
  ['CATALOG', 'CONVERSATION', 'FAQ', 'GENERAL', 'WORKFLOW']);
assert.ok(Object.values(allNamespaceRetrieval.channels).flat().every((candidate) => (
  candidate.canonicalIdentity.tenantId === tenantId.toLowerCase()
  && candidate.canonicalIdentity.knowledgeBaseId === knowledgeBaseId.toLowerCase()
  && candidate.canonicalIdentity.publicationRevision === 7
)), 'Every channel result must retain the active tenant and publication identity');

request = prepared('alpha beta', {
  queryUnderstanding: {
    contextDependent: false,
    canonicalContext: null,
    requestedFacts: ['comparison'],
    explicitEntities: [
      { recordId: alpha.record_id, recordType: 'CATALOG_ITEM', entityType: 'ITEM', name: 'Alpha option' },
      { recordId: beta.record_id, recordType: 'CATALOG_ITEM', entityType: 'ITEM', name: 'Beta option' },
    ],
    explicitCategories: [],
    comparisonEntities: [
      { recordId: alpha.record_id, recordType: 'CATALOG_ITEM', entityType: 'ITEM', name: 'Alpha option' },
      { recordId: beta.record_id, recordType: 'CATALOG_ITEM', entityType: 'ITEM', name: 'Beta option' },
    ],
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.deepEqual(new Set(retrieval.queryContext.reservedRecords
  .map((candidate) => candidate.recordId)), new Set([alpha.record_id, beta.record_id]));
assert.deepEqual(new Set(retrieval.channels.structured.slice(0, 2)
  .map((candidate) => candidate.recordId)), new Set([alpha.record_id, beta.record_id]));

request = prepared('beta', {
  memory: {
    activeEntity: {
      recordId: alpha.record_id, itemKey: 'alpha', name: 'Alpha option',
    },
  },
  queryUnderstanding: {
    contextDependent: false,
    canonicalContext: {
      recordId: beta.record_id, recordType: 'CATALOG_ITEM',
      entityType: 'ITEM', name: 'Beta option',
    },
    requestedFacts: [],
    explicitEntities: [
      { recordId: beta.record_id, recordType: 'CATALOG_ITEM', entityType: 'ITEM', name: 'Beta option' },
    ],
    explicitCategories: [],
    comparisonEntities: [],
  },
});
retrieval = await retrieveTargetedCandidates({
  ...request, publicationBundles: bundle, sparseIndexes: [sparseIndex],
}, providers);
assert.equal(retrieval.queryContext.canonicalEntity.recordId, beta.record_id);
assert.deepEqual(retrieval.queryContext.reservedRecords.map((candidate) => candidate.recordId),
  [beta.record_id], 'A latest explicit entity must reserve itself, never stale canonical memory');
assert.equal(retrieval.channels.structured[0].recordId, beta.record_id);

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
    assert.equal(candidate.tenantId, tenantId,
      'Every frozen retrieval candidate must preserve its tenant scope');
    assert.equal(candidate.agentId, agentId,
      'Every frozen retrieval candidate must preserve its agent scope');
    assert.equal(candidate.canonicalIdentity.tenantId, tenantId.toLowerCase());
    assert.equal(candidate.canonicalIdentity.knowledgeBaseId, knowledgeBaseId.toLowerCase());
    assert.equal(candidate.canonicalIdentity.publicationRevision, 7);
    assert.equal(candidate.canonicalIdentity.recordId, candidate.recordId.toLowerCase());
    assert.ok(candidate.canonicalIdentityKey);
    assert.deepEqual(Object.keys(candidate).sort(), [
      'agentId', 'authorizationHint', 'callerFacingHint', 'canonicalIdentity', 'canonicalIdentityKey',
      'channel', 'deduplicationIdentity', 'knowledgeBaseId',
      'namespace', 'namespaceRank', 'publicationRevision', 'rank',
      'recordId', 'recordType', 'score', 'tenantId',
      ...(candidate.tokenCoverage === undefined ? [] : ['tokenCoverage']),
      ...(candidate.matchMethod === undefined ? [] : ['matchMethod']),
      ...(candidate.categoryKey === undefined ? [] : ['categoryKey']),
      ...(candidate.evidenceRecordIds === undefined ? [] : ['evidenceRecordIds']),
    ].sort());
  }
}

let observedSemanticLimit = null;
const channelIsolated = await retrieveTargetedCandidates({
  ...prepared('detail phrase'), publicationBundles: [bundle], sparseIndexes: [sparseIndex],
}, {
  embed: async () => [0.1, 0.2],
  search: async (_tenant, _vector, options) => {
    observedSemanticLimit = options.limit;
    throw new TypeError('Synthetic Qdrant channel failure');
  },
});
assert.ok(observedSemanticLimit > 0 && observedSemanticLimit <= QDRANT_SEARCH_LIMIT_MAX,
  'Semantic retrieval must never request more than the Qdrant client maximum');
assert.ok(channelIsolated.channels.bm25.length > 0,
  'A Qdrant failure must not discard healthy BM25 results');
assert.deepEqual(channelIsolated.channels.qdrant, []);
assert.equal(channelIsolated.channelFailures.length, 1);
assert.equal(channelIsolated.channelFailures[0].channel, 'qdrant');
assert.match(channelIsolated.channelFailures[0].message, /Synthetic Qdrant channel failure/u);

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
