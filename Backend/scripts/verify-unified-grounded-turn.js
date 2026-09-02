import assert from 'node:assert/strict';
import { genericConversationStateFields, openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { deterministicSourceEntry } from '../src/knowledge-engine/deterministic-source-mapping.js';
import {
  applyUnifiedGroundedTurn as applyVerifiedGroundedTurn,
  validatePostLlmResponseAndTool,
} from '../src/voice/interaction/unified-grounded-turn.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';

function applyUnifiedGroundedTurn(input) {
  const scopedRevision = input.evidenceScope?.publicationRevisions?.[0] ?? {};
  const authoritative = (input.evidence ?? []).map((record, index) => ({
    tenantId: input.evidenceScope?.tenantId ?? 'tenant-a',
    agentId: input.evidenceScope?.agentId ?? 'agent-a',
    knowledgeBaseId: scopedRevision.knowledgeBaseId ?? 'kb-test',
    publicationRevision: scopedRevision.publicationRevision ?? 1,
    documentId: `document-${index + 1}`,
    documentVersionId: `version-${index + 1}`,
    hydrationValidated: true,
    documentStatus: 'ready',
    documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
    ...record,
  }));
  const sourceMap = input.groundingEnvelope?.sourceMap
    ?? (input.groundingEnvelope?.sources ?? []).map((source) => {
      const record = authoritative.find((candidate) => (
        candidate.id === source.publishedEvidenceId
        || candidate.recordId === source.recordId
        || candidate.id === source.id
      ));
      return deterministicSourceEntry(record ?? source, source.id);
    });
  return applyVerifiedGroundedTurn({
    ...input,
    evidence: authoritative,
    groundingEnvelope: { ...input.groundingEnvelope, sourceMap },
  });
}

function unifiedDecision(value) {
  return JSON.stringify({
    responseId: null,
    clarification: value.decision === 'clarify' ? { reason: 'ambiguous_request' } : null,
    ...value,
  });
}

const identity = { tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a' };
const settings = {
  conversationMemoryFields: [
    { key: 'contact_name', label: 'Contact name', type: 'text', required: true, question: 'What name should I use?' },
    { key: 'preferred_date', label: 'Preferred date', type: 'text', required: true, question: 'Which date do you prefer?' },
  ],
};
const memory = openGenericConversationState(identity, settings, 1, {
  pendingQuestion: { key: 'preferred_date', text: 'Which date do you prefer?', kind: 'field' },
  collectedInformation: {},
  language: 'en',
});
memory.beginTurn('turn-1');

const envelope = {
  found: true,
  sources: [{ id: 'source-1', recordId: 'fact-1', recordType: 'GENERAL_KNOWLEDGE', content: 'The office is on Central Road.' }],
  entities: [],
};
const exactMemory = openGenericConversationState(
  { ...identity, callId: 'call-exact' }, settings, 1,
  { pendingQuestion: null, collectedInformation: {}, language: 'en' },
);
exactMemory.beginTurn('turn-exact');
const exactEvidence = {
  id: 'published-message-1', recordId: 'published-message-1',
  recordType: 'CONVERSATION_NODE', content: 'Published answer. Which option would you like?',
  tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 7,
  documentId: 'document-a', documentVersionId: 'version-a', hydrationValidated: true,
  documentStatus: 'ready', documentVersionStatus: 'ready', documentVersionIsCurrent: true,
  callerFacing: true, authoritativeData: { nodeType: 'message' },
};
const exactTurn = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: 'Generated paraphrase must be discarded.', responseId: 'source-1',
    evidenceIds: ['source-1'], stateUpdate: {}, pendingQuestion: null,
    toolRequest: null, clarification: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'source-1', recordId: exactEvidence.recordId, recordType: exactEvidence.recordType,
      content: exactEvidence.content, exactCallerResponse: true,
    }],
    entities: [], exactCallerResponses: ['source-1'],
  },
  memory: exactMemory, turnToken: 'turn-exact', fieldSchemas: settings.conversationMemoryFields,
  evidence: [exactEvidence], finalizedUtterance: 'Yes, please continue.',
  evidenceScope: {
    tenantId: 'tenant-a', agentId: 'agent-a', requireHydratedEvidence: true,
    publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
  },
});
assert.equal(exactTurn.valid, true);
assert.equal(exactTurn.responseId, 'source-1');
assert.equal(exactTurn.answer, exactEvidence.content);
assert.equal(exactTurn.nextQuestion, null);

const priceMemory = openGenericConversationState(
  { ...identity, callId: 'call-authoritative-price' }, {}, 1,
);
priceMemory.beginTurn('turn-authoritative-price');
const completePriceEvidence = {
  id: 'published-price-1', recordId: 'catalog-price-1', recordType: 'CATALOG_ITEM',
  content: 'Approved published option.',
  tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 7,
  documentId: 'document-price', documentVersionId: 'version-price', hydrationValidated: true,
  publicationValidated: true, documentStatus: 'ready', documentVersionStatus: 'ready',
  documentVersionIsCurrent: true, callerFacing: true,
  authoritativeData: { itemKey: 'premium-option', name: 'Premium Option', price: 3200, currency: 'INR' },
};
const completePriceTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Premium Option costs INR 3,200.00.',
    selectedEvidenceIds: ['source-price'], stateUpdate: { requestType: 'price' },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true, sources: [{
      id: 'source-price', publishedEvidenceId: completePriceEvidence.id,
      recordId: completePriceEvidence.recordId, recordType: 'CATALOG_ITEM',
      content: 'Compact approved option.', callerFacing: true,
    }], entities: [{
      id: completePriceEvidence.recordId, key: 'premium-option', name: 'Premium Option',
      sourceId: 'source-price',
    }],
  },
  memory: priceMemory, turnToken: 'turn-authoritative-price', evidence: [completePriceEvidence],
  finalizedUtterance: 'What is the Premium Option price?',
  evidenceScope: {
    tenantId: 'tenant-a', agentId: 'agent-a', requireHydratedEvidence: true,
    publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
  },
});
assert.equal(completePriceTurn.valid, true,
  'compact LLM evidence must be validated against the complete hydrated PostgreSQL record');
assert.deepEqual(completePriceTurn.evidenceIds, ['source-price']);

assert.equal(validateGroundedClaim(
  'Premium Option costs INR 9,999.', [completePriceEvidence],
).reason, 'unsupported_numeric_fact');
assert.equal(validateGroundedClaim(
  'Premium Option has a minimum age of 18.', [completePriceEvidence],
).reason, 'unsupported_numeric_fact');
assert.equal(validateGroundedClaim(
  'Premium Option includes MRI.', [completePriceEvidence],
).reason, 'unsupported_structured_fact');
const separateCatalogEvidence = [{
  ...completePriceEvidence,
}, {
  ...completePriceEvidence,
  id: 'published-standard-1', recordId: 'catalog-standard-1',
  authoritativeData: { itemKey: 'standard-option', name: 'Standard Option' },
}];
assert.equal(validateGroundedClaim(
  'Premium Option includes Standard Option.', separateCatalogEvidence,
).reason, 'unsupported_catalog_relationship');
assert.equal(validateGroundedClaim(
  'Premium Option and Standard Option are different options.', separateCatalogEvidence,
  { allowCrossRecordComparison: true },
).valid, true);
const sharedCategoryEvidence = separateCatalogEvidence.map((source) => ({
  ...source,
  authoritativeData: {
    ...source.authoritativeData,
    categoryKey: 'shared-category', category: 'Shared Category',
  },
}));
assert.equal(validateGroundedClaim(
  'Premium Option is in Shared Category.', sharedCategoryEvidence,
).valid, true, 'Shared category metadata must not create a false cross-item relationship');
assert.equal(validateGroundedClaim(
  'Premium spoken alias is available.', [{
    ...completePriceEvidence,
    authoritativeData: {
      ...completePriceEvidence.authoritativeData,
      aliases: ['Premium spoken alias'], availability: 'available',
    },
  }], {
    knownEntities: [{ key: 'premium-option', name: 'Premium Option', aliases: ['Premium spoken alias'] }],
  },
).valid, true, 'An alias in the exact hydrated record must not be rejected as unsupported');

const unavailableFactMemory = openGenericConversationState(
  { ...identity, callId: 'call-unpublished-price' }, {}, 1,
);
unavailableFactMemory.beginTurn('turn-unpublished-price');
const unpublishedPriceEvidence = {
  ...completePriceEvidence,
  id: 'published-price-unavailable', recordId: 'catalog-price-unavailable',
  authoritativeData: {
    ...completePriceEvidence.authoritativeData,
    itemKey: 'unpriced-option', name: 'Unpriced Option', price: null,
  },
};
const unavailableFactTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Unpriced Option costs INR 9,999.',
    evidenceIds: ['source-unpriced'],
    stateUpdate: { requestType: 'price', requestedFacts: ['price'] },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'source-unpriced', publishedEvidenceId: unpublishedPriceEvidence.id,
      recordId: unpublishedPriceEvidence.recordId, recordType: 'CATALOG_ITEM',
      content: 'Approved option with no published price.', callerFacing: true,
    }],
    entities: [{
      id: unpublishedPriceEvidence.recordId, key: 'unpriced-option',
      name: 'Unpriced Option', sourceId: 'source-unpriced',
    }],
  },
  memory: unavailableFactMemory, turnToken: 'turn-unpublished-price',
  evidence: [unpublishedPriceEvidence],
  finalizedUtterance: 'What is the Unpriced Option price?',
  zeroEvidenceResponse: 'That requested information is not published.',
  evidenceScope: {
    tenantId: 'tenant-a', agentId: 'agent-a', requireHydratedEvidence: true,
    publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
  },
});
assert.equal(unavailableFactTurn.valid, true);
assert.equal(unavailableFactTurn.answer, 'That requested information is not published.');
unavailableFactMemory.close();

const clarifyMemory = openGenericConversationState(
  { ...identity, callId: 'call-genuine-ambiguity' }, {}, 1,
);
clarifyMemory.beginTurn('turn-genuine-ambiguity');
const genuineClarification = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'clarify', answer: '', selectedEvidenceIds: [], stateUpdate: {},
    pendingQuestion: 'Did you mean Premium Option?', toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'source-price', publishedEvidenceId: completePriceEvidence.id,
      recordId: completePriceEvidence.recordId, recordType: 'CATALOG_ITEM',
      content: 'Compact approved option.', callerFacing: true,
    }],
    entities: [],
  },
  memory: clarifyMemory,
  turnToken: 'turn-genuine-ambiguity',
  evidence: [completePriceEvidence],
  finalizedUtterance: 'Was that premium?',
  clarificationContext: {
    candidates: [{ canonicalName: 'Premium Option', confidenceBand: 'MEDIUM' }],
  },
  evidenceScope: {
    tenantId: 'tenant-a', agentId: 'agent-a', requireHydratedEvidence: true,
    publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
  },
});
assert.equal(genuineClarification.valid, true,
  'genuine candidate-specific ambiguity must remain CLARIFY instead of technical failure');
assert.equal(genuineClarification.decision, 'clarify');
exactMemory.beginTurn('turn-exact-foreign');
const foreignExactTurn = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: '', responseId: 'source-1', evidenceIds: ['source-1'],
    stateUpdate: {}, pendingQuestion: null, toolRequest: null, clarification: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'source-1', recordId: exactEvidence.recordId, recordType: exactEvidence.recordType,
      content: exactEvidence.content, exactCallerResponse: true,
    }],
    entities: [], exactCallerResponses: ['source-1'],
  },
  memory: exactMemory, turnToken: 'turn-exact-foreign',
  evidence: [{ ...exactEvidence, tenantId: 'tenant-b' }],
  finalizedUtterance: 'Continue.',
  evidenceScope: {
    tenantId: 'tenant-a', agentId: 'agent-a', requireHydratedEvidence: true,
    publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
  },
});
assert.equal(foreignExactTurn.valid, false);
assert.equal(foreignExactTurn.reason, 'foreign_evidence_selected');

const overviewMemory = openGenericConversationState(
  { ...identity, callId: 'call-overview-boundary' }, {}, 1,
);
overviewMemory.beginTurn('overview-wrong-source');
const overviewFromFaq = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Several options are available.', evidenceIds: ['faq-source'],
    stateUpdate: { requestType: 'overview' }, pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true, entities: [], sources: [{
      id: 'faq-source', recordId: 'faq-record', recordType: 'FAQ',
      content: 'Several options are available.',
    }],
  },
  memory: overviewMemory, turnToken: 'overview-wrong-source',
  evidence: [{
    id: 'faq-source', recordId: 'faq-record', recordType: 'FAQ',
    callerFacing: true, content: 'Several options are available.',
  }],
  finalizedUtterance: 'What options are available?',
});
assert.equal(overviewFromFaq.valid, false);
assert.equal(overviewFromFaq.reason, 'overview_conversation_evidence_required');
overviewMemory.beginTurn('overview-message-source');
const overviewFromGuidance = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Approved options are available.', evidenceIds: ['message-source'],
    stateUpdate: { requestType: 'overview' }, pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true, entities: [], sources: [{
      id: 'message-source', recordId: 'message-record', recordType: 'CONVERSATION_NODE',
      content: 'Approved options are available.',
    }],
  },
  memory: overviewMemory, turnToken: 'overview-message-source',
  evidence: [{
    id: 'message-source', recordId: 'message-record', recordType: 'CONVERSATION_NODE',
    callerFacing: true, content: 'Approved options are available.',
    authoritativeData: { nodeType: 'message' },
  }],
  finalizedUtterance: 'What options are available?',
});
assert.equal(overviewFromGuidance.valid, true);
overviewMemory.close();

const noToolMemory = openGenericConversationState(
  { ...identity, callId: 'call-no-tool-collection' }, settings, 1,
);
noToolMemory.beginTurn('no-tool-collection');
const noToolCollection = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: { collectedInformation: { contact_name: 'Asha' } },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope, memory: noToolMemory, turnToken: 'no-tool-collection',
  fieldSchemas: settings.conversationMemoryFields, tools: [],
  evidence: envelope.sources, finalizedUtterance: 'Asha asked for the office location.',
});
assert.equal(noToolCollection.valid, true,
  'UI-configured current-call fields must remain usable without an external tool');
assert.deepEqual(noToolCollection.state.collectedInformation, { contact_name: 'Asha' });
noToolMemory.close();
const catalogMemory = openGenericConversationState(
  { ...identity, callId: 'call-catalog-memory' }, {}, 1,
);
catalogMemory.beginTurn('catalog-turn');
const catalogEvidence = {
  id: 'catalog-source', recordId: 'catalog-record', recordType: 'CATALOG_ITEM',
  callerFacing: true, content: 'Current service includes approved support.',
  retrievalContext: 'primary', channels: ['catalog_identity'],
  authoritativeData: {
    itemKey: 'current-service', name: 'Current Service', category: 'Services',
    categoryKey: 'services', attributes: [{ key: 'support', value: 'Included' }],
  },
};
const catalogTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['catalog-source'],
    stateUpdate: {
      currentTopic: null, knownEntityKeys: [], collectedInformation: {}, correctedFields: [],
      contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'catalog-source', recordId: catalogEvidence.recordId,
      recordType: catalogEvidence.recordType, content: catalogEvidence.content,
      authoritativeData: catalogEvidence.authoritativeData,
    }],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: catalogMemory, turnToken: 'catalog-turn', evidence: [catalogEvidence],
  finalizedUtterance: 'Explain the current service.',
});
assert.equal(catalogTurn.valid, true);
assert.equal(catalogTurn.state.knownEntities[0].key, 'current-service',
  'One explicitly resolved Catalog item must become the canonical selected entity');
assert.equal(catalogTurn.state.activeEntity.id, catalogEvidence.recordId,
  'Validated Catalog identity must retain its authoritative record ID in call memory');

const candidateOnlyMemory = openGenericConversationState(
  { ...identity, callId: 'call-candidate-only-memory' }, {}, 1,
);
candidateOnlyMemory.beginTurn('candidate-only-turn');
const candidateOnlyTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['catalog-source'],
    stateUpdate: {
      currentTopic: 'current-service', knownEntityKeys: ['current-service'],
      contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'catalog-source', recordId: catalogEvidence.recordId,
      recordType: catalogEvidence.recordType, content: catalogEvidence.content,
      authoritativeData: catalogEvidence.authoritativeData,
    }],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      sourceId: 'catalog-source',
    }],
  },
  memory: candidateOnlyMemory,
  turnToken: 'candidate-only-turn',
  evidence: [{ ...catalogEvidence, channels: ['semantic'], reservationReasons: [] }],
  finalizedUtterance: 'Which option may be relevant?',
});
assert.equal(candidateOnlyTurn.valid, true);
assert.deepEqual(candidateOnlyTurn.state.knownEntities, [],
  'A cited retrieval candidate must not become canonical memory without explicit or contextual selection');
assert.equal(candidateOnlyTurn.state.activeEntity, null);
candidateOnlyMemory.close();

const categoryMemory = openGenericConversationState(
  { ...identity, callId: 'call-category-memory' }, {}, 1,
  { activeEntity: { id: 'stale-record', key: 'stale-item', name: 'Stale Item' } },
);
categoryMemory.beginTurn('category-turn');
const categoryEvidence = {
  id: 'category-source', recordId: 'category-record', recordType: 'CATALOG_CATEGORY',
  callerFacing: true, retrievalContext: 'primary', channels: ['structured'],
  content: 'Service Options. Approved services. Available options: Current Service, Alternate Service.',
  authoritativeData: {
    categoryKey: 'services', category: 'Service Options', categoryDescription: 'Approved services.',
    children: [
      { recordId: catalogEvidence.recordId, itemKey: 'current-service', name: 'Current Service' },
      { recordId: 'alternate-record', itemKey: 'alternate-service', name: 'Alternate Service' },
    ],
  },
};
const categoryChildEvidence = categoryEvidence.authoritativeData.children.map((child, index) => ({
  id: `category-child-source-${index + 1}`,
  recordId: child.recordId,
  recordType: 'CATALOG_ITEM',
  callerFacing: true,
  retrievalContext: 'primary',
  channels: ['semantic'],
  content: `${child.name} details.`,
  authoritativeData: {
    itemKey: child.itemKey,
    name: child.name,
    category: categoryEvidence.authoritativeData.category,
    categoryKey: categoryEvidence.authoritativeData.categoryKey,
  },
}));
const categoryTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: categoryEvidence.content, evidenceIds: ['category-source'],
    stateUpdate: {
      requestType: 'category_overview', knownEntityKeys: ['services'], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      {
        id: 'category-source', recordId: categoryEvidence.recordId,
        recordType: categoryEvidence.recordType, content: categoryEvidence.content,
        authoritativeData: categoryEvidence.authoritativeData,
      },
      ...categoryChildEvidence.map((source) => ({
        id: source.id, recordId: source.recordId, recordType: source.recordType,
        content: source.content, authoritativeData: source.authoritativeData,
      })),
    ],
    entities: [
      {
        id: categoryEvidence.recordId, key: 'services', name: 'Service Options',
        entityType: 'CATEGORY', category: 'Service Options', categoryKey: 'services',
        sourceId: 'category-source',
      },
      ...categoryChildEvidence.map((source) => ({
        id: source.recordId,
        key: source.authoritativeData.itemKey,
        name: source.authoritativeData.name,
        category: source.authoritativeData.category,
        categoryKey: source.authoritativeData.categoryKey,
        sourceId: source.id,
      })),
    ],
  },
  memory: categoryMemory, turnToken: 'category-turn',
  evidence: [categoryEvidence, ...categoryChildEvidence],
  finalizedUtterance: 'Tell me about the service options.',
});
assert.equal(categoryTurn.valid, true);
assert.notEqual(categoryTurn.reason, 'latest_request_evidence_mismatch',
  'a selected primary category must not require an unrelated child-item citation');
assert.equal(categoryTurn.state.activeEntity, null);
assert.equal(categoryTurn.state.activeCategory.id, categoryEvidence.recordId);
assert.equal(categoryTurn.state.activeCategory.key, 'services',
  'Validated category ID and key must replace stale item memory');
categoryMemory.close();

const comparisonMemory = openGenericConversationState(
  { ...identity, callId: 'call-multi-record-memory' }, {}, 1,
);
comparisonMemory.beginTurn('comparison-turn');
const alternateEvidence = {
  ...catalogEvidence,
  id: 'alternate-source', recordId: 'alternate-record',
  content: 'Alternate Service includes approved alternate support.',
  authoritativeData: {
    ...catalogEvidence.authoritativeData,
    itemKey: 'alternate-service', name: 'Alternate Service',
  },
};
const comparisonTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer',
    answer: `${catalogEvidence.content} ${alternateEvidence.content}`,
    evidenceIds: ['catalog-source', 'alternate-source'],
    stateUpdate: {
      requestType: 'comparison',
      knownEntityKeys: ['current-service', 'alternate-service'], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      { id: 'catalog-source', recordId: catalogEvidence.recordId, recordType: 'CATALOG_ITEM',
        content: catalogEvidence.content, authoritativeData: catalogEvidence.authoritativeData },
      { id: 'alternate-source', recordId: alternateEvidence.recordId, recordType: 'CATALOG_ITEM',
        content: alternateEvidence.content, authoritativeData: alternateEvidence.authoritativeData },
    ],
    entities: [
      { id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
        category: 'Services', categoryKey: 'services', sourceId: 'catalog-source' },
      { id: alternateEvidence.recordId, key: 'alternate-service', name: 'Alternate Service',
        category: 'Services', categoryKey: 'services', sourceId: 'alternate-source' },
    ],
  },
  memory: comparisonMemory, turnToken: 'comparison-turn',
  evidence: [catalogEvidence, alternateEvidence].map((source) => ({
    ...source, channels: ['semantic'], reservationReasons: ['explicit_comparison'],
  })),
  finalizedUtterance: 'Compare both services.',
});
assert.equal(comparisonTurn.valid, true);
assert.equal(comparisonTurn.state.activeEntity, null,
  'Multi-record evidence must not persist an arbitrary first item as the active entity');
assert.equal(comparisonTurn.state.knownEntities.length, 2);
comparisonMemory.close();

const guidanceMemory = openGenericConversationState(
  { ...identity, callId: 'call-selected-guidance' }, {}, 1,
  { pendingQuestion: { text: 'Stale introduction question?', kind: 'conversation' } },
);
guidanceMemory.beginTurn('selected-guidance-turn');
const guidanceEvidence = {
  id: 'guidance-source', recordId: 'guidance-record', recordType: 'CONVERSATION_NODE',
  callerFacing: false, content: 'Internal continuation guidance.', retrievalContext: 'primary',
  authoritativeData: {
    nodeType: 'guidance', nextQuestion: 'Would you like another approved option?',
  },
};
const selectedGuidanceTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['catalog-source'],
    stateUpdate: {
      knownEntityKeys: ['current-service'], collectedInformation: {}, correctedFields: [],
      contextDependent: false,
    },
    pendingQuestion: 'Would you like another approved option?', toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'catalog-source', recordId: catalogEvidence.recordId,
      recordType: catalogEvidence.recordType, content: catalogEvidence.content,
      authoritativeData: catalogEvidence.authoritativeData,
    }],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: guidanceMemory, turnToken: 'selected-guidance-turn',
  evidence: [catalogEvidence, guidanceEvidence], finalizedUtterance: 'Explain the current service.',
});
assert.equal(selectedGuidanceTurn.valid, true);
assert.equal(selectedGuidanceTurn.answer,
  `${catalogEvidence.content} Would you like another approved option?`);
assert.equal(selectedGuidanceTurn.pendingQuestion.text, 'Would you like another approved option?');
assert.notEqual(selectedGuidanceTurn.pendingQuestion.text, 'Stale introduction question?');
guidanceMemory.close();

const clarificationMemory = openGenericConversationState(
  { ...identity, callId: 'call-turn-local-clarification' }, {}, 1,
);
clarificationMemory.beginTurn('clarification-turn');
const clarificationTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'clarify', answer: '', evidenceIds: ['stale-provider-source'], stateUpdate: {},
    pendingQuestion: 'Which approved option do you mean?', toolRequest: null,
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: clarificationMemory, turnToken: 'clarification-turn', evidence: [],
  finalizedUtterance: 'That one.',
});
assert.equal(clarificationTurn.valid, true);
assert.equal(clarificationTurn.answer, 'Which approved option do you mean?');
assert.equal(clarificationTurn.state.pendingQuestion, null,
  'clarification recovery context must not become a configured workflow question');
assert.equal(clarificationTurn.state.pendingClarification.text,
  'Which approved option do you mean?');
assert.equal(clarificationTurn.state.pendingClarification.attemptCount, 1);
clarificationMemory.close();

const unavailableSpeech = 'That information is not available in my published knowledge.';
const unavailableMemory = openGenericConversationState(
  { ...identity, callId: 'call-zero-evidence-unavailable' }, {}, 1,
);
unavailableMemory.beginTurn('zero-evidence-unavailable-turn');
const unavailableTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: unavailableSpeech, evidenceIds: [], stateUpdate: {},
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: unavailableMemory, turnToken: 'zero-evidence-unavailable-turn', evidence: [],
  finalizedUtterance: 'What is the unsupported published fact?',
  zeroEvidenceResponse: unavailableSpeech,
});
assert.equal(unavailableTurn.valid, true);
assert.equal(unavailableTurn.answer, unavailableSpeech);
unavailableMemory.close();

const noMatchMemory = openGenericConversationState(
  { ...identity, callId: 'call-zero-evidence-no-match' }, {}, 1,
  { currentTopic: 'preserved-topic', knownEntityKeys: [], knownEntities: [] },
);
noMatchMemory.beginTurn('zero-evidence-no-match-turn');
const noMatchTurn = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'NO_MATCH', answer: '', responseId: null, evidenceIds: [],
    toolName: null, toolArguments: null, clarificationReason: null,
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: noMatchMemory, turnToken: 'zero-evidence-no-match-turn', evidence: [],
  finalizedUtterance: 'What is the unsupported published fact?',
  zeroEvidenceResponse: unavailableSpeech,
});
assert.equal(noMatchTurn.valid, true);
assert.equal(noMatchTurn.decision, 'answer');
assert.equal(noMatchTurn.answer, unavailableSpeech);
assert.equal(noMatchTurn.noMatch, true);
assert.deepEqual(noMatchTurn.evidenceIds, []);
assert.equal(noMatchTurn.state.currentTopic, 'preserved-topic',
  'NO_MATCH must not replace canonical memory');
noMatchMemory.close();

const clearUnsupportedMemory = openGenericConversationState(
  { ...identity, callId: 'call-clear-unsupported' }, {}, 1,
);
clearUnsupportedMemory.beginTurn('clear-unsupported-turn');
const clearUnsupportedTurn = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'CLARIFY', answer: 'Can you clarify?', responseId: null, evidenceIds: [],
    toolName: null, toolArguments: null, clarificationReason: 'missing_evidence',
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: clearUnsupportedMemory, turnToken: 'clear-unsupported-turn', evidence: [],
  finalizedUtterance: 'What is the unpublished price?',
  zeroEvidenceResponse: unavailableSpeech,
  clarificationContext: { genuineAmbiguity: false, ambiguityCandidates: [] },
});
assert.equal(clearUnsupportedTurn.valid, true);
assert.equal(clearUnsupportedTurn.answer, unavailableSpeech);
assert.equal(clearUnsupportedTurn.clearUnsupportedRequest, true);
assert.equal(clearUnsupportedTurn.nextQuestion, null);
clearUnsupportedMemory.close();

const mismatchedCitation = validatePostLlmResponseAndTool({
  decision: {
    decision: 'answer', answer: 'Published fact.', evidenceIds: ['source-other'],
    stateUpdate: { knownEntities: [], collectedInformation: {} },
  },
  selectedEvidence: [{ id: 'source-selected', content: 'Published fact.' }],
});
assert.equal(mismatchedCitation.valid, false);
assert.equal(mismatchedCitation.reason, 'citation_evidence_mismatch');

const zeroEvidenceInventedMemory = openGenericConversationState(
  { ...identity, callId: 'call-zero-evidence-invented' }, {}, 1,
);
zeroEvidenceInventedMemory.beginTurn('zero-evidence-invented-turn');
const inventedTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'An invented factual response.', evidenceIds: [], stateUpdate: {},
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: zeroEvidenceInventedMemory, turnToken: 'zero-evidence-invented-turn', evidence: [],
  finalizedUtterance: 'What is the unsupported published fact?',
  zeroEvidenceResponse: unavailableSpeech,
});
assert.equal(inventedTurn.valid, false);
assert.equal(inventedTurn.reason, 'verified_evidence_missing');
zeroEvidenceInventedMemory.close();

const incompleteMemory = openGenericConversationState(
  { ...identity, callId: 'call-incomplete-evidence' }, {}, 1,
);
incompleteMemory.beginTurn('incomplete-evidence-turn');
const incompleteTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Unverified response.',
    evidenceIds: ['source-missing'], stateUpdate: {},
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'source-missing', publishedEvidenceId: 'published-missing',
      recordId: 'record-missing', recordType: 'FAQ', content: 'Compact evidence.',
    }],
    entities: [],
  },
  memory: incompleteMemory, turnToken: 'incomplete-evidence-turn', evidence: [],
  finalizedUtterance: 'What is the approved response?',
});
assert.equal(incompleteTurn.reason, 'incomplete_evidence_metadata');
incompleteMemory.close();

const mismatchedEvidenceMemory = openGenericConversationState(
  { ...identity, callId: 'call-latest-entity-alignment' }, {}, 1,
);
mismatchedEvidenceMemory.beginTurn('entity-alignment-turn');
const genericEvidence = {
  id: 'generic-source', recordId: 'generic-record', recordType: 'FAQ',
  callerFacing: true, content: 'Generic approved information.', retrievalContext: 'primary',
  authoritativeData: { question: 'General information', answer: 'Generic approved information.' },
};
const mismatchedEvidenceTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: genericEvidence.content, evidenceIds: ['generic-source'],
    stateUpdate: { contextDependent: false }, pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      { id: 'catalog-source', recordId: catalogEvidence.recordId, recordType: 'CATALOG_ITEM',
        content: catalogEvidence.content, authoritativeData: catalogEvidence.authoritativeData },
      { id: 'generic-source', recordId: genericEvidence.recordId, recordType: 'FAQ',
        content: genericEvidence.content, authoritativeData: genericEvidence.authoritativeData },
    ],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      sourceId: 'catalog-source',
    }],
  },
  memory: mismatchedEvidenceMemory, turnToken: 'entity-alignment-turn',
  evidence: [{
    ...catalogEvidence, channels: ['semantic'], reservationReasons: ['explicit_entity'],
  }, genericEvidence],
  finalizedUtterance: 'Explain the current service.',
});
assert.equal(mismatchedEvidenceTurn.valid, false);
assert.equal(mismatchedEvidenceTurn.reason, 'latest_request_evidence_mismatch');
mismatchedEvidenceMemory.close();

catalogMemory.beginTurn('remembered-context-turn');
const rememberedContextEvidence = {
  ...catalogEvidence,
  retrievalContext: 'contextual',
  channels: ['conversation_memory'],
};
const rememberedContextTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['catalog-source'],
    stateUpdate: {
      currentTopic: 'current-service', knownEntityKeys: ['current-service'],
      collectedInformation: {}, correctedFields: [], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'catalog-source', recordId: catalogEvidence.recordId,
      recordType: catalogEvidence.recordType, content: catalogEvidence.content,
      authoritativeData: catalogEvidence.authoritativeData,
    }],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: catalogMemory, turnToken: 'remembered-context-turn',
  evidence: [rememberedContextEvidence], finalizedUtterance: 'What does it include?',
});
assert.equal(rememberedContextTurn.valid, true,
  'canonical conversation-memory evidence determines contextual follow-up state');

catalogMemory.beginTurn('remembered-multi-citation-turn');
const distractorCatalogEvidence = {
  ...catalogEvidence,
  id: 'distractor-catalog-source', recordId: 'distractor-catalog-record',
  retrievalContext: 'primary', channels: ['semantic'],
  authoritativeData: {
    ...catalogEvidence.authoritativeData,
    itemKey: 'distractor-service', name: 'Distractor Service',
  },
};
const rememberedMultiCitationTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content,
    evidenceIds: ['catalog-source', 'distractor-catalog-source'],
    stateUpdate: {
      currentTopic: 'distractor-service', knownEntityKeys: ['distractor-service'],
      collectedInformation: {}, correctedFields: [], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      {
        id: 'catalog-source', recordId: catalogEvidence.recordId,
        recordType: catalogEvidence.recordType, content: catalogEvidence.content,
        authoritativeData: catalogEvidence.authoritativeData,
      },
      {
        id: distractorCatalogEvidence.id, recordId: distractorCatalogEvidence.recordId,
        recordType: distractorCatalogEvidence.recordType, content: distractorCatalogEvidence.content,
        authoritativeData: distractorCatalogEvidence.authoritativeData,
      },
    ],
    entities: [
      {
        id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
        category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
      },
      {
        id: distractorCatalogEvidence.recordId, key: 'distractor-service',
        name: 'Distractor Service', category: 'Services', categoryKey: 'services',
        sourceId: 'distractor-catalog-source',
      },
    ],
  },
  memory: catalogMemory, turnToken: 'remembered-multi-citation-turn',
  evidence: [rememberedContextEvidence, distractorCatalogEvidence],
  finalizedUtterance: 'What tests does this include?',
});
assert.equal(rememberedMultiCitationTurn.valid, true);
assert.ok(rememberedMultiCitationTurn.state.knownEntities.some((entity) => (
  entity.key === 'current-service'
)), 'a weak primary semantic candidate must not replace the memory-selected Catalog entity');

catalogMemory.beginTurn('remembered-citation-turn');
const duplicateFactEvidence = {
  id: 'duplicate-fact-source', recordId: 'duplicate-fact-record', recordType: 'FAQ',
  callerFacing: true, content: catalogEvidence.content, retrievalContext: 'primary',
};
const selectedCatalogEvidenceWithoutMemoryChannel = {
  ...catalogEvidence, retrievalContext: 'primary', channels: ['semantic'],
};
const rememberedCitationTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content,
    evidenceIds: ['duplicate-fact-source'],
    stateUpdate: { collectedInformation: {}, correctedFields: [], contextDependent: false },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      {
        id: 'catalog-source', recordId: catalogEvidence.recordId,
        recordType: catalogEvidence.recordType, content: catalogEvidence.content,
        authoritativeData: catalogEvidence.authoritativeData,
      },
      {
        id: 'duplicate-fact-source', recordId: duplicateFactEvidence.recordId,
        recordType: duplicateFactEvidence.recordType, content: duplicateFactEvidence.content,
      },
    ],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: catalogMemory, turnToken: 'remembered-citation-turn',
  evidence: [selectedCatalogEvidenceWithoutMemoryChannel, duplicateFactEvidence],
  finalizedUtterance: 'What does this include?',
});
assert.equal(rememberedCitationTurn.valid, true);
assert.ok(rememberedCitationTurn.evidenceIds.includes('catalog-source'),
  'a contextual fact answer must retain its canonical memory-selected Catalog citation');

const exactCatalogMemory = openGenericConversationState({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a',
  callId: 'exact-catalog-citation-call',
});
exactCatalogMemory.beginTurn('exact-catalog-citation-turn');
const exactCatalogCitationTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content,
    evidenceIds: ['duplicate-fact-source'],
    stateUpdate: { collectedInformation: {}, correctedFields: [], contextDependent: false },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      {
        id: 'catalog-source', recordId: catalogEvidence.recordId,
        recordType: catalogEvidence.recordType, content: catalogEvidence.content,
        authoritativeData: catalogEvidence.authoritativeData,
      },
      {
        id: 'duplicate-fact-source', recordId: duplicateFactEvidence.recordId,
        recordType: duplicateFactEvidence.recordType, content: duplicateFactEvidence.content,
      },
    ],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: exactCatalogMemory, turnToken: 'exact-catalog-citation-turn',
  evidence: [
    { ...catalogEvidence, retrievalContext: 'primary', channels: ['catalog_identity'] },
    duplicateFactEvidence,
  ],
  finalizedUtterance: 'Explain Current Service.',
});
assert.equal(exactCatalogCitationTurn.valid, true);
assert.ok(exactCatalogCitationTurn.evidenceIds.includes('catalog-source'),
  'an exact latest-turn Catalog identity must always retain its canonical citation');
exactCatalogMemory.close();

catalogMemory.beginTurn('stale-catalog-turn');
const staleContextEvidence = {
  ...catalogEvidence, retrievalContext: 'contextual',
};
const staleCatalogTurn = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['catalog-source'],
    stateUpdate: {
      currentTopic: 'different request', knownEntityKeys: [], collectedInformation: {},
      correctedFields: [], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [{
      id: 'catalog-source', recordId: catalogEvidence.recordId,
      recordType: catalogEvidence.recordType, content: catalogEvidence.content,
      authoritativeData: catalogEvidence.authoritativeData,
    }],
    entities: [{
      id: catalogEvidence.recordId, key: 'current-service', name: 'Current Service',
      category: 'Services', categoryKey: 'services', sourceId: 'catalog-source',
    }],
  },
  memory: catalogMemory, turnToken: 'stale-catalog-turn', evidence: [staleContextEvidence],
  finalizedUtterance: 'Explain a different service.',
});
assert.equal(staleCatalogTurn.valid, false);
assert.equal(staleCatalogTurn.reason, 'latest_request_evidence_mismatch');

// A newer primary Catalog match must override a previously selected entity.
catalogMemory.beginTurn('new-primary-item-turn');
const primaryItem = {
  ...catalogEvidence, id: 'catalog-primary', recordId: 'catalog-primary',
  retrievalContext: 'primary', rank: 1, channels: ['semantic'],
  reservationReasons: ['explicit_entity'],
  authoritativeData: { ...catalogEvidence.authoritativeData, itemKey: 'new-item', name: 'New Item' },
};
const staleItem = {
  ...catalogEvidence, id: 'catalog-stale', recordId: 'catalog-stale',
  retrievalContext: 'contextual', rank: 2,
  authoritativeData: { ...catalogEvidence.authoritativeData, itemKey: 'old-item', name: 'Old Item' },
};
const primaryMismatch = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'Old Item details.', evidenceIds: ['catalog-stale'],
    stateUpdate: {
      currentTopic: 'old-item', knownEntityKeys: ['old-item'], collectedInformation: {},
      correctedFields: [], contextDependent: false,
    }, pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      { id: 'catalog-primary', recordId: 'catalog-primary', recordType: 'CATALOG_ITEM', content: 'New Item details.' },
      { id: 'catalog-stale', recordId: 'catalog-stale', recordType: 'CATALOG_ITEM', content: 'Old Item details.' },
    ],
    entities: [
      { id: 'catalog-primary', key: 'new-item', name: 'New Item' },
      { id: 'catalog-stale', key: 'old-item', name: 'Old Item' },
    ],
  },
  memory: catalogMemory, turnToken: 'new-primary-item-turn',
  evidence: [primaryItem, staleItem], finalizedUtterance: 'Tell me about New Item.',
});
assert.equal(primaryMismatch.valid, false);
assert.equal(primaryMismatch.reason, 'latest_request_evidence_mismatch');

catalogMemory.beginTurn('new-primary-valid-turn');
const currentPrimaryItem = {
  ...primaryItem, content: 'New Item details.',
};
const validPrimaryWithStaleSupport = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'New Item details.', evidenceIds: ['catalog-primary'],
    stateUpdate: {
      currentTopic: 'new-item', knownEntityKeys: ['new-item'], collectedInformation: {},
      correctedFields: [], contextDependent: false,
    }, pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: {
    found: true,
    sources: [
      { id: 'catalog-primary', recordId: 'catalog-primary', recordType: 'CATALOG_ITEM', content: 'New Item details.' },
      { id: 'catalog-stale', recordId: 'catalog-stale', recordType: 'CATALOG_ITEM', content: 'Old Item details.' },
    ],
    entities: [
      { id: 'catalog-primary', key: 'new-item', name: 'New Item' },
      { id: 'catalog-stale', key: 'old-item', name: 'Old Item' },
    ],
  },
  memory: catalogMemory, turnToken: 'new-primary-valid-turn',
  evidence: [currentPrimaryItem, staleItem], finalizedUtterance: 'Tell me about New Item.',
});
assert.equal(validPrimaryWithStaleSupport.valid, true,
  'stale supporting evidence must not turn a valid latest-request answer into an evidence mismatch');
assert.notEqual(validPrimaryWithStaleSupport.reason, 'latest_request_evidence_mismatch');
catalogMemory.close();
const sideAnswer = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: {
      currentTopic: 'office location', knownEntityKeys: [], collectedInformation: {},
      correctedFields: [], language: 'en', pendingQuestionRelevant: true,
      requestType: 'location_question', requestedFacts: ['location'], constraints: [],
      contextualReferences: [], contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-1',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
  finalizedUtterance: 'Where is the office?',
});
assert.equal(sideAnswer.valid, true);
assert.equal(sideAnswer.answer, 'The office is on Central Road.');
assert.equal(sideAnswer.pendingQuestion, null,
  'an unrelated saved field question must not continue without an authorized active tool');
assert.equal(sideAnswer.state.lastAnswer, sideAnswer.answer);
assert.equal(sideAnswer.state.requestType, 'location_question');
assert.deepEqual(sideAnswer.state.requestedFacts, ['location']);
assert.equal(sideAnswer.state.recentTurns.at(-1).role, 'assistant');
assert.equal(sideAnswer.state.recentTurns.at(-1).content, sideAnswer.answer);
assert.deepEqual(Object.keys(sideAnswer.state).sort(), [...genericConversationStateFields].sort());

memory.beginTurn('turn-2');
const corrected = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: {
      currentTopic: 'office location', knownEntityKeys: [],
      collectedInformation: { preferred_date: 'Friday' }, correctedFields: ['preferred_date'],
      language: 'en', pendingQuestionRelevant: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-2',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
  finalizedUtterance: 'Friday works for me.',
});
assert.equal(corrected.valid, true,
  'A caller-provided current-call field without requiredAction remains valid');
assert.equal(corrected.state.collectedInformation.preferred_date, 'Friday');
assert.equal(corrected.state.pendingQuestion, null);

const stale = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: { currentTopic: 'stale topic', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-1',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
  finalizedUtterance: 'This is stale.',
});
assert.equal(stale.valid, false);
assert.equal(stale.reason, 'stale_turn');
assert.equal(memory.snapshot().currentTopic, 'office location');

memory.beginTurn('turn-3');
const naturalNegation = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer', answer: 'The office is not on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: { currentTopic: 'incorrect location', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-3',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
  finalizedUtterance: 'Where is the office?',
});
assert.equal(naturalNegation.valid, true);
assert.equal(memory.snapshot().currentTopic, 'incorrect location');

memory.close();

const actionSettings = {
  conversationMemoryFields: [
    { key: 'contact_name', label: 'Contact name', type: 'text', required: true, requiredAction: 'create_request', question: 'What name should I use?' },
  ],
};
const actionTool = {
  id: 'tool-1', name: 'create_request', description: 'Create a configured request',
  configuration: {
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['contact_name'],
      properties: { contact_name: { type: 'string', minLength: 2 } },
    },
  },
};
const actionEnvelope = {
  found: true,
  sources: [{
    id: 'item-source', recordId: 'item-record', recordType: 'CATALOG_ITEM',
    content: 'Priority service is an approved selectable service.',
    authoritativeData: {
      itemKey: 'priority-service', name: 'Priority service',
      selectionRules: { selectable: true },
    },
  }],
  entities: [{ id: 'item-1', key: 'priority-service', name: 'Priority service', sourceId: 'item-source' }],
};
const actionEvidence = [
  {
    id: 'item-source', recordId: 'item-record', recordType: 'CATALOG_ITEM',
    tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 3,
    callerFacing: true, content: 'Priority service is an approved selectable service.',
    channels: ['catalog_identity'], retrievalContext: 'primary',
    authoritativeData: {
      itemKey: 'priority-service', name: 'Priority service',
      selectionRules: { selectable: true },
    },
  },
  {
    id: 'workflow-source', recordId: 'workflow-record', recordType: 'WORKFLOW_RULE',
    tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 3,
    callerFacing: false, activationAllowed: true,
    authoritativeData: {
      actionType: 'configured_tool',
      actionConfig: { toolIdentifier: 'create_request', requiresCatalogItem: true },
    },
  },
];
const evidenceScope = {
  tenantId: 'tenant-a', agentId: 'agent-a',
  publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 3 }],
};
const configuredAliasTool = {
  ...actionTool,
  id: 'tool-configured-name',
  name: 'create_request-1',
  identifiers: ['create_request-1', 'create_request'],
};
const configuredAliasFields = actionSettings.conversationMemoryFields.map((field) => ({
  ...field, requiredAction: 'create_request-1',
}));
const deterministicActionMemory = openGenericConversationState(
  { ...identity, callId: 'call-deterministic-action' },
  { conversationMemoryFields: configuredAliasFields },
);
deterministicActionMemory.beginTurn('deterministic-action-turn');
const deterministicAction = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'answer',
    answer: 'Priority service is an approved selectable service.',
    evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: {}, correctedFields: [], pendingQuestionRelevant: false,
      activeToolRequest: { name: 'create_request-1' },
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: actionEnvelope,
  memory: deterministicActionMemory,
  turnToken: 'deterministic-action-turn',
  fieldSchemas: configuredAliasFields,
  tools: [configuredAliasTool],
  evidence: actionEvidence,
  evidenceScope,
  finalizedUtterance: 'Use the configured action for this priority service.',
});
assert.equal(deterministicAction.valid, true);
assert.equal(deterministicAction.state.activeToolRequest.name, 'create_request-1');
assert.equal(deterministicAction.state.activeToolRequest.authorizationRecordId, 'workflow-record');
assert.equal(deterministicAction.nextQuestion?.key, 'contact_name');
assert.equal(deterministicAction.toolRequest, null);

const actionMemory = openGenericConversationState(
  { ...identity, callId: 'call-action' }, actionSettings,
);
actionMemory.beginTurn('action-turn');
const sameTurnAction = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'Asha' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'Asha' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: actionMemory,
  turnToken: 'action-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool],
  evidence: actionEvidence,
  evidenceScope,
  finalizedUtterance: 'Create the priority service request for Asha.',
});
assert.equal(sameTurnAction.valid, true);
assert.equal(sameTurnAction.toolRequest, null,
  'A TOOL decision in the collection turn must wait for final confirmation');
assert.equal(sameTurnAction.nextQuestion?.kind, 'confirmation');
assert.match(sameTurnAction.answer, /Asha/u);
assert.equal(sameTurnAction.state.activeToolRequest.status, 'awaiting_confirmation');
assert.equal(sameTurnAction.state.knownEntities[0].key, 'priority-service');
assert.equal(sameTurnAction.state.collectedInformation.contact_name, 'Asha');

const unauthorizedMemory = openGenericConversationState(
  { ...identity, callId: 'call-unauthorized' }, actionSettings,
);
unauthorizedMemory.beginTurn('unauthorized-turn');
const unauthorizedAction = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'Asha' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'Asha' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: unauthorizedMemory,
  turnToken: 'unauthorized-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool],
  evidence: actionEvidence.map((source) => (
    source.recordType === 'WORKFLOW_RULE' ? { ...source, activationAllowed: false } : source
  )),
  evidenceScope,
  finalizedUtterance: 'Create the priority service request for Asha.',
});
assert.equal(unauthorizedAction.valid, false);
assert.equal(unauthorizedAction.reason, 'unauthorized_tool_request');
assert.deepEqual(unauthorizedAction.state.knownEntities, []);
assert.equal(unauthorizedAction.state.activeToolRequest, null);

const invalidArgumentsMemory = openGenericConversationState(
  { ...identity, callId: 'call-invalid-arguments' }, actionSettings,
);
invalidArgumentsMemory.beginTurn('invalid-arguments-turn');
const invalidArguments = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'A' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'A' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: invalidArgumentsMemory,
  turnToken: 'invalid-arguments-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool], evidence: actionEvidence, evidenceScope,
  finalizedUtterance: 'Create the priority service request for A.',
});
assert.equal(invalidArguments.valid, false);
assert.equal(invalidArguments.reason, 'invalid_tool_arguments');
assert.deepEqual(invalidArguments.state.knownEntities, [],
  'A rejected decision must not commit even a hydrated canonical entity');
assert.equal(invalidArguments.state.currentTopic, null);
assert.equal(invalidArguments.state.activeToolRequest, null);

const inventedMemory = openGenericConversationState(
  { ...identity, callId: 'call-invented-field' }, actionSettings,
);
inventedMemory.beginTurn('invented-turn');
const inventedField = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '',
    evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'Invented Name' }, correctedFields: [],
      pendingQuestionRelevant: false, activeToolRequest: { name: 'create_request' },
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'Invented Name' } },
  }),
  groundingEnvelope: actionEnvelope, memory: inventedMemory, turnToken: 'invented-turn',
  fieldSchemas: actionSettings.conversationMemoryFields, tools: [actionTool],
  evidence: actionEvidence, evidenceScope,
  finalizedUtterance: 'Tell me about priority service.',
});
assert.equal(inventedField.valid, false);
assert.equal(inventedField.reason, 'unsupported_caller_value');
assert.deepEqual(inventedField.state.collectedInformation, {});

const bookingFields = [
  { key: 'contact_name', label: 'Name', type: 'text', required: true, requiredAction: 'create_appointment', question: 'Name?' },
  { key: 'age', label: 'Age', type: 'number', required: true, requiredAction: 'create_appointment', question: 'Age?' },
  { key: 'visit_date', label: 'Date', type: 'text', required: true, requiredAction: 'create_appointment', question: 'Date?' },
  { key: 'visit_time', label: 'Time', type: 'text', required: true, requiredAction: 'create_appointment', question: 'Time?' },
  { key: 'selected_service', label: 'Service', type: 'text', required: true, requiredAction: 'create_appointment', question: 'Service?' },
];
const bookingTool = {
  ...actionTool,
  id: 'appointment-tool', name: 'create_appointment',
  configuration: {
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: bookingFields.map((field) => field.key),
      properties: Object.fromEntries(bookingFields.map((field) => [field.key, {
        type: field.key === 'age' ? 'integer' : 'string',
      }])),
    },
  },
};
const bookingActionEvidence = actionEvidence.map((source) => (
  source.recordType === 'WORKFLOW_RULE'
    ? {
      ...source,
      authoritativeData: {
        ...source.authoritativeData,
        actionConfig: {
          ...source.authoritativeData.actionConfig,
          toolIdentifier: 'create_appointment',
        },
      },
    }
    : source
));
const confirmationConfiguration = {
  enabled: true, intent: 'create_appointment',
  requiredFields: bookingFields.map((field) => field.key),
  confirmationMessage: 'Are these details correct?',
  requiresCatalogItem: true, catalogField: 'selected_service',
};
const bookingMemory = openGenericConversationState(
  { ...identity, callId: 'call-confirmation' }, { conversationMemoryFields: bookingFields },
);
bookingMemory.beginTurn('booking-details-turn');
const sameTurnDetails = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service request', knownEntityKeys: ['priority-service'],
      collectedInformation: {
        contact_name: 'Asha', age: 21, visit_date: 'tomorrow', visit_time: '11 AM',
        selected_service: 'Priority service',
      },
      correctedFields: [], pendingQuestionRelevant: false,
      activeToolRequest: { name: 'create_appointment' },
    },
    pendingQuestion: null,
    toolRequest: {
      name: 'create_appointment', arguments: {
        contact_name: 'Asha', age: 21, visit_date: 'tomorrow', visit_time: '11 AM',
        selected_service: 'Priority service',
      },
    },
  }),
  groundingEnvelope: actionEnvelope, memory: bookingMemory, turnToken: 'booking-details-turn',
  fieldSchemas: bookingFields, tools: [bookingTool], evidence: bookingActionEvidence, evidenceScope,
  finalizedUtterance: 'Book Priority service for Asha age 21 tomorrow at 11 AM.',
  confirmationConfiguration,
});
assert.equal(sameTurnDetails.valid, true);
assert.equal(sameTurnDetails.toolRequest, null, 'Tool must not execute in the collection turn');
assert.equal(sameTurnDetails.state.activeToolRequest.status, 'awaiting_confirmation');
assert.equal(sameTurnDetails.state.activeToolRequest.selectedEntityKey, 'priority-service');
for (const expected of ['Name: Asha', 'Age: 21', 'Date: tomorrow', 'Time: 11 AM', 'Service: Priority service']) {
  assert.match(sameTurnDetails.answer, new RegExp(expected, 'u'));
}
assert.match(sameTurnDetails.answer, /Are these details correct\?/u);

bookingMemory.beginTurn('booking-confirm-turn');
const confirmedAction = applyUnifiedGroundedTurn({
  rawDecision: unifiedDecision({
    decision: 'action', answer: '', evidenceIds: [],
    stateUpdate: {
      currentTopic: 'priority service request', knownEntityKeys: [],
      collectedInformation: {}, correctedFields: [], pendingQuestionRelevant: false,
      activeToolRequest: { name: 'create_appointment' },
    },
    pendingQuestion: null,
    toolRequest: {
      name: 'create_appointment', arguments: {
        contact_name: 'Asha', age: 21, visit_date: 'tomorrow', visit_time: '11 AM',
        selected_service: 'Priority service',
      },
    },
  }),
  groundingEnvelope: { found: false, sources: [], entities: [] },
  memory: bookingMemory, turnToken: 'booking-confirm-turn',
  fieldSchemas: bookingFields, tools: [bookingTool], evidence: [], evidenceScope,
  finalizedUtterance: 'Yes, confirm it.', confirmationConfiguration,
});
assert.equal(confirmedAction.valid, true);
assert.equal(confirmedAction.toolRequest.name, 'create_appointment');
assert.deepEqual(confirmedAction.toolRequest.arguments, {
  contact_name: 'Asha', age: 21, visit_date: 'tomorrow', visit_time: '11 AM',
  selected_service: 'Priority service',
});

actionMemory.close();
unauthorizedMemory.close();
invalidArgumentsMemory.close();
inventedMemory.close();
bookingMemory.close();
console.log('Unified grounded turn verification passed.');
