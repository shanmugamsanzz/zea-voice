import assert from 'node:assert/strict';
import { resolveCanonicalTopicMemory } from '../src/knowledge-engine/canonical-topic-memory.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import {
  activeIsolatedCallMemoryCount,
  openIsolatedCallMemory,
} from '../src/knowledge-engine/call-memory.js';

const scope = Object.freeze({ tenantId: 'tenant-memory-a', agentId: 'agent-memory-a', callId: 'call-memory-a' });
const otherScope = Object.freeze({ ...scope, callId: 'call-memory-b' });

function source(recordId, itemKey, name, categoryKey = 'group-a', category = 'Group A') {
  return Object.freeze({
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    knowledgeBaseId: 'knowledge-memory-a',
    publicationRevision: 7,
    recordId,
    recordType: 'CATALOG_ITEM',
    hydrationValidated: true,
    publicationValidated: true,
    authoritativeData: Object.freeze({ itemKey, name, categoryKey, category }),
  });
}

const first = source('record-a', 'option-a', 'Option A');
const second = source('record-b', 'option-b', 'Option B');
const category = Object.freeze({
  tenantId: scope.tenantId,
  agentId: scope.agentId,
  knowledgeBaseId: 'knowledge-memory-a',
  publicationRevision: 7,
  recordId: 'category-a',
  recordType: 'CATALOG_CATEGORY',
  hydrationValidated: true,
  publicationValidated: true,
  authoritativeData: Object.freeze({ categoryKey: 'group-a', category: 'Group A' }),
});
const evidence = Object.freeze([first, second, category]);
const memory = openIsolatedCallMemory(scope);
memory.beginTurn('turn-a');
memory.setPendingQuestion({
  key: 'pending-choice', text: 'Which published option?', kind: 'ambiguity',
});
memory.setActiveToolRequest({
  name: 'configured_action', status: 'collecting_information',
  selectedEntityKey: 'option-b',
});

let resolution = resolveCanonicalTopicMemory({
  scope,
  understanding: { explicitEntities: [{ recordId: first.recordId }] },
  evidence,
  memory: {
    activeEntity: { id: second.recordId, key: 'option-b', name: 'Option B' },
  },
});
assert.equal(resolution.mode, 'EXPLICIT');
assert.equal(resolution.activeEntity.recordId, first.recordId);
let applied = memory.applyCanonicalTopicResolution(resolution, { turnToken: 'turn-a' });
assert.equal(applied.state.activeEntity.id, first.recordId,
  'Latest explicit hydrated entity must replace stale topic memory');
assert.deepEqual({
  tenantId: applied.state.activeEntity.tenantId,
  knowledgeBaseId: applied.state.activeEntity.knowledgeBaseId,
  publicationRevision: applied.state.activeEntity.publicationRevision,
  recordType: applied.state.activeEntity.recordType,
  recordId: applied.state.activeEntity.recordId,
  itemKey: applied.state.activeEntity.itemKey,
  categoryKey: applied.state.activeEntity.categoryKey,
  canonicalName: applied.state.activeEntity.canonicalName,
}, {
  tenantId: scope.tenantId,
  knowledgeBaseId: 'knowledge-memory-a',
  publicationRevision: 7,
  recordType: 'CATALOG_ITEM',
  recordId: first.recordId,
  itemKey: 'option-a',
  categoryKey: 'group-a',
  canonicalName: 'Option A',
}, 'Active memory must retain the complete immutable publication identity');
assert.equal(applied.state.activeCategory, null,
  'An item record must never be persisted again as a fabricated category record');
const engineInput = createKnowledgeEngineInput({
  ...scope, utterance: 'What is its price?', memory: applied.state,
});
assert.equal(engineInput.canonicalCallMemory.activeEntity.recordId, first.recordId);
assert.equal(engineInput.canonicalCallMemory.activeEntity.knowledgeBaseId, 'knowledge-memory-a');
assert.equal(engineInput.canonicalCallMemory.activeEntity.publicationRevision, 7,
  'The complete canonical identity must survive delivery to the retrieval engine');
assert.equal(applied.state.pendingClarification.text, 'Which published option?',
  'Canonical topic enforcement must not erase validated pending clarification state');
assert.equal(applied.state.activeTool.name, 'configured_action',
  'Canonical topic enforcement must not independently erase active tool state');

const ambiguous = resolveCanonicalTopicMemory({
  scope,
  understanding: {
    explicitEntities: [{ recordId: first.recordId }, { recordId: second.recordId }],
    ambiguity: { detected: true },
  },
  evidence,
  memory: memory.snapshot(),
});
assert.equal(ambiguous.mode, 'UNRESOLVED');
assert.equal(ambiguous.requiresTargetedClarification, true);
assert.equal(memory.applyCanonicalTopicResolution(ambiguous, { turnToken: 'turn-a' }).applied, false);
assert.equal(memory.snapshot().activeEntity.id, first.recordId,
  'Ambiguous catalog candidates must not replace the selected item');

memory.beginTurn('turn-b');
resolution = resolveCanonicalTopicMemory({
  scope,
  understanding: { contextDependent: true },
  evidence: [first],
  memory: memory.snapshot(),
});
assert.equal(resolution.mode, 'CONTEXTUAL');
assert.equal(resolution.activeEntity.recordId, first.recordId);
applied = memory.applyCanonicalTopicResolution(resolution, { turnToken: 'turn-b' });
assert.equal(applied.state.activeEntity.id, first.recordId,
  'Contextual reference must reuse the active canonical PostgreSQL record');

memory.beginTurn('turn-category');
resolution = resolveCanonicalTopicMemory({
  scope,
  understanding: { explicitCategories: [{ recordId: category.recordId }] },
  evidence,
  memory: memory.snapshot(),
});
assert.equal(resolution.mode, 'EXPLICIT');
assert.equal(resolution.activeEntity, null);
assert.equal(resolution.activeCategory.recordId, category.recordId);
applied = memory.applyCanonicalTopicResolution(resolution, { turnToken: 'turn-category' });
assert.equal(applied.state.activeEntity, null);
assert.equal(applied.state.activeCategory.id, category.recordId,
  'Categories must be stored separately from selectable catalog items');
assert.equal(applied.state.activeCategory.categoryKey, 'group-a');
assert.equal(applied.state.activeCategory.canonicalName, 'Group A');

memory.beginTurn('turn-incomplete');
const incompleteApplied = memory.applyCanonicalTopicResolution({
  version: 4,
  scope,
  mode: 'EXPLICIT',
  activeEntity: {
    recordType: 'CATALOG_ITEM', recordId: 'text-only-record',
    itemKey: 'text-only', canonicalName: 'Text Only',
  },
  activeCategory: null,
  comparisonEntities: [],
}, { turnToken: 'turn-incomplete' });
assert.equal(incompleteApplied.applied, false,
  'A topic without tenant, knowledge base and publication revision must never enter memory');
assert.equal(incompleteApplied.state.activeCategory.recordId, category.recordId,
  'Rejecting incomplete memory must preserve the last verified canonical record');

memory.beginTurn('turn-c');
resolution = resolveCanonicalTopicMemory({
  scope,
  understanding: {
    explicitEntities: [{ recordId: first.recordId }, { recordId: second.recordId }],
    comparisonEntities: [{ recordId: first.recordId }, { recordId: second.recordId }],
  },
  evidence,
  memory: memory.snapshot(),
});
assert.equal(resolution.mode, 'COMPARISON');
applied = memory.applyCanonicalTopicResolution(resolution, { turnToken: 'turn-c' });
assert.equal(applied.state.activeEntity, null);
assert.deepEqual(new Set(applied.state.comparisonEntities.map((entity) => entity.id)),
  new Set([first.recordId, second.recordId]));
assert.equal(applied.state.activeTool, null,
  'Changing the canonical record must clear a tool bound to the previous selection');
assert.equal(applied.state.pendingClarification.text, 'Which published option?');

const unresolved = resolveCanonicalTopicMemory({
  scope,
  understanding: { contextualReferences: ['caller_context_reference'] },
  evidence: [],
  memory: {},
});
assert.equal(unresolved.mode, 'UNRESOLVED');
assert.equal(unresolved.requiresTargetedClarification, true);

const unhydrated = resolveCanonicalTopicMemory({
  scope,
  understanding: { explicitEntities: [{ recordId: 'foreign-record' }] },
  evidence: [{
    recordId: 'foreign-record', recordType: 'CATALOG_ITEM',
    hydrationValidated: false, publicationValidated: true,
    authoritativeData: { itemKey: 'foreign', name: 'Foreign' },
  }],
  memory: {},
});
assert.equal(unhydrated.mode, 'UNRESOLVED',
  'Unhydrated or unvalidated IDs must never enter canonical memory');

assert.throws(() => memory.applyCanonicalTopicResolution({
  ...resolution, scope: otherScope,
}, { turnToken: 'turn-c' }), /scope mismatch/u);

const otherCall = openIsolatedCallMemory(otherScope);
assert.equal(otherCall.snapshot().activeEntity, null);
assert.deepEqual(otherCall.snapshot().comparisonEntities, []);
assert.equal(activeIsolatedCallMemoryCount(), 2);
otherCall.close();
memory.close();
assert.equal(activeIsolatedCallMemoryCount(), 0);

console.log('Canonical tenant/agent/call topic memory resolution verified.');

