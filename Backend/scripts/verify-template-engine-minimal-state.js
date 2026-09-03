import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyMinimalTemplateEngineStateUpdate,
  createMinimalTemplateEngineState,
  templateEngineStateKeys,
} from '../src/voice/interaction/template-engine-state.js';

const history = [];
for (let index = 1; index <= 6; index += 1) {
  history.push({ role: 'user', content: `request ${index}` });
  history.push({ role: 'assistant', content: `response ${index}` });
}
history.push({ role: 'user', content: 'unfinished request' });

const state = createMinimalTemplateEngineState({
  conversationHistory: history,
  lastReferencedRecordIds: [{ recordId: 'record-a', canonicalName: 'ignored text' }],
  comparisonRecordIds: ['record-b', 'record-c'],
  pendingClarification: { question: 'Which one?', candidateRecordIds: ['record-b', 'record-c'] },
  activeWorkflowId: 'workflow-a',
  collectedToolFields: { field_a: 'value' },
  confirmationStatus: 'pending_fields',
  currentTopic: 'must not be stored',
  knownEntities: ['must not be stored'],
});
assert.deepEqual(Object.keys(state), templateEngineStateKeys);
assert.equal(state.recentCompleteTurns.length, 10);
assert.equal(state.recentCompleteTurns.some((turn) => turn.content.includes('unfinished')), false);
assert.deepEqual(state.lastReferencedRecordIds, ['record-a']);
assert.deepEqual(state.comparisonRecordIds, ['record-b', 'record-c']);
assert.equal(Object.hasOwn(state, 'currentTopic'), false);
assert.equal(Object.hasOwn(state, 'knownEntities'), false);

const updated = applyMinimalTemplateEngineStateUpdate(state, {
  set: {
    lastReferencedRecordIds: ['record-d'],
    collectedToolFields: { field_a: 'corrected value', field_b: 2 },
    confirmationStatus: 'awaiting_confirmation',
  },
  clear: ['pendingClarification', 'comparisonRecordIds'],
});
assert.deepEqual(updated.lastReferencedRecordIds, ['record-d']);
assert.deepEqual(updated.comparisonRecordIds, []);
assert.equal(updated.pendingClarification, null);
assert.equal(updated.confirmationStatus, 'awaiting_confirmation');
assert.throws(() => applyMinimalTemplateEngineStateUpdate(state, {
  set: { currentTopic: 'not permitted' }, clear: [],
}), /unsupported field/u);
assert.throws(() => applyMinimalTemplateEngineStateUpdate(state, {
  set: { recentCompleteTurns: [] }, clear: [],
}), /unsupported field/u);

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-state.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false, `Minimal state contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine minimal state verification passed.');

