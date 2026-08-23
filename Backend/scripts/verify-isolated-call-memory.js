import assert from 'node:assert/strict';
import {
  KNOWLEDGE_CALL_MEMORY_VERSION,
  activeIsolatedCallMemoryCount,
  compactIsolatedCallMemory,
  knowledgeCallMemoryKey,
  openIsolatedCallMemory,
} from '../src/knowledge-engine/call-memory.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';

const identity = { tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a' };
assert.equal(KNOWLEDGE_CALL_MEMORY_VERSION, 1);
assert.notEqual(
  knowledgeCallMemoryKey(identity),
  knowledgeCallMemoryKey({ ...identity, callId: 'call-b' }),
);
assert.notEqual(
  knowledgeCallMemoryKey(identity),
  knowledgeCallMemoryKey({ ...identity, tenantId: 'tenant-b' }),
);
assert.notEqual(
  knowledgeCallMemoryKey(identity),
  knowledgeCallMemoryKey({ ...identity, agentId: 'agent-b' }),
);
assert.equal(
  knowledgeCallMemoryKey({ ...identity, workspaceId: 'workspace-a' }),
  knowledgeCallMemoryKey({ ...identity, workspaceId: 'workspace-b' }),
  'Workspace must not replace the required tenant/agent/call isolation key',
);

const settings = {
  conversationContextTurns: 3,
  conversationMemoryFields: [
    { key: 'requested_date', label: 'Date', type: 'text', required: true, question: 'Which date?' },
  ],
};
const memory = openIsolatedCallMemory(identity, settings);
memory.append({ role: 'user', content: 'Tell me about option one.' });
memory.applyEngineDecision({
  type: 'DIRECT',
  reason: 'catalog_detail',
  evidenceIds: ['source-one'],
}, {
  explicitEntity: true,
  entity: {
    id: 'record-one', key: 'option-one', name: 'Option One',
    category: 'Options', categoryKey: 'options',
  },
  citedEvidence: [{ id: 'source-one', recordId: 'record-one', recordType: 'CATALOG_ITEM' }],
});
let snapshot = memory.snapshot();
assert.equal(snapshot.activeEntity.key, 'option-one');
assert.equal(snapshot.activeCategory.key, 'options');
assert.equal(snapshot.latestIntent, 'catalog_detail');
assert.deepEqual(snapshot.citedEvidence, [{
  id: 'source-one', recordId: 'record-one', recordType: 'CATALOG_ITEM',
}]);

memory.applyEngineDecision({
  type: 'CLARIFY',
  reason: 'ambiguous_choice',
  evidenceIds: ['source-one'],
  clarification: { kind: 'ambiguity', prompt: 'Which option did you mean?' },
});
snapshot = memory.snapshot();
assert.equal(snapshot.pendingClarification.text, 'Which option did you mean?');

// A resolved category is first-class state. It replaces a stale child item and
// clears the clarification that belonged to the previous topic.
memory.applyEngineDecision({
  type: 'DIRECT',
  reason: 'approved_authoritative_category_response',
  evidenceIds: ['source-category'],
  response: { recordType: 'CATALOG_CATEGORY' },
}, {
  explicitCategory: true,
  entity: null,
  category: { key: 'organ-specific', name: 'Organ-Specific Options' },
  citedEvidence: [{ id: 'source-category', recordId: 'record-category', recordType: 'CATALOG_ITEM' }],
});
snapshot = memory.snapshot();
assert.equal(snapshot.activeEntity, null);
assert.equal(snapshot.activeCategory.key, 'organ-specific');
assert.equal(snapshot.pendingClarification, null);

memory.setActiveToolRequest({
  name: 'create_reservation',
  status: 'collecting_information',
  selectedEntityKey: 'option-one',
});
memory.mergeCollectedData({ requested_date: 'tomorrow' });
snapshot = memory.snapshot();
assert.equal(snapshot.activeTool.name, 'create_reservation');
assert.deepEqual(snapshot.collectedToolFields, { requested_date: 'tomorrow' });

// A new explicit entity is authoritative. It replaces stale entity/category
// memory and invalidates clarification and tool state tied to the old entity.
memory.applyEngineDecision({
  type: 'DIRECT',
  reason: 'catalog_detail',
  evidenceIds: ['source-two'],
}, {
  explicitEntity: true,
  entity: {
    id: 'record-two', key: 'option-two', name: 'Option Two',
    category: 'Other Options', categoryKey: 'other-options',
  },
  citedEvidence: [{ id: 'source-two', recordId: 'record-two', recordType: 'CATALOG_ITEM' }],
});
snapshot = memory.snapshot();
assert.equal(snapshot.activeEntity.key, 'option-two');
assert.equal(snapshot.activeCategory.key, 'other-options');
assert.equal(snapshot.pendingClarification, null);
assert.equal(snapshot.activeTool, null);
assert.deepEqual(snapshot.collectedToolFields, {});
assert.deepEqual(snapshot.citedEvidence.map((source) => source.id), ['source-two']);

for (let index = 0; index < 8; index += 1) {
  memory.append({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` });
}
snapshot = memory.snapshot();
assert.ok(snapshot.recentTurns.length <= 6, 'Only the configured compact recent turns may remain');
const compact = compactIsolatedCallMemory(snapshot, 900);
assert.equal(compact.activeEntity.key, 'option-two');
assert.deepEqual(compact.citedEvidence.map((source) => source.id), ['source-two']);

const engineInput = createKnowledgeEngineInput({
  ...identity,
  utterance: 'What about this one?',
  memory: snapshot,
});
assert.equal(engineInput.memory.activeEntity.key, 'option-two');
assert.equal(engineInput.memory.activeCategory.key, 'other-options');
assert.equal(engineInput.memory.latestIntent, 'catalog_detail');
assert.deepEqual(engineInput.memory.collectedToolFields, {});
assert.deepEqual(engineInput.memory.citedEvidence.map((source) => source.id), ['source-two']);

const otherCall = openIsolatedCallMemory({ ...identity, callId: 'call-b' }, settings, snapshot);
assert.equal(otherCall.snapshot().activeEntity, null, 'A different call must not restore mutable state');

// Decisions without a selected entity are valid. DIRECT/LLM commonly answer
// FAQ or general evidence, TOOL can collect fields before an entity exists,
// and CLARIFY intentionally has no resolved entity.
for (const type of ['DIRECT', 'LLM', 'TOOL', 'CLARIFY']) {
  assert.doesNotThrow(() => otherCall.applyEngineDecision({
    type,
    reason: `${type.toLocaleLowerCase()}_without_entity`,
    evidenceIds: [],
    ...(type === 'TOOL' ? { tool: { name: 'configured_action' } } : {}),
    ...(type === 'CLARIFY' ? {
      clarification: { kind: 'ambiguity', prompt: 'Which option did you mean?' },
    } : {}),
  }, { entity: null, category: null }));
  assert.equal(otherCall.snapshot().activeEntity, null);
}
assert.equal(activeIsolatedCallMemoryCount(), 2);
otherCall.close();
memory.close();
assert.equal(activeIsolatedCallMemoryCount(), 0);

console.log('Tenant/agent/call-isolated knowledge memory verified.');
