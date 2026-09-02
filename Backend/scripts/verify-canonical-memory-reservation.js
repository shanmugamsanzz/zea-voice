import assert from 'node:assert/strict';
import {
  confirmCanonicalTopicResolution,
} from '../src/knowledge-engine/canonical-topic-memory.js';
import {
  understandContextualKnowledgeQuery,
} from '../src/knowledge-engine/contextual-query-understanding.js';
import {
  buildContextEnrichedRetrievalQuery,
} from '../src/knowledge-engine/targeted-retrieval.js';
import { createNormalTurnInput } from '../src/knowledge-bases/normal-turn-contract.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';

const scope = Object.freeze({
  tenantId: 'synthetic-tenant', agentId: 'synthetic-agent', callId: 'synthetic-call',
});
const entity = Object.freeze({
  id: 'record-selected', recordId: 'record-selected', recordType: 'CATALOG_ITEM',
  entityType: 'ITEM', key: 'published-option', name: 'Published Option',
  tenantId: scope.tenantId, agentId: scope.agentId,
  knowledgeBaseId: 'published-kb', publicationRevision: 7,
});
const alternative = Object.freeze({
  ...entity, id: 'record-alternative', recordId: 'record-alternative',
  key: 'retrieved-alternative', name: 'Retrieved Alternative',
});
const explicitResolution = Object.freeze({
  version: 1, scope, mode: 'EXPLICIT', activeEntity: entity,
  activeCategory: null, comparisonEntities: Object.freeze([]),
});
const hydratedSelected = Object.freeze({
  ...entity, sourceId: 'source_1', hydrationValidated: true, publicationValidated: true,
  reservationReasons: Object.freeze(['explicit_entity']),
});
const hydratedAlternative = Object.freeze({
  ...alternative, sourceId: 'source_2', hydrationValidated: true, publicationValidated: true,
  reservationReasons: Object.freeze([]),
});
const category = Object.freeze({
  ...entity, id: 'record-category', recordId: 'record-category',
  recordType: 'CATALOG_CATEGORY', entityType: 'CATEGORY',
  key: 'published-category', name: 'Published Category',
  categoryKey: 'published-category', category: 'Published Category',
});
const explicitCategoryResolution = Object.freeze({
  version: 1, scope, mode: 'EXPLICIT', activeEntity: null,
  activeCategory: category, comparisonEntities: Object.freeze([]),
});
const hydratedCategory = Object.freeze({
  ...category, sourceId: 'source_category', hydrationValidated: true,
  publicationValidated: true, reservationReasons: Object.freeze(['explicit_entity']),
});

const confirmedExplicit = confirmCanonicalTopicResolution(explicitResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_1', 'source_2'],
    stateUpdate: { knownEntities: [entity] },
  },
  hydratedRecords: [hydratedSelected, hydratedAlternative],
});
assert.equal(confirmedExplicit.mode, 'EXPLICIT');
assert.equal(confirmedExplicit.activeEntity.recordId, entity.recordId);
const confirmedCategory = confirmCanonicalTopicResolution(explicitCategoryResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_category'],
    currentTopic: category.key,
    stateUpdate: { currentTopic: category.key, knownEntities: [] },
  },
  hydratedRecords: [hydratedCategory],
});
assert.equal(confirmedCategory.mode, 'EXPLICIT');
assert.equal(confirmedCategory.activeCategory.recordId, category.recordId,
  'A cited, explicitly reserved published category must be committed as activeCategory');
assert.equal(confirmCanonicalTopicResolution(explicitResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: [],
    stateUpdate: { knownEntities: [entity] },
  },
  hydratedRecords: [hydratedSelected],
}).mode, 'UNRESOLVED',
  'An explicitly retrieved candidate must not enter memory unless the grounded decision selected its source');
assert.equal(confirmCanonicalTopicResolution({
  ...explicitResolution,
  activeEntity: { ...entity, recordType: 'CATALOG_CATEGORY', entityType: 'CATEGORY' },
}, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_1'],
    stateUpdate: { knownEntities: [entity] },
  },
  hydratedRecords: [hydratedSelected],
}).mode, 'UNRESOLVED', 'A category must never be committed as the active selectable item');

const memory = openGenericConversationState(scope, {
  conversationContextMode: 'full_current_call', conversationContextTurns: 5,
});
memory.beginTurn('candidate-noise');
memory.applyGroundedDecision({
  stateUpdate: {
    currentTopic: `${entity.name} / ${alternative.name}`,
    knownEntities: [entity, alternative], contextDependent: false,
  },
}, { turnToken: 'candidate-noise', canonicalEntityAuthority: true });
assert.equal(memory.snapshot().activeEntity, null,
  'Retrieved alternatives must not become canonical memory');
memory.applyCanonicalTopicResolution(confirmedExplicit, { turnToken: 'candidate-noise' });
assert.equal(memory.snapshot().activeEntity.recordId, entity.recordId);
assert.equal(memory.snapshot().knownEntities.length, 1);
const priorSelectedRecordId = memory.snapshot().activeEntity.recordId;
assert.equal(memory.applyCanonicalTopicResolution({
  ...explicitResolution, mode: 'UNRESOLVED', activeEntity: alternative,
}, { turnToken: 'candidate-noise' }).applied, false);
assert.equal(memory.snapshot().activeEntity.recordId, priorSelectedRecordId,
  'Unresolved ranked alternatives must not replace the selected item');

const normalTurn = createNormalTurnInput({
  ...scope, finalizedQuestion: 'What is its published value?', memory: memory.snapshot(),
});
assert.equal(normalTurn.memory.activeEntity.knowledgeBaseId, 'published-kb');
assert.equal(normalTurn.memory.activeEntity.publicationRevision, 7);
const recordScope = new Map([[entity.recordId, Object.freeze({
  ...entity, canonicalName: entity.name, searchForms: Object.freeze(['Published Alias']),
})]]);
const contextualQuery = buildContextEnrichedRetrievalQuery({
  tenantId: scope.tenantId, agentId: scope.agentId,
  latestQuestion: 'What is its published value?',
  canonicalCallMemory: normalTurn.memory,
  recentRelevantTurns: normalTurn.memory.recentTurns,
  queryUnderstanding: { contextDependent: true, requestedFacts: ['published_value'] },
}, {}, { contextDependent: true }, [{ knowledgeBaseId: 'published-kb', publicationRevision: 7 }], recordScope);
const reservation = contextualQuery.reservedRecords.find((entry) => entry.reason === 'canonical_memory');
assert.equal(reservation.recordId, entity.recordId);
assert.equal(reservation.knowledgeBaseId, 'published-kb');
assert.equal(reservation.publicationRevision, 7);
assert.equal(contextualQuery.exactRecordLookup.recordId, entity.recordId);
assert.equal(contextualQuery.exactRecordLookup.knowledgeBaseId, 'published-kb');
assert.deepEqual(contextualQuery.exactRecordLookup.requestedFacts, ['published_value']);
assert.equal(contextualQuery.previousTurnContextUsed, true);
assert.ok(contextualQuery.tenantSearchForms.includes('Published Alias'),
  'Search forms must come from the tenant publication');
const followUpTurns = Object.freeze([
  Object.freeze({ role: 'user', content: 'Earlier selection question.' }),
  Object.freeze({ role: 'assistant', content: 'Published response context.' }),
]);
const followUpInput = Object.freeze({
  ...scope,
  utterance: 'Please continue with that.',
  latestQuestion: 'Please continue with that.',
  usageDirection: 'inbound',
  requestedFacts: Object.freeze([]),
  contextualReferences: Object.freeze([]),
  recentRelevantTurns: followUpTurns,
  memory: normalTurn.memory,
  canonicalCallMemory: normalTurn.memory,
});
const noCurrentEntityResolution = Object.freeze({
  tenantId: scope.tenantId,
  candidate: null,
  candidateNamespace: null,
  namespaceCandidates: Object.freeze({}),
  routingCandidates: Object.freeze([]),
  alternatives: Object.freeze([]),
});
const followUpUnderstanding = understandContextualKnowledgeQuery(
  followUpInput, noCurrentEntityResolution,
);
assert.equal(followUpUnderstanding.contextDependent, true,
  'An entity-less turn must retain the validated canonical topic for grounded interpretation');
assert.equal(followUpUnderstanding.canonicalContext.recordId, entity.recordId);
const inferredFollowUpQuery = buildContextEnrichedRetrievalQuery({
  ...followUpInput, queryUnderstanding: followUpUnderstanding,
}, {}, { ...noCurrentEntityResolution, contextDependent: true }, [{
  knowledgeBaseId: 'published-kb', publicationRevision: 7,
}], recordScope);
assert.equal(inferredFollowUpQuery.reservedRecords[0].reason, 'canonical_memory');
assert.equal(inferredFollowUpQuery.reservedRecords[0].recordId, entity.recordId);
assert.match(inferredFollowUpQuery.semanticText, /Earlier selection question/u,
  'Contextual semantic retrieval must include relevant complete caller-agent turns');
assert.match(inferredFollowUpQuery.semanticText, /Published response context/u);

recordScope.set(alternative.recordId, Object.freeze({
  ...alternative, canonicalName: alternative.name,
  searchForms: Object.freeze(['Tenant Published Alternative']),
}));
const explicitAlternativeCandidate = Object.freeze({
  ...alternative,
  itemKey: alternative.key,
  label: alternative.name,
  score: 1,
  explicit: true,
  signals: Object.freeze([Object.freeze({
    explicit: true, phrase: 'Tenant Published Alternative', method: 'tenant_alias', score: 1,
  })]),
});
const explicitAlternativeResolution = Object.freeze({
  tenantId: scope.tenantId,
  candidate: explicitAlternativeCandidate,
  candidateNamespace: 'CATALOG',
  namespaceCandidates: Object.freeze({
    CATALOG: Object.freeze([explicitAlternativeCandidate]),
  }),
  routingCandidates: Object.freeze([explicitAlternativeCandidate]),
  alternatives: Object.freeze([]),
});
const explicitAlternativeUnderstanding = understandContextualKnowledgeQuery(Object.freeze({
  ...followUpInput,
  utterance: 'Tenant Published Alternative',
  latestQuestion: 'Tenant Published Alternative',
}), explicitAlternativeResolution);
assert.equal(explicitAlternativeUnderstanding.contextDependent, false,
  'A new explicit tenant-published entity must replace contextual retrieval');
const explicitAlternativeQuery = buildContextEnrichedRetrievalQuery({
  ...followUpInput,
  latestQuestion: 'Tenant Published Alternative',
  queryUnderstanding: explicitAlternativeUnderstanding,
}, {}, explicitAlternativeResolution, [{
  knowledgeBaseId: 'published-kb', publicationRevision: 7,
}], recordScope);
assert.deepEqual(explicitAlternativeQuery.reservedRecords.map((entry) => entry.recordId),
  [alternative.recordId], 'Explicit selection must reserve only the new published entity');
assert.doesNotMatch(
  explicitAlternativeQuery.semanticText,
  /Earlier selection question/u,
  'A new explicit entity must not carry stale contextual conversation into retrieval',
);
assert.equal(explicitAlternativeQuery.previousTurnContextUsed, false);
assert.equal(explicitAlternativeQuery.contextualText, null);
assert.equal(explicitAlternativeQuery.exactRecordLookup, null);
const knownOnlyQuery = buildContextEnrichedRetrievalQuery({
  tenantId: scope.tenantId, agentId: scope.agentId,
  latestQuestion: 'What is its published value?',
  canonicalCallMemory: { activeEntity: null, activeCategory: null, knownEntities: [alternative] },
  recentRelevantTurns: [],
  queryUnderstanding: { contextDependent: true, requestedFacts: ['published_value'] },
}, {}, { contextDependent: true }, [{ knowledgeBaseId: 'published-kb', publicationRevision: 7 }], recordScope);
assert.equal(knownOnlyQuery.reservedRecords.some((entry) => entry.reason === 'canonical_memory'), false,
  'A non-active known entity must never be promoted to canonical memory');

const contextualResolution = Object.freeze({
  ...explicitResolution, mode: 'CONTEXTUAL',
});
const contextualRecord = Object.freeze({
  ...hydratedSelected, reservationReasons: Object.freeze(['canonical_memory']),
});
assert.equal(confirmCanonicalTopicResolution(contextualResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_2'],
    stateUpdate: { knownEntities: [entity], contextDependent: true },
  },
  hydratedRecords: [contextualRecord, hydratedAlternative],
}).mode, 'UNRESOLVED', 'Contextual memory requires selection of the remembered source');
assert.equal(confirmCanonicalTopicResolution(contextualResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_1'],
    stateUpdate: { knownEntities: [entity] },
  },
  hydratedRecords: [contextualRecord],
}).mode, 'CONTEXTUAL');
const contextualSwitch = memory.applyCanonicalTopicResolution({
  ...contextualResolution, activeEntity: alternative,
}, { turnToken: 'candidate-noise' });
assert.equal(contextualSwitch.applied, false,
  'Contextual reuse must never replace the active PostgreSQL record');
assert.equal(contextualSwitch.reason, 'canonical_context_record_mismatch');
assert.equal(memory.snapshot().activeEntity.recordId, entity.recordId);
assert.equal(confirmCanonicalTopicResolution(explicitResolution, {
  decision: {
    valid: true, decision: 'answer', evidenceIds: ['source_1'],
    stateUpdate: { knownEntities: [entity] },
  },
  hydratedRecords: [{ ...hydratedSelected, publicationRevision: 8 }],
}).mode, 'UNRESOLVED', 'A wrong publication revision must not update canonical memory');

memory.close();
console.log(JSON.stringify({
  gate: 'canonical-memory-reservation', passed: true,
  candidateNoiseCommitted: false,
  explicitSelectionCommitted: true,
  contextualReservationVerified: true,
  publicationScopedIdentity: true,
  tenantPublishedSearchForms: true,
}, null, 2));
