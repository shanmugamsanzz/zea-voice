import assert from 'node:assert/strict';
import { buildContextEnrichedRetrievalQuery } from '../src/knowledge-engine/targeted-retrieval.js';
import { collectCanonicalRetrievalReservations } from '../src/knowledge-engine/canonical-retrieval-reservations.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';

const scope = Object.freeze({
  tenantId: 'category-tenant', agentId: 'category-agent', callId: 'category-call',
});
const knowledgeBaseId = 'category-kb';
const publicationRevision = 4;
const activeCategory = Object.freeze({
  recordId: 'category-anchor', recordType: 'CATALOG_CATEGORY',
  entityType: 'CATEGORY', key: 'published-category', categoryKey: 'published-category',
  name: 'Published Category', tenantId: scope.tenantId, agentId: scope.agentId,
  knowledgeBaseId, publicationRevision,
});
const child = (recordId, name, selectable = true, categoryKey = 'published-category') => (
  Object.freeze({
    tenantId: scope.tenantId, agentId: scope.agentId, recordId,
    recordType: 'CATALOG_ITEM', knowledgeBaseId, publicationRevision,
    itemKey: recordId, categoryKey, canonicalName: name,
    selectionRules: Object.freeze({ selectable }), displayOrder: 1,
    searchForms: Object.freeze([name]),
  })
);
const categoryRecord = Object.freeze({
  ...activeCategory, canonicalName: activeCategory.name,
  searchForms: Object.freeze([activeCategory.name]),
});
const queryInput = Object.freeze({
  ...scope, latestQuestion: 'What is its published value?', usageDirection: 'inbound',
  canonicalCallMemory: Object.freeze({ activeEntity: null, activeCategory }),
  memory: Object.freeze({ activeEntity: null, activeCategory }),
  queryUnderstanding: Object.freeze({
    contextDependent: true, requestedFact: 'published_value',
    requestedFacts: Object.freeze(['published_value']),
    explicitEntities: Object.freeze([]), explicitCategories: Object.freeze([]),
  }),
});
const publicationScope = Object.freeze([{ knowledgeBaseId, publicationRevision }]);

const uniqueChild = child('unique-child', 'Unique Published Child');
const ignoredChild = child('ignored-child', 'Non-selectable Child', false);
const uniqueQuery = buildContextEnrichedRetrievalQuery(
  queryInput, {}, { contextDependent: true }, publicationScope,
  new Map([
    [categoryRecord.recordId, categoryRecord], [uniqueChild.recordId, uniqueChild],
    [ignoredChild.recordId, ignoredChild],
  ]),
);
assert.equal(uniqueQuery.reservedRecords.find((entry) => (
  entry.reason === 'category_unique_child'
))?.recordId, uniqueChild.recordId,
'A category with one selectable published child must reserve that child');

const secondChild = child('second-child', 'Second Published Child');
const ambiguousQuery = buildContextEnrichedRetrievalQuery(
  queryInput, {}, { contextDependent: true }, publicationScope,
  new Map([
    [categoryRecord.recordId, categoryRecord], [uniqueChild.recordId, uniqueChild],
    [secondChild.recordId, secondChild],
  ]),
);
assert.equal(ambiguousQuery.reservedRecords.some((entry) => (
  entry.reason === 'category_unique_child'
)), false, 'Retrieval must not guess between multiple selectable category children');
const unrelatedRanked = Object.freeze({
  ...child('unrelated-ranked', 'Unrelated Ranked Item', true, 'other-category'),
  score: 1, explicit: false,
});
const guardedReservations = collectCanonicalRetrievalReservations({
  input: queryInput,
  classification: Object.freeze({
    intentClass: 'DIRECT_FACT', candidate: unrelatedRanked,
  }),
  resolution: Object.freeze({ contextDependent: true }),
});
assert.equal(guardedReservations.some((entry) => (
  entry.recordId === unrelatedRanked.recordId
)), false, 'An unrelated ranked item must not become mandatory category-follow-up evidence');

function hydratedSource({
  recordId, recordType, authoritativeData, publishedEvidenceId, reservationReasons = [],
}) {
  return Object.freeze({
    id: publishedEvidenceId, recordId, recordType,
    tenantId: scope.tenantId, agentId: scope.agentId, knowledgeBaseId,
    publicationRevision, documentId: 'category-document',
    documentVersionId: 'category-version', documentStatus: 'ready',
    documentVersionStatus: 'ready', documentVersionIsCurrent: true,
    hydrationValidated: true, publicationValidated: true, callerFacing: true,
    authoritativeData, reservationReasons: Object.freeze(reservationReasons),
    rank: 1, rrfScore: 1,
  });
}
const categorySource = hydratedSource({
  recordId: activeCategory.recordId, recordType: 'CATALOG_CATEGORY',
  publishedEvidenceId: 'published-category-evidence',
  reservationReasons: ['canonical_memory'],
  authoritativeData: Object.freeze({
    categoryKey: activeCategory.categoryKey, category: activeCategory.name,
    children: Object.freeze([
      Object.freeze({
        recordId: uniqueChild.recordId, itemKey: uniqueChild.itemKey,
        name: uniqueChild.canonicalName, selectionRules: Object.freeze({ selectable: true }),
      }),
      Object.freeze({
        recordId: secondChild.recordId, itemKey: secondChild.itemKey,
        name: secondChild.canonicalName, selectionRules: Object.freeze({ selectable: true }),
      }),
      Object.freeze({
        recordId: ignoredChild.recordId, itemKey: ignoredChild.itemKey,
        name: ignoredChild.canonicalName, selectionRules: Object.freeze({ selectable: false }),
      }),
    ]),
  }),
});
const unrelatedSource = hydratedSource({
  recordId: 'unrelated-item', recordType: 'CATALOG_ITEM',
  publishedEvidenceId: 'published-unrelated-evidence',
  authoritativeData: Object.freeze({
    itemKey: 'unrelated-item', name: 'Unrelated Published Item', categoryKey: 'other-category',
    selectionRules: Object.freeze({ selectable: true }),
  }),
});
const authoritative = Object.freeze({
  ...scope, evidence: Object.freeze([categorySource, unrelatedSource]),
  verifiedRecords: Object.freeze([categorySource, unrelatedSource]),
  reservations: Object.freeze([Object.freeze({
    ...activeCategory, reason: 'canonical_memory',
  })]),
});
const grounded = buildGroundedLlmInput({
  input: queryInput,
  classification: Object.freeze({ intentClass: 'DIRECT_FACT' }),
  resolution: Object.freeze({ routingCandidates: Object.freeze([]) }),
  authoritative,
  runtimeProfile: Object.freeze({ tools: Object.freeze([]), agent: Object.freeze({ settings: {} }) }),
});
assert.deepEqual(grounded.hydratedRecords.map((record) => record.recordId),
  [activeCategory.recordId],
  'An item outside the active category must not enter the grounded envelope');
assert.equal(grounded.clarificationContext.categorySelectionRequired, true);
assert.equal(grounded.clarificationContext.genuineAmbiguity, true);
assert.deepEqual(grounded.ambiguityCandidates.map((candidate) => candidate.recordId),
  [uniqueChild.recordId, secondChild.recordId],
  'CLARIFY candidates must contain only selectable children from the published category');

console.log(JSON.stringify({
  gate: 'category-item-handling', passed: true,
  uniqueChildReserved: true,
  multipleChildrenClarified: true,
  nonSelectableChildExcluded: true,
  unrelatedItemExcluded: true,
}, null, 2));
