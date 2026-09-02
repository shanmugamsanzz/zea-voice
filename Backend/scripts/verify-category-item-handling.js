import assert from 'node:assert/strict';
import { buildContextEnrichedRetrievalQuery } from '../src/knowledge-engine/targeted-retrieval.js';
import { collectCanonicalRetrievalReservations } from '../src/knowledge-engine/canonical-retrieval-reservations.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';
import { resolveCanonicalTopicMemory } from '../src/knowledge-engine/canonical-topic-memory.js';
import { openIsolatedCallMemory } from '../src/knowledge-engine/call-memory.js';

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

const explicitCategoryInput = Object.freeze({
  ...queryInput,
  canonicalCallMemory: Object.freeze({ activeEntity: null, activeCategory: null }),
  memory: Object.freeze({ activeEntity: null, activeCategory: null }),
  queryUnderstanding: Object.freeze({
    contextDependent: false,
    explicitEntities: Object.freeze([]),
    explicitCategories: Object.freeze([activeCategory]),
    requestedFacts: Object.freeze([]),
  }),
});
const explicitUniqueQuery = buildContextEnrichedRetrievalQuery(
  explicitCategoryInput, {}, {}, publicationScope,
  new Map([
    [categoryRecord.recordId, categoryRecord], [uniqueChild.recordId, uniqueChild],
  ]),
);
assert.equal(explicitUniqueQuery.reservedRecords.find((entry) => (
  entry.reason === 'category_unique_child'
))?.recordId, uniqueChild.recordId,
'A newly selected category must hydrate its unique selectable child before memory commitment');

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

const uniqueCategorySource = hydratedSource({
  recordId: activeCategory.recordId, recordType: 'CATALOG_CATEGORY',
  publishedEvidenceId: 'published-unique-category-evidence',
  reservationReasons: ['explicit_entity'],
  authoritativeData: Object.freeze({
    categoryKey: activeCategory.categoryKey, category: activeCategory.name,
    children: Object.freeze([Object.freeze({
      recordId: uniqueChild.recordId, itemKey: uniqueChild.itemKey,
      name: uniqueChild.canonicalName, selectionRules: Object.freeze({ selectable: true }),
    })]),
  }),
});
const uniqueChildSource = hydratedSource({
  recordId: uniqueChild.recordId, recordType: 'CATALOG_ITEM',
  publishedEvidenceId: 'published-unique-child-evidence',
  reservationReasons: ['category_unique_child'],
  authoritativeData: Object.freeze({
    itemKey: uniqueChild.itemKey, name: uniqueChild.canonicalName,
    categoryKey: activeCategory.categoryKey, category: activeCategory.name,
    selectionRules: Object.freeze({ selectable: true }),
  }),
});
const uniqueResolution = resolveCanonicalTopicMemory({
  scope,
  understanding: explicitCategoryInput.queryUnderstanding,
  evidence: [uniqueCategorySource, uniqueChildSource],
  memory: {},
});
assert.equal(uniqueResolution.mode, 'EXPLICIT');
assert.equal(uniqueResolution.activeCategory, null);
assert.equal(uniqueResolution.activeEntity.recordId, uniqueChild.recordId,
  'A one-child category must resolve to the exact hydrated PostgreSQL item');

const memory = openIsolatedCallMemory(scope);
memory.beginTurn('unique-category-turn');
let committed = memory.applyCanonicalTopicResolution(uniqueResolution, {
  turnToken: 'unique-category-turn',
});
assert.equal(committed.applied, true);
assert.equal(committed.state.activeEntity.recordId, uniqueChild.recordId);
assert.equal(committed.state.activeEntity.canonicalName, uniqueChild.canonicalName);
assert.equal(committed.state.activeCategory, null);

const multiResolution = resolveCanonicalTopicMemory({
  scope,
  understanding: explicitCategoryInput.queryUnderstanding,
  evidence: [categorySource, uniqueChildSource, hydratedSource({
    recordId: secondChild.recordId, recordType: 'CATALOG_ITEM',
    publishedEvidenceId: 'published-second-child-evidence',
    authoritativeData: Object.freeze({
      itemKey: secondChild.itemKey, name: secondChild.canonicalName,
      categoryKey: activeCategory.categoryKey, category: activeCategory.name,
      selectionRules: Object.freeze({ selectable: true }),
    }),
  })],
  memory: committed.state,
});
assert.equal(multiResolution.requiresTargetedClarification, true);
assert.equal(multiResolution.activeEntity, null);
assert.equal(multiResolution.activeCategory.recordId, activeCategory.recordId);
assert.deepEqual(multiResolution.categoryCandidates.map((entry) => entry.recordId),
  [uniqueChild.recordId, secondChild.recordId]);

const multiChildSource = hydratedSource({
  recordId: secondChild.recordId, recordType: 'CATALOG_ITEM',
  publishedEvidenceId: 'published-multi-second-evidence',
  authoritativeData: Object.freeze({
    itemKey: secondChild.itemKey, name: secondChild.canonicalName,
    categoryKey: activeCategory.categoryKey, category: activeCategory.name,
    selectionRules: Object.freeze({ selectable: true }),
  }),
});
const explicitMultiGrounded = buildGroundedLlmInput({
  input: explicitCategoryInput,
  classification: Object.freeze({ intentClass: 'DIRECT_FACT' }),
  resolution: Object.freeze({ routingCandidates: Object.freeze([]) }),
  authoritative: Object.freeze({
    ...scope,
    evidence: Object.freeze([categorySource, uniqueChildSource, multiChildSource]),
    verifiedRecords: Object.freeze([categorySource, uniqueChildSource, multiChildSource]),
    reservations: Object.freeze([Object.freeze({
      ...activeCategory, reason: 'explicit_entity',
    })]),
  }),
  runtimeProfile: Object.freeze({ tools: Object.freeze([]), agent: Object.freeze({ settings: {} }) }),
});
assert.equal(explicitMultiGrounded.clarificationContext.categorySelectionRequired, true);
assert.deepEqual(explicitMultiGrounded.ambiguityCandidates.map((entry) => entry.recordId),
  [uniqueChild.recordId, secondChild.recordId],
  'A newly selected multi-child category must expose only published children for CLARIFY');

const phoneticAmbiguity = resolveCanonicalTopicMemory({
  scope,
  understanding: {
    explicitEntities: [
      { recordId: uniqueChild.recordId }, { recordId: secondChild.recordId },
    ],
    ambiguity: { detected: true, kind: 'phonetic' },
  },
  evidence: [uniqueChildSource, hydratedSource({
    recordId: secondChild.recordId, recordType: 'CATALOG_ITEM',
    publishedEvidenceId: 'published-phonetic-second-evidence',
    authoritativeData: Object.freeze({
      itemKey: secondChild.itemKey, name: secondChild.canonicalName,
      categoryKey: activeCategory.categoryKey, category: activeCategory.name,
      selectionRules: Object.freeze({ selectable: true }),
    }),
  })],
  memory: committed.state,
});
assert.equal(phoneticAmbiguity.mode, 'UNRESOLVED');
assert.equal(phoneticAmbiguity.requiresTargetedClarification, true);
assert.equal(memory.snapshot().activeEntity.recordId, uniqueChild.recordId,
  'A phonetic ambiguity must never replace the last confirmed canonical item');

const secondChildSource = hydratedSource({
  recordId: secondChild.recordId, recordType: 'CATALOG_ITEM',
  publishedEvidenceId: 'published-explicit-second-evidence',
  authoritativeData: Object.freeze({
    itemKey: secondChild.itemKey, name: secondChild.canonicalName,
    categoryKey: activeCategory.categoryKey, category: activeCategory.name,
    selectionRules: Object.freeze({ selectable: true }),
  }),
});
const switchedResolution = resolveCanonicalTopicMemory({
  scope,
  understanding: {
    explicitEntities: [{ recordId: secondChild.recordId }],
    explicitCategories: [],
  },
  evidence: [secondChildSource],
  memory: memory.snapshot(),
});
memory.beginTurn('explicit-item-switch');
committed = memory.applyCanonicalTopicResolution(switchedResolution, {
  turnToken: 'explicit-item-switch',
});
assert.equal(committed.applied, true);
assert.equal(committed.state.activeEntity.recordId, secondChild.recordId,
  'An explicit verified item must replace the previous canonical item');
memory.close();
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
  explicitUniqueCategoryPromoted: true,
  phoneticAmbiguityNeverGuessed: true,
  nonSelectableChildExcluded: true,
  unrelatedItemExcluded: true,
}, null, 2));
