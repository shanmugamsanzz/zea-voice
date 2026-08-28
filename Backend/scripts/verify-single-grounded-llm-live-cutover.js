import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  groundedDecisionJsonSchema,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';

const orchestrator = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url),
  'utf8',
);
const runTurnStart = orchestrator.indexOf('async #runTurn(');
const runTurnEnd = orchestrator.indexOf('async #synthesizeWelcome(', runTurnStart);
assert.ok(runTurnStart >= 0 && runTurnEnd > runTurnStart, 'live turn implementation must exist');
const runTurn = orchestrator.slice(runTurnStart, runTurnEnd);

assert.equal((runTurn.match(/this\.#llm\(/gu) ?? []).length, 1,
  'each normal live turn must contain exactly one grounded LLM invocation');
assert.doesNotMatch(runTurn, /engineDecision\.type\s*===\s*knowledgeEngineDecisionTypes\.(?:TOOL|CLARIFY)/u,
  'normal TOOL and CLARIFY decisions must not execute before the grounded LLM');
assert.match(runTurn,
  /intentClass\s*\n\s*=== deterministicProtocolExceptionTypes\.SAFETY_EMERGENCY/u,
  'only a safety emergency may use deterministic response speech');
assert.doesNotMatch(runTurn, /deterministicPriority[^;]+CALL_CONTROL/su,
  'generic call-control routing must not bypass the normal-turn LLM');
assert.match(orchestrator, /classifyFinalCallEndUtterance\(/u,
  'configured explicit hang-up must remain a deterministic protocol exception');
assert.match(orchestrator, /caller_requested_hangup/u,
  'explicit hang-up must close the call without invoking the normal-turn LLM');
assert.match(runTurn, /validatedNormalTurn\s*=\s*Boolean\(response\?\.normalTurnOutput\)/u,
  'the live turn must recognize only validated unified LLM output');
assert.doesNotMatch(runTurn, /applyResolvedContext/u,
  'retrieval must not commit canonical memory before grounded validation');
assert.match(runTurn, /finalizeConfiguredToolResults\(/u,
  'tool success speech must follow verified result validation');
assert.match(runTurn, /#scheduleLiveMemoryCheckpoint\('validated_normal_turn'\)/u,
  'validated memory persistence must be scheduled asynchronously');
assert.match(runTurn, /sentencePipeline\.enqueue\(finalAnswer\)/u,
  'validated speech must enter the streaming sentence/TTS pipeline');
assert.match(runTurn, /response\.cancelled\s*\|\|\s*epoch\s*!==\s*this\.epoch/u,
  'obsolete interrupted output must be rejected by turn epoch');

const envelope = Object.freeze({
  found: true,
  sources: Object.freeze([Object.freeze({
    id: 'source_1', recordId: 'record_1', content: 'The approved service costs 25 credits.',
  })]),
  entities: Object.freeze([]),
});
const schema = groundedDecisionJsonSchema(envelope, { fieldSchemas: [], toolSchemas: [] });
assert.deepEqual(schema.properties.decision.enum.sort(), ['CLARIFY', 'RESPONSE', 'TOOL']);
const validated = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE',
  answer: 'The approved service costs 25 credits.',
  responseId: null,
  evidenceIds: ['source_1'],
  stateUpdate: {},
  pendingQuestion: null,
  toolRequest: null,
  clarification: null,
}), envelope, { fieldSchemas: [], toolSchemas: [] });
assert.equal(validated.valid, true);
assert.equal(validated.decision, 'answer', 'external RESPONSE must normalize for internal validation');

console.log(JSON.stringify({
  passed: true,
  exactlyOneNormalTurnLlm: true,
  outputs: schema.properties.decision.enum,
  verifiedToolGate: true,
  asynchronousMemoryCheckpoint: true,
  streamingTtsPipeline: true,
}, null, 2));
