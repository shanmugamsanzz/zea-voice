import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  configuredOperationalFailureResponse,
  configuredInformationUnavailableResponse,
  configuredTechnicalFailureResponse,
  llmOperationalFailureClass,
} from '../src/voice/realtime-conversation-orchestrator.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';

const tenants = [
  { technicalFailureMessage: 'Configured technical response alpha.' },
  { knowledgeTechnicalFailureMessage: 'Configured technical response beta.' },
  { errorRecoveryMessage: 'Configured technical response gamma.' },
];
for (const settings of tenants) {
  const profile = { agent: { settings } };
  assert.ok(configuredTechnicalFailureResponse(profile));
  assert.equal(configuredOperationalFailureResponse(profile),
    configuredTechnicalFailureResponse(profile));
}

assert.equal(configuredInformationUnavailableResponse({
  agent: { settings: { informationUnavailableMessage: 'Configured unavailable response.' } },
}), 'Configured unavailable response.');
assert.equal(configuredInformationUnavailableResponse({
  agent: { settings: { clarificationRecoverySupportMessage: 'Clarification support only.' } },
}), '', 'clarification support must never substitute for unavailable information speech');

assert.equal(configuredOperationalFailureResponse({
  agent: { settings: {
    technicalFailureMessage: 'General technical response.',
    evidenceValidationFailureMessage: 'Validation technical response.',
  } },
}, {}, { validation: true }), 'Validation technical response.');
assert.equal(configuredTechnicalFailureResponse({
  agent: { settings: { knowledgeClarificationMessage: 'Clarification only.' } },
}), '', 'clarification speech must never substitute for an operational failure');

assert.equal(llmOperationalFailureClass({ code: 'LLM_REQUEST_TIMEOUT' }), 'timeout');
assert.equal(llmOperationalFailureClass({ code: 'LLM_STRUCTURED_OUTPUT_INVALID_JSON' }),
  'structured_output');
assert.equal(validateGroundedLlmDecision('{', {
  found: false, sources: [], entities: [],
}).reason, 'invalid_json');

const source = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
const knowledgeStart = source.indexOf('async #knowledge(');
const knowledgeEnd = source.indexOf('#preCallSource()', knowledgeStart);
const knowledge = source.slice(knowledgeStart, knowledgeEnd);
assert.match(knowledge, /route:\s*'operational_failure'/u);
assert.match(knowledge, /diagnostic:\s*\{[\s\S]*stage:\s*'knowledge_retrieval'/u,
  'retrieval and hydration exceptions must retain an operational diagnostic');

const runTurnStart = source.indexOf('async #runTurn(');
const groundedTurnStart = source.indexOf('async #runGroundedTurn(', runTurnStart);
const runTurn = source.slice(runTurnStart, groundedTurnStart);
assert.match(runTurn, /activeGroundedTurnEpochs\.add\(epoch\)/u);
assert.match(runTurn, /outcome\?\.playbackCompleted\s*===\s*true/u,
  'inactivity may arm only after successful final playback');
assert.match(runTurn, /activeGroundedTurnEpochs\.delete\(epoch\)/u);

const groundedTurnEnd = source.indexOf('async #synthesizeWelcome(', groundedTurnStart);
const groundedTurn = source.slice(groundedTurnStart, groundedTurnEnd);
const finalPlayback = groundedTurn.lastIndexOf('await this.controller.playbackComplete();');
const playbackResult = groundedTurn.lastIndexOf('playbackCompleted: true');
assert.ok(finalPlayback >= 0 && playbackResult > finalPlayback,
  'the grounded turn must report completion only after final TTS playback');
assert.doesNotMatch(groundedTurn.slice(finalPlayback, playbackResult), /#armInactivity\(\)/u,
  'the grounded turn wrapper—not TTS processing—must arm inactivity');
assert.match(groundedTurn, /configuredTechnicalFailureResponse/u,
  'operational failures must resolve through tenant-configured technical speech');
assert.match(groundedTurn, /VOICE_TECHNICAL_RESPONSE_UNCONFIGURED/u,
  'missing required technical speech must fail explicitly');
assert.match(source, /VOICE_INFORMATION_UNAVAILABLE_RESPONSE_UNCONFIGURED/u,
  'missing information-unavailable speech must become an operational failure');
assert.match(groundedTurn, /finalAnswerQueued[\s\S]*VOICE_FINAL_RESPONSE_NOT_QUEUED/u,
  'a finalized response that cannot enter TTS must become an operational failure');

const sentencePipelineStart = source.indexOf('#createSentenceTtsPipeline(');
const runTurnBoundary = source.indexOf('async #runTurn(', sentencePipelineStart);
const sentencePipeline = source.slice(sentencePipelineStart, runTurnBoundary);
assert.match(sentencePipeline,
  /firstFailure\s*&&\s*completedSentences\.length\s*===\s*0/u,
  'acknowledgement audio must not hide failure of every final response sentence');
assert.doesNotMatch(sentencePipeline,
  /firstFailure\s*&&\s*completedSentences\.length\s*===\s*0\s*&&\s*audibleSentences/u,
  'acknowledgement audibility must not count as successful final playback');
assert.match(source, /TTS_EMPTY_AUDIO_STREAM/u,
  'a completed TTS stream without audio must fail rather than produce a silent turn');
assert.match(sentencePipeline,
  /currentSentenceNumber\s*===\s*1\s*&&\s*!acknowledgementAudioPlayed/u,
  'final TTS after acknowledgement must not reuse the original first-audio deadline');
assert.doesNotMatch(groundedTurn, /operational_response_unconfigured[\s\S]*suppressInactivity/u,
  'operational failures must not silently return to listening');

const armStart = source.indexOf('#armInactivity()');
const armEnd = source.indexOf('async #handleInactivity()', armStart);
assert.match(source.slice(armStart, armEnd), /activeGroundedTurnEpochs\.size\s*>\s*0/u);
const inactivityEnd = source.indexOf('async #closingMessage(', armEnd);
assert.match(source.slice(armEnd, inactivityEnd), /activeGroundedTurnEpochs\.size\s*>\s*0/u);

console.log('Operational recovery and final-playback inactivity lifecycle verification passed.');
