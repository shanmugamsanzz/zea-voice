import assert from 'node:assert/strict';
import {
  confirmCanonicalTopicResolution,
} from '../src/knowledge-engine/canonical-topic-memory.js';
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

const confirmedExplicit = confirmCanonicalTopicResolution(explicitResolution, {
  decision: { valid: true, decision: 'answer', evidenceIds: ['source_1', 'source_2'] },
  hydratedRecords: [hydratedSelected, hydratedAlternative],
});
assert.equal(confirmedExplicit.mode, 'EXPLICIT');
assert.equal(confirmedExplicit.activeEntity.recordId, entity.recordId);
assert.equal(confirmCanonicalTopicResolution({
  ...explicitResolution,
  activeEntity: { ...entity, recordType: 'CATALOG_CATEGORY', entityType: 'CATEGORY' },
}, {
  decision: { valid: true, decision: 'answer', evidenceIds: ['source_1'] },
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
assert.ok(contextualQuery.tenantSearchForms.includes('Published Alias'),
  'Search forms must come from the tenant publication');

const contextualResolution = Object.freeze({
  ...explicitResolution, mode: 'CONTEXTUAL',
});
const contextualRecord = Object.freeze({
  ...hydratedSelected, reservationReasons: Object.freeze(['canonical_memory']),
});
assert.equal(confirmCanonicalTopicResolution(contextualResolution, {
  decision: { valid: true, decision: 'answer', evidenceIds: ['source_2'] },
  hydratedRecords: [contextualRecord, hydratedAlternative],
}).mode, 'UNRESOLVED', 'Contextual memory requires selection of the remembered source');
assert.equal(confirmCanonicalTopicResolution(contextualResolution, {
  decision: { valid: true, decision: 'answer', evidenceIds: ['source_1'] },
  hydratedRecords: [contextualRecord],
}).mode, 'CONTEXTUAL');
assert.equal(confirmCanonicalTopicResolution(explicitResolution, {
  decision: { valid: true, decision: 'answer', evidenceIds: ['source_1'] },
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
