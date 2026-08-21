import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const {
  classifyCatalogEntityLocally, resolveCatalogEntitiesLocally,
} = await import('../src/knowledge-bases/catalog-entity-resolver.js');
const {
  catalogIdentityOverridesRememberedEntity,
  callerMessageOverridesCategoryResolution,
  focusAuthoritativeCatalogEvidence,
  strongCallerMessageMatch,
  workflowActionRouteCandidates,
} = await import('../src/knowledge-bases/hybrid-knowledge-retrieval.service.js');
const { openGenericConversationState } = await import(
  '../src/voice/interaction/generic-conversation-state.js'
);

const base = {
  knowledge_base_id: 'knowledge-base', document_id: 'document',
  document_version_id: 'version', publication_revision: 1,
  category_description: null, category_selection_rules: {}, relationships: {},
};
const catalog = [
  {
    ...base, id: 'foundation', item_key: 'foundation-plan', name: 'Foundation Plan',
    aliases: ['foundation package'], category: 'General Services',
    category_key: 'general-services', category_aliases: ['service package'],
  },
  {
    ...base, id: 'advanced', item_key: 'advanced-plan', name: 'Advanced Plan',
    aliases: ['advanced package'], category: 'General Services',
    category_key: 'general-services', category_aliases: ['service package'],
  },
  {
    ...base, id: 'junior', item_key: 'junior-plan', name: 'Junior Plan',
    aliases: ['junior package'], category: 'Youth Services',
    category_key: 'youth-services', category_aliases: ['junior service package'],
  },
];

const specific = classifyCatalogEntityLocally(
  catalog, 'Please explain the Junior service package',
);
assert.equal(specific.status, 'match');
assert.equal(specific.item?.category_key ?? specific.categoryKey, 'youth-services');

const switched = classifyCatalogEntityLocally(catalog, 'Advanced package details please');
assert.equal(switched.status, 'match');
assert.equal(switched.item.item_key, 'advanced-plan');
assert.equal(catalogIdentityOverridesRememberedEntity(switched, [{ key: 'foundation-plan' }]), true);
const shortExplicitSwitch = classifyCatalogEntityLocally(catalog, 'Advanced');
assert.equal(shortExplicitSwitch.status, 'match');
assert.equal(shortExplicitSwitch.item.item_key, 'advanced-plan');
assert.equal(catalogIdentityOverridesRememberedEntity(
  shortExplicitSwitch, [{ key: 'foundation-plan' }],
), true);
assert.equal(catalogIdentityOverridesRememberedEntity({
  status: 'match', entityType: 'item', matchedKind: 'distinctive_identity_token',
}, [{ key: 'foundation-plan' }]), true);

const memory = openGenericConversationState({
  tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', callId: 'call',
}, {}, Date.now(), { knownEntities: [{ key: 'foundation-plan', name: 'Foundation Plan' }] });
memory.applyGroundedDecision({ stateUpdate: {
  currentTopic: 'advanced-plan',
  knownEntities: [{ key: 'advanced-plan', name: 'Advanced Plan' }],
  contextDependent: false,
} });
assert.deepEqual(memory.snapshot().knownEntities.map((entity) => entity.key), ['advanced-plan']);
memory.applyGroundedDecision({ stateUpdate: {
  currentTopic: 'general-services',
  knownEntities: [],
  requestType: 'category_overview',
  contextDependent: false,
} });
assert.deepEqual(memory.snapshot().knownEntities, []);
assert.equal(memory.snapshot().currentTopic, 'general-services');

const compared = resolveCatalogEntitiesLocally(
  catalog, 'What is the difference between Foundation and Advanced?',
);
assert.deepEqual(compared.map((entry) => entry.item.item_key), [
  'foundation-plan', 'advanced-plan',
]);

const sharedNameCatalog = [
  {
    ...base, id: 'aurora', item_key: 'aurora-complete-service',
    name: 'Aurora Complete Service', aliases: [], category: 'Complete Services',
    category_key: 'complete-services', category_aliases: [],
  },
  {
    ...base, id: 'beacon', item_key: 'beacon-complete-service',
    name: 'Beacon Complete Service', aliases: [], category: 'Complete Services',
    category_key: 'complete-services', category_aliases: [],
  },
];
const shortNameComparison = resolveCatalogEntitiesLocally(
  sharedNameCatalog, 'Auroraக்கும் Beaconக்கும் என்ன difference?',
);
assert.deepEqual(shortNameComparison.map((entry) => entry.item.item_key), [
  'aurora-complete-service', 'beacon-complete-service',
]);

const catalogEvidence = compared.map((entry, index) => ({
  id: `source_${index + 1}`, recordId: entry.item.id, recordType: 'CATALOG_ITEM',
  retrievalContext: 'primary', callerFacing: true, authoritativeData: {
    itemKey: entry.item.item_key, name: entry.item.name,
    category: entry.item.category, categoryKey: entry.item.category_key,
  },
}));
const focused = focusAuthoritativeCatalogEvidence(catalogEvidence, {
  catalogIdentityResolved: true,
  explicitCatalogRecordIds: compared.map((entry) => entry.item.id),
  knownEntities: [{ key: 'junior-plan', name: 'Junior Plan' }],
  query: 'Compare Foundation and Advanced',
});
assert.deepEqual(focused.evidence.map((entry) => entry.recordId), ['foundation', 'advanced']);

const overview = {
  id: 'overview', recordId: 'overview', recordType: 'CONVERSATION_NODE',
  callerFacing: true, retrievalContext: 'primary', semanticScore: 0.95,
  channels: ['semantic'], authoritativeData: {
    nodeType: 'message', variables: [
      { key: 'situation', value: 'The caller asks for all available choices.' },
      { key: 'examples', value: ['what choices are available', 'yes'] },
      { key: 'context', value: 'no_selected_entity' },
    ],
  },
};
assert.equal(strongCallerMessageMatch(
  overview, 'Advanced package details please', { catalogIdentityDetected: true },
), false);
assert.equal(strongCallerMessageMatch(overview, 'yes', {}), false);
assert.equal(strongCallerMessageMatch(
  overview, 'yes', { pendingQuestion: 'Would you like to hear the choices?' },
), true);

const overviewCategoryResolution = {
  status: 'match', entityType: 'category', category: 'Health Screening',
  categoryKey: 'health-screening', matchedText: 'Health Screening',
};
const completeOverviewMessage = {
  ...overview,
  authoritativeData: {
    ...overview.authoritativeData,
    variables: [
      { key: 'purpose', value: 'Provide the complete overview of all available options.' },
      { key: 'situation', value: 'The caller asks for a complete overview of all available options.' },
      { key: 'examples', value: ['What options are available?'] },
      { key: 'context', value: 'no_selected_entity' },
    ],
  },
};
assert.equal(callerMessageOverridesCategoryResolution(
  completeOverviewMessage,
  overviewCategoryResolution,
  'Could you give me a complete overview of the available health screening options?',
), true);
assert.equal(callerMessageOverridesCategoryResolution(
  completeOverviewMessage,
  {
    status: 'match', entityType: 'item', matchedText: 'Health Screening Option',
    item: { name: 'Health Screening Option', item_key: 'health-screening-option' },
  },
  'Could you give me a complete overview of the available health screening options?',
), true);
assert.equal(callerMessageOverridesCategoryResolution(
  completeOverviewMessage,
  { ...overviewCategoryResolution, category: 'Organ Specific Services', categoryKey: 'organ-specific-services', matchedText: 'Organ Specific Services' },
  'What organ specific services are available?',
), false);
assert.equal(callerMessageOverridesCategoryResolution(
  completeOverviewMessage,
  {
    status: 'match', entityType: 'item', matchedText: 'Advanced Screening',
    item: { name: 'Advanced Screening', item_key: 'advanced-screening' },
  },
  'Tell me about the Advanced Screening option',
), false);

const actionRoutes = workflowActionRouteCandidates([{
  id: 'book', name: 'create_reservation', conditions: {
    examples: ['reserve this selected service'],
  }, knowledge_base_id: 'knowledge-base', publication_revision: 1,
  document_id: 'document', document_version_id: 'version',
}], 'Please reserve this selected service');
assert.equal(actionRoutes.length, 1);
assert.equal(actionRoutes[0].recordType, 'WORKFLOW_RULE');
assert.equal(workflowActionRouteCandidates([{
  id: 'book', conditions: { examples: ['reserve this selected service'] },
}], 'Tell me about this selected service').length, 0);

console.log(JSON.stringify({
  task: 'universal-entity-routing', passed: true,
  tenantVocabularyOnly: true,
  explicitEntityReplacesStaleMemory: true,
  multiEntityComparisonPreserved: true,
  catalogOverridesGenericConversationMessage: true,
  compactAcknowledgementRequiresContext: true,
}));
