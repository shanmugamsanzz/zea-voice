import assert from 'node:assert/strict';
import {
  classifyTemplateEngineSearch,
  constrainHybridToRequestedEntities,
  retrieveTemplateEngineEvidence,
} from '../src/voice/interaction/template-engine-production-retrieval.js';
import {
  publishedResolutionAmbiguity,
  runTemplateEngineProductionTurn,
} from '../src/voice/interaction/template-engine-production-runtime.js';
import { recordTemplateEngineTurnMetrics } from '../src/voice/interaction/template-engine-observability.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const publication = { knowledgeBaseId, publicationRevision: 4 };
const scope = { tenantId, agentId, publications: [publication] };

const ambiguousCandidates = [
  { recordId: 'record-a', recordType: 'CATALOG_ITEM', label: 'Option A' },
  { recordId: 'record-b', recordType: 'CATALOG_ITEM', label: 'Option B' },
];
const fuzzyAmbiguity = {
  ambiguity: { detected: true, candidates: ambiguousCandidates },
  routingCandidates: ambiguousCandidates, requiresCandidateConfirmation: true,
};
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, [{
  recordId: 'record-a', recordType: 'CATALOG_ITEM', verified: true,
}], { searchKind: 'named_entity' }).required, false,
'One exactly hydrated candidate must clear earlier fuzzy ambiguity');
const genuineAmbiguity = publishedResolutionAmbiguity(fuzzyAmbiguity, [
  { recordId: 'record-a', recordType: 'CATALOG_ITEM', verified: true },
  { recordId: 'record-b', recordType: 'CATALOG_ITEM', verified: true },
], { searchKind: 'named_entity' });
assert.equal(genuineAmbiguity.required, true);
assert.deepEqual(genuineAmbiguity.candidates, ['Option A', 'Option B']);
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, ambiguousCandidates.map((entry) => ({
  ...entry, verified: true,
})), { searchKind: 'comparison', requestedEntityRecordIds: ['record-a', 'record-b'] }).required,
false, 'Fully hydrated comparison operands are not ambiguous alternatives');
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, [], {
  searchKind: 'comparison', requestedEntityRecordIds: ['record-a', 'record-b'],
}).required, true, 'Requested IDs alone must not count as verified resolution');
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, [], {
  searchKind: 'overview',
}).required, false, 'A general overview must not clarify between its listed entities');

for (const scenario of [
  {
    expected: 'overview', search: { requestedFact: 'available options' },
    conversationGuidance: { intentClass: 'CATEGORY_OVERVIEW' },
  },
  {
    expected: 'category', search: {},
    resolution: { candidate: { entityType: 'CATEGORY' }, candidateNamespace: 'CATALOG' },
  },
  {
    expected: 'named_entity', search: {},
    resolution: { candidate: { entityType: 'ITEM' }, candidateNamespace: 'CATALOG' },
  },
  {
    expected: 'contextual_follow_up',
    search: { contextualReference: 'current selection', preferredRecordIds: ['record-a'] },
  },
  {
    expected: 'comparison',
    search: { requestedFact: 'comparison', preferredRecordIds: ['record-a', 'record-b'] },
  },
  { expected: 'general_knowledge', search: { requestedFact: 'published fact' } },
]) {
  assert.equal(classifyTemplateEngineSearch(scenario).searchKind, scenario.expected);
}

const identityCandidate = (recordId, overrides = {}) => ({
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId, recordType: 'CATALOG_ITEM', ...overrides,
});
const requestedA = identityCandidate('record-a');
const requestedB = identityCandidate('record-b');
const duplicateA = identityCandidate('record-a', { score: 0.7 });
const unrelated = identityCandidate('record-unrelated');
const stale = identityCandidate('record-stale', { publicationRevision: 3 });
const foreign = identityCandidate('record-foreign', {
  tenantId: '99999999-9999-4999-8999-999999999999',
});
const constrainedComparison = constrainHybridToRequestedEntities({
  channels: {
    structured: [requestedA, duplicateA, unrelated, stale, foreign],
    bm25: [requestedB, unrelated],
    qdrant: [requestedA, requestedB, foreign],
  },
  candidates: [requestedA, duplicateA, requestedB, unrelated, stale, foreign],
  queryContext: {
    reservedRecords: [
      { ...requestedA, reason: 'explicit_comparison' },
      { ...requestedB, reason: 'explicit_comparison' },
      { ...stale, reason: 'explicit_comparison' },
    ],
  },
}, tenantId, null, scope);
assert.equal(constrainedComparison.comparison, true);
assert.deepEqual(new Set(constrainedComparison.hybrid.candidates.map((value) => value.recordId)),
  new Set(['record-a', 'record-b']));
assert.equal(constrainedComparison.hybrid.channels.structured.length, 1);
assert.equal(constrainedComparison.hybrid.channels.bm25.length, 1);
assert.equal(constrainedComparison.hybrid.channels.qdrant.length, 2);

const categoryConstrained = constrainHybridToRequestedEntities({
  channels: { structured: [requestedA, requestedB, unrelated] },
  candidates: [requestedA, requestedB, unrelated],
  queryContext: { reservedRecords: [] },
}, tenantId, {
  candidate: {
    ...identityCandidate('synthetic-category', { recordType: 'CATALOG_CATEGORY' }),
    evidenceRecordIds: ['record-a', 'record-b'],
  },
}, scope);
assert.deepEqual(new Set(categoryConstrained.hybrid.candidates.map((value) => value.recordId)),
  new Set(['record-a', 'record-b']));
const searchDecision = {
  decision: 'SEARCH', response: '', clarification: null,
  search: { query: 'tenant item price', requestedFact: 'price', contextualReference: 'tenant item', preferredRecordIds: [] },
  tool: null, nextQuestion: null, stateUpdate: null,
};
let channelCalls = 0;
let hydrationCalls = 0;
const candidate = {
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId: 'record-1', recordType: 'CATALOG_ITEM', score: 0.9,
  callerFacingHint: true, canonicalName: 'Tenant Item', searchForms: ['tenant item'],
  matchMethod: 'published_exact',
};
const retrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound',
  language: 'ta', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => {
    channelCalls += 1;
    return { channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] } };
  },
  hydrateEvidence: async ({
    retrieval: selected, requireAtLeastOneHydratedEvidence, selectionRetry,
  }) => {
    hydrationCalls += 1;
    assert.equal(selected.candidates.length, 1);
    assert.equal(requireAtLeastOneHydratedEvidence, true);
    for (const channelCandidates of Object.values(selected.channels)) {
      assert.equal(channelCandidates[0].tenantId, tenantId);
      assert.equal(channelCandidates[0].agentId, agentId);
      assert.equal(channelCandidates[0].knowledgeBaseId, knowledgeBaseId);
      assert.equal(channelCandidates[0].publicationRevision, 4);
      assert.equal(channelCandidates[0].recordType, 'CATALOG_ITEM');
      assert.equal(channelCandidates[0].recordId, 'record-1');
    }
    if (hydrationCalls === 1) {
      assert.notEqual(selectionRetry, true);
      return { evidence: [], fusion: { candidates: selected.candidates } };
    }
    assert.equal(selectionRetry, true);
    return { evidence: [{
      ...candidate, id: 'evidence-1', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Tenant Item costs 125.', authoritativeData: {
        name: 'Tenant Item', price: 125,
        attributes: [{ key: 'published_detail', value: 'Approved value' }],
      },
      provenance: {
        knowledgeBaseId, publicationRevision: 4,
        documentId: 'document-1', documentVersionId: 'document-version-1',
        uploadedFilename: 'tenant-source.txt', documentDisplayName: 'Tenant Source',
        documentType: 'catalog', pageNumber: 1, pageEnd: 1,
        sourceSection: 'Approved values', sourceLineStart: 10, sourceLineEnd: 12,
      },
    }] };
  },
});
assert.equal(channelCalls, 1);
assert.equal(hydrationCalls, 2);
assert.equal(retrieval.evidence.length, 1);
assert.equal(retrieval.evidence[0].verified, true);
assert.equal(retrieval.evidence[0].documentName, 'tenant-source.txt');
assert.equal(retrieval.evidence[0].documentDisplayName, 'Tenant Source');
assert.equal(retrieval.evidence[0].pageNumber, 1);
assert.equal(retrieval.evidence[0].sourceLineStart, 10);
assert.equal(retrieval.evidence[0].sourceLineEnd, 12);
assert.equal(retrieval.evidence[0].requestedFact, 'price');
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('price'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('attributes.key'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('unpublished_detail'), false);
assert.deepEqual(retrieval.diagnostics.channelCounts, {
  structured: 1, bm25: 1, qdrant: 1,
});
assert.equal(retrieval.diagnostics.retrievalCount, 1);
assert.equal(retrieval.diagnostics.hydrationCount, 1);
assert.equal(retrieval.diagnostics.verifiedEvidenceCount, 1);
assert.equal(retrieval.diagnostics.selectionRetryAttempted, true);
assert.equal(Number.isFinite(retrieval.diagnostics.durationMs), true);
assert.equal(retrieval.diagnostics.durationMs >= 0, true);

const exactRecord = {
  record_id: 'record-exact', record_type: 'catalog_item',
  entity_name: 'Configured Alpha', entity_category: 'Configured Group',
  entity_aliases: ['Alpha Alias'], entity_category_aliases: ['Group Alias'],
  usage_direction: 'both', content: 'Configured Alpha approved details.',
  entity_metadata: { itemKey: 'configured-alpha', categoryKey: 'configured-group' },
};
const sttVariantRecord = {
  record_id: 'record-stt-variant', record_type: 'catalog_item',
  entity_name: 'Configured Beta', entity_category: 'Configured Group',
  publicationSttForms: ['Betacopy'], publicationPhoneticForms: ['Beta copy'],
  usage_direction: 'both', content: 'Configured Beta approved details.',
  entity_metadata: { itemKey: 'configured-beta', categoryKey: 'configured-group' },
};
const foreignSttVariantRecord = {
  ...sttVariantRecord, record_id: 'foreign-record-stt-variant',
  entity_name: 'Foreign Beta', content: 'Foreign tenant content.',
};
const exactArtifacts = {
  publications: [publication], sparseIndexes: [],
  bundles: [{
    tenantId, knowledgeBaseId, publicationRevision: 4, assignedAgentIds: [agentId],
    records: [exactRecord],
  }],
};
let exactStructuredRecords = [];
const exactRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-exact', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Alpha Alias', requestedFact: 'details',
      contextualReference: 'Alpha Alias', preferredRecordIds: [],
    },
  }, state: {},
}, {
  loadArtifacts: async () => exactArtifacts,
  searchCandidates: async () => ({
    channels: {
      structured: [],
      bm25: [{ ...candidate, recordId: 'unrelated-record', canonicalName: 'Other Record' }],
      qdrant: [{ ...candidate, recordId: 'unrelated-record', canonicalName: 'Other Record' }],
    },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    exactStructuredRecords = selected.channels.structured;
    assert.deepEqual(selected.candidates.map((entry) => entry.recordId), ['record-exact']);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-exact', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Configured Alpha approved details.',
      authoritativeData: { name: 'Configured Alpha', detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.equal(exactStructuredRecords.length, 1,
  'Published exact matching must populate the structured channel');
assert.equal(exactStructuredRecords[0].recordId, 'record-exact');
assert.equal(exactStructuredRecords[0].matchMethod, 'published_exact');
assert.equal(exactRetrieval.evidence[0].recordId, 'record-exact');

// Production-shaped metadata must bind hydration even when semantic resolution
// and all retrieval providers prefer conversational evidence.
const metadataRecords = [
  { record_id: 'metadata-alpha', record_type: 'catalog_item', usage_direction: 'both',
    entity_metadata: { name: 'Configured Alpha Service', aliases: ['Alpha Spoken'],
      sttForms: ['Alfa Spoken'], phoneticForms: ['Alfa Form'],
      itemKey: 'metadata-alpha', category: 'Configured Collection',
      categoryKey: 'metadata-collection', price: 17, details: 'Approved alpha detail' } },
  { record_id: 'metadata-beta', record_type: 'catalog_item', usage_direction: 'both',
    entity_metadata: { name: 'Configured Beta Service', itemKey: 'metadata-beta',
      category: 'Configured Collection', categoryKey: 'metadata-collection', price: 29 } },
];
for (const [query, expectedIds] of [
  ['Configured Alpha Service price', ['metadata-alpha']],
  ['Alpha Spoken details', ['metadata-alpha']],
  ['Alfa Spoken details', ['metadata-alpha']],
  ['Alfa Form price', ['metadata-alpha']],
  ['Configured Collection details', ['metadata-alpha', 'metadata-beta']],
]) {
  const result = await retrieveTemplateEngineEvidence({
    auth: { tenantId }, scope, callId: 'exact-catalog-regression',
    usageDirection: 'inbound', language: 'en',
    searchDecision: { ...searchDecision, search: {
      query, requestedFact: query.endsWith('price') ? 'price' : 'details',
      contextualReference: null, preferredRecordIds: [],
    } }, state: {},
  }, {
    loadArtifacts: async () => ({ ...exactArtifacts,
      bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
    }),
    resolveEntityRoute: () => ({ candidate: { ...candidate, recordId: 'overview',
      recordType: 'CONVERSATION_NODE' }, candidateNamespace: 'CONVERSATION',
      ambiguity: { detected: false } }),
    searchCandidates: async () => ({ channels: {
      structured: [{ ...candidate, recordId: 'metadata-alpha', matchMethod: 'semantic' }],
      bm25: [{ ...candidate, recordId: 'unrelated-faq', recordType: 'FAQ', score: 1 }],
      qdrant: [{ ...candidate, recordId: 'overview', recordType: 'CONVERSATION_NODE', score: 1 }],
    } }),
    hydrateEvidence: async ({ retrieval: selected }) => {
      assert.deepEqual(selected.candidates.map((entry) => entry.recordId).sort(), expectedIds);
      assert.ok(selected.candidates.every((entry) => entry.recordType === 'CATALOG_ITEM'));
      assert.ok(selected.channels.structured.every((entry) => entry.matchMethod === 'published_exact'),
        'Provider duplicates must not overwrite publication-derived match metadata');
      return { evidence: selected.candidates.map((entry) => ({
        ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
        callerFacing: true, content: 'Approved published detail',
        authoritativeData: metadataRecords.find((record) => record.record_id === entry.recordId).entity_metadata,
        provenance: { knowledgeBaseId, publicationRevision: 4 },
      })) };
    },
  });
  assert.deepEqual(result.evidence.map((entry) => entry.recordId).sort(), expectedIds);
  assert.ok(result.evidence.every((entry) => entry.requestedFact
    === (query.endsWith('price') ? 'price' : 'details')));
}

for (const language of ['en', 'ta', 'ta-Latn']) {
  for (const scenario of [
    { query: 'Tell me more about this', reference: 'current selection',
      previous: ['metadata-beta'], expected: ['metadata-beta'], comparison: false },
    { query: 'இதை பத்தி கொஞ்சம் detail சொல்லுங்க', reference: 'current selection',
      previous: ['metadata-beta'], expected: ['metadata-beta'], comparison: false },
    { query: 'Compare Configured Alpha Service and Configured Beta Service', reference: null,
      previous: [], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Explain Configured Alpha Service and Configured Beta Service', reference: null,
      previous: [], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Compare their details', reference: 'previous selections',
      previous: ['metadata-alpha', 'metadata-beta'], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Configured Beta Service details', reference: 'Configured Beta Service',
      previous: ['metadata-alpha', 'metadata-beta'], expected: ['metadata-beta'], comparison: false },
  ]) {
    const result = await retrieveTemplateEngineEvidence({
      auth: { tenantId }, scope, callId: 'context-comparison-regression', usageDirection: 'inbound', language,
      state: { lastReferencedRecordIds: scenario.previous,
        comparisonRecordIds: scenario.previous.length > 1 ? scenario.previous : [] },
      searchDecision: { ...searchDecision, search: {
        query: scenario.query, requestedFact: 'details', contextualReference: scenario.reference,
        preferredRecordIds: [],
      } },
    }, {
      loadArtifacts: async () => ({ ...exactArtifacts,
        bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
      }),
      resolveEntityRoute: () => ({ candidate: null, action: 'CLARIFY', ambiguity: {
        detected: true, candidates: metadataRecords.map((record) => ({
          recordId: record.record_id, recordType: 'CATALOG_ITEM', label: record.entity_metadata.name,
        })),
      } }),
      // No provider finds either operand. Published identities must survive.
      searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
      hydrateEvidence: async ({ retrieval: selected, resolution }) => {
        assert.deepEqual(selected.candidates.map((entry) => entry.recordId).sort(), scenario.expected);
        assert.equal(resolution.ambiguity.detected, false);
        return { evidence: selected.candidates.map((entry) => ({
          ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
          callerFacing: true, content: 'Approved published detail',
          authoritativeData: metadataRecords.find((record) => record.record_id === entry.recordId).entity_metadata,
          provenance: { knowledgeBaseId, publicationRevision: 4 },
        })) };
      },
    });
    assert.deepEqual([...result.requestedEntityRecordIds].sort(), scenario.expected);
    assert.equal(result.searchClassification.searchKind === 'comparison', scenario.comparison);
    assert.equal(publishedResolutionAmbiguity(result.entityResolution, result.evidence,
      result.searchClassification).required, false);
  }
}

let sttSelectedIds = [];
await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'missing-comparison-operand', usageDirection: 'inbound', language: 'en',
  state: { comparisonRecordIds: ['metadata-alpha', 'removed-record'] },
  searchDecision: { ...searchDecision, search: { query: 'Compare their details', requestedFact: 'details',
    contextualReference: 'previous selections', preferredRecordIds: [] } },
}, {
  loadArtifacts: async () => ({ ...exactArtifacts,
    bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
  }),
}), { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE' },
'Never silently reduce a remembered comparison to its surviving operand');
const sttVariantRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-stt-variant', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Betacopy', requestedFact: 'details',
      contextualReference: 'Betacopy', preferredRecordIds: ['stale-record'],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [
      { ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] },
      {
        tenantId: '99999999-9999-4999-8999-999999999999', knowledgeBaseId,
        publicationRevision: 4, assignedAgentIds: [agentId], records: [foreignSttVariantRecord],
      },
    ],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    sttSelectedIds = selected.candidates.map((entry) => entry.recordId);
    assert.deepEqual(sttSelectedIds, ['record-stt-variant']);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-stt-variant', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: sttVariantRecord.content,
      authoritativeData: { name: sttVariantRecord.entity_name, detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.deepEqual(sttSelectedIds, ['record-stt-variant']);
assert.equal(sttVariantRetrieval.evidence[0].recordId, 'record-stt-variant');
assert.equal(sttVariantRetrieval.evidence[0].verified, true);
assert.equal(sttVariantRetrieval.evidence.some((entry) => (
  entry.tenantId !== tenantId || entry.recordId === 'foreign-record-stt-variant'
)), false, 'STT variants must never admit cross-tenant evidence');

let phoneticSelectedIds = [];
const phoneticVariantRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-phonetic-variant', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Beta copy', requestedFact: 'details',
      contextualReference: 'Beta copy', preferredRecordIds: [],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] }],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    phoneticSelectedIds = selected.candidates.map((entry) => entry.recordId);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-phonetic-variant', hydrationValidated: true,
      publicationValidated: true, callerFacing: true, content: sttVariantRecord.content,
      authoritativeData: { name: sttVariantRecord.entity_name, detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.deepEqual(phoneticSelectedIds, ['record-stt-variant']);
assert.equal(phoneticVariantRetrieval.evidence[0].verified, true);

let unpublishedAliasCandidates = null;
const unpublishedAliasRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-unpublished-alias', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Betacopi', requestedFact: 'details',
      contextualReference: 'Betacopi', preferredRecordIds: [],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] }],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    unpublishedAliasCandidates = selected.candidates;
    return { evidence: [], fusion: { candidates: selected.candidates } };
  },
});
assert.deepEqual(unpublishedAliasCandidates, [],
  'An unpublished lookalike must not become an exact alias match');
assert.deepEqual(unpublishedAliasRetrieval.evidence, []);

const guidanceRecord = {
  record_id: 'guidance-overview', record_type: 'conversation_node',
  content: 'Approved overview of Configured Group.', usage_direction: 'both',
  entity_metadata: {
    nodeKey: 'configured_overview', nodeType: 'message',
    purpose: 'Provide the configured overview.',
    catalogReferences: ['Configured Group => category:configured-group'],
  },
};
const guidanceArtifacts = {
  ...exactArtifacts,
  bundles: [{ ...exactArtifacts.bundles[0], records: [guidanceRecord, exactRecord] }],
};
let guidanceSelectedIds = [];
const guidanceRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-guidance', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Show the configured overview', requestedFact: 'available options',
      contextualReference: null, preferredRecordIds: [],
    },
  }, state: {}, conversationGuidance: {
    recordId: 'guidance-overview', knowledgeBaseId, publicationRevision: 4,
    catalogReferences: ['Configured Group => category:configured-group'],
    nextQuestion: 'Which configured option would you like?',
  },
}, {
  loadArtifacts: async () => guidanceArtifacts,
  searchCandidates: async () => ({
    channels: { structured: [], bm25: [], qdrant: [] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    guidanceSelectedIds = selected.candidates.map((entry) => entry.recordId);
    assert.equal(guidanceSelectedIds.includes('guidance-overview'), true);
    assert.equal(guidanceSelectedIds.includes('record-exact'), true);
    const selectedGuidance = selected.candidates.find((entry) => (
      entry.recordId === 'guidance-overview'
    ));
    return { evidence: [{
      ...selectedGuidance, id: 'evidence-guidance', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: guidanceRecord.content,
      authoritativeData: guidanceRecord.entity_metadata,
      provenance: {
        knowledgeBaseId, publicationRevision: 4, documentId: 'guidance-document',
        uploadedFilename: 'tenant-conversation.txt',
        documentDisplayName: 'Tenant Conversation Guidance', sourceSection: 'Overview',
      },
    }] };
  },
});
assert.equal(guidanceRetrieval.evidence[0].recordId, 'guidance-overview');
assert.equal(guidanceRetrieval.evidence[0].documentId, 'guidance-document');
assert.equal(guidanceRetrieval.evidence[0].documentDisplayName,
  'Tenant Conversation Guidance');

let emptyHydrationAttempts = 0;
const emptyHydration = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-empty', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    emptyHydrationAttempts += 1;
    return { evidence: [], fusion: { candidates: selected.candidates }, rejectedRecordIds: [] };
  },
});
assert.equal(emptyHydrationAttempts, 2,
  'An unresolved published identity must retry hydration exactly once');
assert.deepEqual(emptyHydration.evidence, []);
assert.equal(emptyHydration.diagnostics.selectionRetryAttempted, true);
assert.equal(emptyHydration.diagnostics.requestedEntityHydrationIncomplete, true);
assert.equal(emptyHydration.diagnostics.requestedEntityCount, 1);
assert.equal(emptyHydration.diagnostics.hydratedRequestedEntityCount, 0);

const unavailableSpeech = 'That requested information is not currently published.';
const unavailableDecisions = [searchDecision, {
  decision: 'NO_MATCH', response: unavailableSpeech,
  clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
}];
const unavailableTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-empty-no-match', usageDirection: 'inbound',
  language: 'en', mainPrompt: 'Use the configured unavailable response when evidence is absent.',
  latestUtterance: 'Tell me the requested published information.',
  conversationHistory: [], state: {}, runtimeProfile: {},
  authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
  informationUnavailableResponse: unavailableSpeech,
}, {
  invokeStructuredLlm: async () => unavailableDecisions.shift(),
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [], publishedConversationGuidance: [], artifacts: {},
  }),
  retrieveEvidence: async () => emptyHydration,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async ({ decision }) => ({
    supported: decision === 'NO_MATCH', successClaimed: false,
    requestedFactAddressed: decision === 'NO_MATCH',
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(unavailableTurn.decision.decision, 'NO_MATCH');
assert.equal(unavailableTurn.speech, unavailableSpeech);
assert.deepEqual(unavailableTurn.evidenceIds, []);
assert.equal(unavailableTurn.provenance.finalDecision, 'NO_MATCH');

await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-cross-scope', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => ({
    fusion: { candidates: selected.candidates },
    evidence: [{
      ...candidate, tenantId: 'foreign-tenant', id: 'foreign-evidence',
      hydrationValidated: true, publicationValidated: true, callerFacing: true,
      content: 'Foreign content.', provenance: { knowledgeBaseId, publicationRevision: 4 },
    }],
  }),
}), (error) => error.code === 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_VIOLATION'
  || error.code === 'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION'
  || error.code === 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE');

const decisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
let retrievalDiagnostics;
let postSearchDiagnostics;
const turn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => decisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => retrieval,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { retrievalDiagnostics = details; },
  onPostSearchDiagnostics: (details) => { postSearchDiagnostics = details; },
});
assert.equal(turn.speech, 'Tenant Item costs 125.');
assert.deepEqual(turn.evidenceIds, ['evidence-1']);
assert.deepEqual(turn.state.lastReferencedRecordIds, ['record-1']);
assert.equal(decisions.length, 0);
assert.equal(retrievalDiagnostics.retrievalCount, 1);
assert.deepEqual(postSearchDiagnostics.allowedAliases, ['E1']);
assert.deepEqual(postSearchDiagnostics.returnedAliases, ['E1']);
assert.equal(postSearchDiagnostics.finalDecision, 'RESPONSE');
assert.equal(turn.provenance.initialDecision, 'SEARCH');
assert.equal(turn.provenance.finalDecision, 'RESPONSE');
assert.deepEqual(turn.provenance.evidenceIds, ['evidence-1']);
assert.equal(turn.provenance.searchPerformed, true);

let speculativeStarted = false;
let routedWhileSpeculativeActive = false;
let ordinaryRetrievalCalls = 0;
let speculativeDiagnostics;
let deterministicChecks = 0;
const speculativeDecisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: {
    question: 'Would you like another published detail?', reason: 'guidance',
  }, stateUpdate: null,
}];
const speculativeTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-speculative', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => {
    routedWhileSpeculativeActive ||= speculativeStarted;
    return speculativeDecisions.shift();
  },
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'guidance-1', purpose: 'Continue relevant assistance',
      nextQuestion: 'Would you like another published detail?',
    }],
  }),
  retrieveSpeculativeEvidence: async () => {
    speculativeStarted = true;
    return retrieval;
  },
  retrieveEvidence: async () => {
    ordinaryRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    deterministicChecks += 1;
    return { supported: true, successClaimed: false, requestedFactAddressed: true };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { speculativeDiagnostics = details; },
});
assert.equal(routedWhileSpeculativeActive, true,
  'Routing must run while speculative hybrid retrieval is already active');
assert.equal(ordinaryRetrievalCalls, 0,
  'A compatible speculative result must avoid duplicate retrieval');
assert.equal(speculativeDiagnostics.speculativeReused, true);
assert.equal(deterministicChecks, 1,
  'Follow-up validation must not add a second grounding-validator call');
assert.match(speculativeTurn.speech, /Tenant Item costs 125/u);

const guardedDecisions = [{
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
}, {
  ...searchDecision,
}, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
let guardedClaimChecks = 0;
let guardedRetrievalCalls = 0;
const guardedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-guarded', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use RESPONSE only for non-factual speech and SEARCH for facts.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => guardedDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => {
    guardedRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    guardedClaimChecks += 1;
    return {
      supported: guardedClaimChecks > 1,
      successClaimed: false,
      requestedFactAddressed: guardedClaimChecks > 1,
    };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(guardedRetrievalCalls, 1,
  'A factual direct RESPONSE must be reclassified by the tenant-controlled LLM');
assert.equal(guardedTurn.decision.decision, 'RESPONSE');
assert.deepEqual(guardedTurn.evidenceIds, ['evidence-1']);
assert.equal(guardedDecisions.length, 0);

const tool = {
  id: 'tool-1', name: 'perform_action', status: 'active', type: 'webhook_api',
  configuration: {
    identifier: 'perform_action',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { contact_name: { type: 'string', minLength: 1 } },
      required: ['contact_name'],
      'x-confirmation-message': 'Confirm these details?',
    },
  },
};
const workflow = {
  recordId: 'workflow-1', recordType: 'WORKFLOW_RULE', tenantId, agentId,
  knowledgeBaseId, publicationRevision: 4, published: true, status: 'published',
  actionType: 'configured_tool', actionConfig: { toolIdentifier: 'perform_action' },
};
const workflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} }, nextQuestion: null, stateUpdate: null,
}, { speech: 'Please provide the configured contact name.' }];
const workflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform the action.', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => workflowDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('incomplete workflow must not execute'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(workflowTurn.workflow.status, 'AWAITING_FIELD');
assert.equal(workflowTurn.state.activeWorkflowId, 'workflow-1');
assert.equal(workflowTurn.toolExecuted, false);
assert.equal(workflowTurn.provenance.initialDecision, 'TOOL');
assert.equal(workflowTurn.provenance.finalDecision, 'CLARIFY');
assert.equal(workflowTurn.provenance.workflowId, 'workflow-1');
assert.equal(workflowTurn.provenance.toolId, 'tool-1');
assert.equal(workflowTurn.provenance.clarificationReason, 'missing_workflow_field');
assert.equal(workflowDecisions.length, 0);

const contextualWorkflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: { contact_name: 'Sam' } },
  nextQuestion: null,
  stateUpdate: null,
}, { speech: 'Please confirm the collected value Sam.' }];
const contextualWorkflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-contextual-tool',
  usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform it.',
  conversationHistory: [
    { role: 'user', content: 'The configured contact name is Sam.' },
    { role: 'assistant', content: 'I have that value.' },
  ],
  state: { lastReferencedRecordIds: ['selected-record'] },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => contextualWorkflowDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('confirmation is still required'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(contextualWorkflowTurn.workflow.status, 'AWAITING_CONFIRMATION');
assert.equal(contextualWorkflowTurn.state.collectedToolFields.contact_name, 'Sam');
assert.deepEqual(contextualWorkflowTurn.state.lastReferencedRecordIds, ['selected-record'],
  'Workflow activation must preserve the selected record reference');
assert.equal(contextualWorkflowDecisions.length, 0);

const confirmationDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} },
  nextQuestion: null,
  stateUpdate: { set: { confirmationStatus: 'confirmed' }, clear: [] },
}, {
  speech: 'The action completed successfully.',
  nextQuestion: { question: 'Would you like further help?', reason: 'Published continuation' },
}];
let executed = 0;
const confirmedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Yes, confirm it.', conversationHistory: [],
  state: {
    activeWorkflowId: 'workflow-1', collectedToolFields: { contact_name: 'Sam' },
    confirmationStatus: 'awaiting_confirmation',
  },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => confirmationDecisions.shift(),
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [workflow], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'result-guidance', recordType: 'CONVERSATION_NODE',
      tenantId, agentId, knowledgeBaseId, publicationRevision: 4, published: true,
      nodeKey: 'operation_execution_result', intentClass: null,
      purpose: 'Report the verified execution result and offer further help.',
      situation: 'The authorized operation has returned a verified result.',
      examples: [], context: null, catalogReferences: [],
      nextQuestion: 'Would you like further help?',
    }],
  }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {
    executed += 1;
    return { verified: true, success: true, output: { success: true } };
  },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: true }),
});
assert.equal(executed, 1);
assert.equal(confirmedTurn.workflow.status, 'SUCCEEDED');
assert.equal(confirmedTurn.state.activeWorkflowId, null);
assert.equal(confirmedTurn.provenance.finalDecision, 'TOOL_RESULT');
assert.equal(confirmedTurn.provenance.validationResult, 'verified_tool_result');
assert.equal(confirmedTurn.speech,
  'The action completed successfully. Would you like further help?');
assert.equal(confirmedTurn.followUpValidation.accepted, true);
assert.equal(confirmationDecisions.length, 0);

const runtimeMetrics = {
  templateEngine: { version: 1, mode: 'active', turns: 0, searches: 0, workflows: 0 },
  turnLatency: [],
};
const searchMetric = recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 1, result: turn, retrievalDiagnostics: retrieval.diagnostics,
  turnStartedAt: 1_000, firstAudioAt: 1_750, finalResponseReadyAt: 2_900,
  firstFinalAudioAt: 3_200, firstAudioDeadlineMs: 2_000,
});
recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 2, result: workflowTurn, turnStartedAt: 2_000,
  firstAudioAt: 4_500, firstAudioDeadlineMs: 2_000,
});
assert.equal(runtimeMetrics.templateEngine.turns, 2);
assert.equal(runtimeMetrics.templateEngine.searches, 1);
assert.equal(runtimeMetrics.templateEngine.workflows, 1);
assert.equal(runtimeMetrics.turnLatency.length, 2);
assert.equal(searchMetric.route, 'SEARCH');
assert.equal(searchMetric.responseClass, 'RESPONSE');
assert.equal(searchMetric.retrievalMs, retrieval.diagnostics.durationMs);
assert.equal(searchMetric.totalFirstAudioMs, 750);
assert.equal(searchMetric.finalAnswerReadyMs, 1900);
assert.equal(searchMetric.finalAnswerFirstAudioMs, 2200);
assert.equal(searchMetric.firstAudioStatus, 'passed');
assert.equal(runtimeMetrics.turnLatency[1].retrievalMs, null);
assert.equal(runtimeMetrics.turnLatency[1].firstAudioStatus, 'missed');

console.log('Template-engine production retrieval and turn runtime verification passed.');
