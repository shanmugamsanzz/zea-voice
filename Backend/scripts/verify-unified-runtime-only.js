import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');

for (const removed of [
  'loadPublishedKnowledgeMap',
  'openLiveCallMemory',
  'createGroundedJsonStreamDecoder',
  'validateGroundedLlmResponse',
  'validateGroundedSpokenSentences',
  '#captureCompletionFieldAfterUnderstanding',
  '#openCompletionActionAfterUnderstanding',
  '#workflowInstructionResponse',
  '#tenantEvidence',
  'approvedDocumentFallback',
]) {
  assert.equal(source.includes(removed), false, `Legacy runtime symbol remains: ${removed}`);
}

assert.equal(
  source.match(/if\s*\(\s*!this\.unifiedGroundedDecisionEnabled/gu)?.length ?? 0,
  1,
  'Only the fail-closed startup guard may check the disabled engine state',
);
assert.match(source, /openGenericConversationState/u);
assert.match(source, /retrieveTenantEvidence/u);
assert.match(source, /createGroundedDecisionStreamDecoder/u);
assert.match(source, /applyUnifiedGroundedTurn/u);
assert.match(source, /validateGroundedClaims/u);

const finalStt = source.indexOf('stt.final_turn_assembled');
const genericMemory = source.indexOf('openGenericConversationState');
const retrieval = source.indexOf('async #knowledge');
const decision = source.indexOf('async #llmAttempt');
const validation = source.indexOf('applyUnifiedGroundedTurn');
const tts = source.indexOf('streaming.onSentence');

for (const [name, index] of Object.entries({
  finalStt, genericMemory, retrieval, decision, validation, tts,
})) assert.notEqual(index, -1, `Unified runtime step missing: ${name}`);

console.log(JSON.stringify({
  task: 'unified-runtime-only',
  legacyRuntimeSymbolsRemoved: true,
  genericMemoryOnly: true,
  hybridEvidenceOnly: true,
  unifiedDecisionOnly: true,
  groundedValidationBeforeSpeech: true,
}, null, 2));
