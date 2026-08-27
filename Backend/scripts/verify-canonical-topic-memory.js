import assert from 'node:assert/strict';
import { resolveCanonicalTopicMemory } from '../src/knowledge-engine/canonical-topic-memory.js';
import {
  activeIsolatedCallMemoryCount,
  openIsolatedCallMemory,
} from '../src/knowledge-engine/call-memory.js';

const scope = Object.freeze({ tenantId: 'tenant-memory-a', agentId: 'agent-memory-a', callId: 'call-memory-a' });
const otherScope = Object.freeze({ ...scope, callId: 'call-memory-b' });

function source(recordId, itemKey, name, categoryKey = 'group-a', category = 'Group A') {
  return Object.freeze({
    recordId,
    recordType: 'CATALOG_ITEM',
    hydrationValidated: true,
    publicationValidated: true,
    authoritativeData: Object.freeze({ itemKey, name, categoryKey, category }),
  });
}

const first = source('record-a', 'option-a', 'Option A');
const second = source('record-b', 'option-b', 'Option B');
const evidence = Object.freeze([first, second]);
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
assert.equal(applied.state.pendingClarification.text, 'Which published option?',
  'Canonical topic enforcement must not erase validated pending clarification state');
assert.equal(applied.state.activeTool.name, 'configured_action',
  'Canonical topic enforcement must not independently erase active tool state');

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
assert.equal(applied.state.activeTool.name, 'configured_action');
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

