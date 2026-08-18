import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  authoritativeEvidenceFromRow,
  detectEvidenceConflict,
  mergeAndRerankCandidates,
  resolveConfidenceResponseRoute,
  retainStrongCandidates,
  selectStrongCallerMessage,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import {
  classifyFinalCallCheckUtterance,
  configuredCallCheckEvidence,
  resolveCallCheckConfiguration,
} from '../src/voice/interaction/call-check-config.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { validateFinalCustomerTurn } from '../src/voice/interruption/final-turn-validator.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';

const identity = Object.freeze({
  tenantId: 'tenant-production-replay', workspaceId: 'workspace-production-replay',
  agentId: 'agent-production-replay', callId: 'call-production-replay',
});
const scope = Object.freeze({
  tenantId: identity.tenantId, agentId: identity.agentId,
  publicationRevisions: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-production-replay', publicationRevision: 12 }),
  ]),
  requireHydratedEvidence: true,
});
const callCheck = resolveCallCheckConfiguration({
  callCheckPhrases: ['Hello', 'இருக்கீங்களா?'],
  callCheckResponse: 'ஆமாங்க, நான் இருக்கேங்க. நீங்க பேசுறது கேக்குது, சொல்லுங்க.',
}, { strict: true });
const overview = 'எங்ககிட்ட Master Health Checkupல Silver, Gold, Platinum இருக்கு. இதுக்கூடவே Diabetic Health Checkup, Onco Care Packages, Organ-Specific Packages, Kids Health Packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?';
const purpose = 'நீங்க health check-up enquiry கொடுத்திருந்ததால் package information சொல்ல உதவ call பண்ணியிருக்கோம்.';
const location = 'Shanmuga Hospital Salemல Sarada College Road, Hasthampatti bridgeக்கு கீழே left sideல இருக்கு.';
const overviewQuestion = 'எது பத்தி தெரிஞ்சிக்கணும்?';

function hydratedRecord({ recordId, recordType = 'FAQ', content, authoritativeData = {} }, rank = 1) {
  return {
    ...authoritativeEvidenceFromRow({
      record_type: recordType, record_id: recordId,
      tenant_id: identity.tenantId, agent_id: identity.agentId,
      knowledge_base_id: 'kb-production-replay', publication_revision: 12,
      document_id: `document-${recordId}`, document_version_id: `version-${recordId}`,
      document_name: 'captured-call-replay', language: 'ta', content,
      caller_facing: true, authoritative_data: authoritativeData,
      score: 0.94 - rank * 0.01, rank,
    }),
    semanticScore: 0.94 - rank * 0.01, semanticRank: rank,
    retrievalScore: 0.93 - rank * 0.01, retrievalContext: 'primary',
    channels: ['semantic', 'bm25'],
  };
}

const positiveMessage = hydratedRecord({
  recordId: 'positive-message', recordType: 'CONVERSATION_NODE', content: overview,
  authoritativeData: {
    nodeType: 'message', nodeKey: 'positive-response',
    variables: [
      { key: 'situation', value: 'The caller accepts the immediately preceding offer.' },
      { key: 'context', value: 'no_selected_entity' },
    ],
  },
});
const overviewMessage = hydratedRecord({
  recordId: 'overview-message', recordType: 'CONVERSATION_NODE', content: overview,
  authoritativeData: {
    nodeType: 'message', nodeKey: 'complete-overview',
    variables: [{ key: 'situation', value: 'The caller asks for all available options.' }],
  },
});
const purposeEvidence = hydratedRecord({
  recordId: 'call-purpose', content: purpose,
  authoritativeData: { question: 'Why did you call?', answer: purpose },
});
const locationEvidence = hydratedRecord({
  recordId: 'location', content: location,
  authoritativeData: { question: 'Where are you located?', answer: location },
});
const unrelatedEvidence = hydratedRecord({
  recordId: 'unrelated', content: 'Published information about operating hours.',
  authoritativeData: { question: 'When are you open?', answer: 'Published operating hours.' },
}, 2);
const semanticCallCheckEvidence = configuredCallCheckEvidence(callCheck, identity);

const turns = Object.freeze([
  Object.freeze({ utterance: 'ஆமாங்க', kind: 'direct', evidence: positiveMessage, answer: overview }),
  Object.freeze({ utterance: 'Hello கேக்குதா?', kind: 'call_check', evidence: semanticCallCheckEvidence, answer: callCheck.response, resumePending: true }),
  Object.freeze({ utterance: 'ஆமாங்க நான் சண்முதம் தான் பேசுறேன்', kind: 'llm', evidence: purposeEvidence, answer: purpose, resumePending: true }),
  Object.freeze({ utterance: 'நான் பேசுறது சண்முகம் தான் சொல்லுங்க எதுக்கு phone பண்ணீங்க', kind: 'llm', evidence: purposeEvidence, answer: purpose, resumePending: true }),
  Object.freeze({ utterance: 'Hello இருக்கீங்களா ஃபர்ஸ்ட்', kind: 'call_check', evidence: semanticCallCheckEvidence, answer: callCheck.response, resumePending: true }),
  Object.freeze({ utterance: 'Hello கேக்குதா இல்லையா?', kind: 'call_check', evidence: semanticCallCheckEvidence, answer: callCheck.response, resumePending: true }),
  Object.freeze({ utterance: 'நான் சண்முகம் தான் பேசுறேன் என்ன வேணும் உங்களுக்கு எதுக்கு phone பண்ணீங்க', kind: 'llm', evidence: purposeEvidence, answer: purpose, resumePending: true }),
  Object.freeze({ utterance: 'உங்ககிட்ட என்ன packagesலாம் இருக்கு?', kind: 'direct', evidence: overviewMessage, answer: overview }),
  Object.freeze({ utterance: 'உங்ககிட்ட என்ன packagesலாம் இருக்கு?', kind: 'direct', evidence: overviewMessage, answer: overview }),
  Object.freeze({ utterance: 'உங்க hospital எங்க இருக்கு?', kind: 'llm', evidence: locationEvidence, answer: location, resumePending: false }),
]);

const memory = openGenericConversationState(identity, { conversationLanguage: 'ta' }, Date.now(), {
  pendingQuestion: { key: 'introduction_offer', text: 'Package details explain பண்ணலாமா?', kind: 'conversation' },
});
const stageLatency = [];
let directResponses = 0;
let groundedDecisions = 0;
let callCheckDecisions = 0;

for (const [index, turn] of turns.entries()) {
  const started = performance.now();
  const stt = validateFinalCustomerTurn({
    text: turn.utterance, minimumWords: 3,
    acknowledgementPhrases: ['ஆமாங்க', 'Yes', 'okay'], rejectAcknowledgement: false,
  });
  assert.equal(stt.accepted, true, `turn ${index + 1}: finalized STT accepted`);
  if (turn.utterance === 'ஆமாங்க') assert.equal(stt.shortMeaningfulTurn, true);

  const semantic = [
    {
      recordType: turn.evidence.recordType, recordId: turn.evidence.recordId,
      knowledgeBaseId: turn.evidence.knowledgeBaseId ?? 'runtime-config',
      semanticScore: 0.94, channelRank: 1, language: 'ta',
      contentPreview: turn.evidence.content,
    },
    {
      recordType: unrelatedEvidence.recordType, recordId: unrelatedEvidence.recordId,
      knowledgeBaseId: unrelatedEvidence.knowledgeBaseId,
      semanticScore: 0.91, channelRank: 2, language: 'ta',
      contentPreview: unrelatedEvidence.content,
    },
  ];
  const lexical = [{
    recordType: turn.evidence.recordType, recordId: turn.evidence.recordId,
    knowledgeBaseId: turn.evidence.knowledgeBaseId ?? 'runtime-config',
    lexicalScore: 4.5, tokenCoverage: 0.65, channelRank: 1, language: 'ta',
    contentPreview: turn.evidence.content,
  }];
  const retained = retainStrongCandidates(
    mergeAndRerankCandidates(semantic, lexical, turn.utterance, 'ta', 5),
    turn.utterance, 5,
  );
  assert.equal(retained[0].recordId, turn.evidence.recordId, `turn ${index + 1}: retrieval ranking`);
  assert.ok(retained.length <= 5, `turn ${index + 1}: bounded retrieval`);
  assert.equal(evidenceBelongsToRuntime(turn.evidence, scope), true, `turn ${index + 1}: evidence scope`);

  const evidenceSet = [turn.evidence, unrelatedEvidence];
  const conflict = detectEvidenceConflict(evidenceSet);
  assert.equal(conflict.detected, false, `turn ${index + 1}: no false evidence conflict`);
  const direct = turn.kind === 'direct'
    ? selectStrongCallerMessage([turn.evidence], turn.utterance, { knownEntities: [] })
    : null;
  const route = resolveConfidenceResponseRoute({ directMessage: direct, evidence: evidenceSet, conflict });
  assert.equal(route.outcome, turn.kind === 'direct' ? 'direct' : 'grounded_llm',
    `turn ${index + 1}: confidence route`);

  const turnToken = memory.beginTurn(`replay-turn-${index + 1}`);
  memory.append({ role: 'user', content: turn.utterance }, { turnToken });
  let finalTtsText;
  if (turn.kind === 'direct') {
    assert.equal(direct.content, turn.answer, `turn ${index + 1}: exact published response`);
    memory.applyGroundedDecision({
      stateUpdate: { currentTopic: direct.authoritativeData.nodeKey, pendingQuestionRelevant: false },
      pendingQuestion: null,
    }, { turnToken });
    memory.observeAssistantResponse(turn.answer, { turnToken });
    memory.append({ role: 'assistant', content: turn.answer }, { turnToken });
    finalTtsText = direct.content;
    directResponses += 1;
  } else {
    if (turn.kind === 'call_check') {
      const classification = classifyFinalCallCheckUtterance(
        turn.utterance, callCheck, { finalized: true },
      );
      assert.equal(classification.shortcut, false, `turn ${index + 1}: natural variation uses semantic path`);
      callCheckDecisions += 1;
    }
    const envelope = buildGroundingEnvelope({
      found: true, tenantEvidence: { sources: evidenceSet, entities: [] },
    }, { includePublishedMap: false });
    const result = applyUnifiedGroundedTurn({
      rawDecision: JSON.stringify({
        decision: 'answer', answer: turn.answer, evidenceIds: ['source_1'],
        stateUpdate: {
          requestType: turn.kind === 'call_check' ? 'presence_check' : 'details',
          currentTopic: turn.kind === 'call_check' ? 'call presence' : 'caller request',
          knownEntityKeys: [], requestedFacts: [], constraints: [],
          contextualReferences: [], contextDependent: false,
          collectedInformation: {}, correctedFields: [],
          pendingQuestionRelevant: turn.resumePending === true,
        },
        pendingQuestion: null, toolRequest: null,
      }),
      groundingEnvelope: envelope,
      memory, turnToken, evidence: evidenceSet, evidenceScope: scope,
      finalizedUtterance: turn.utterance,
    });
    assert.equal(result.valid, true, `turn ${index + 1}: grounded decision (${result.reason ?? 'valid'})`);
    finalTtsText = result.answer;
    groundedDecisions += 1;
  }
  const expectedTtsText = turn.resumePending
    ? `${turn.answer} ${overviewQuestion}` : turn.answer;
  assert.equal(finalTtsText, expectedTtsText, `turn ${index + 1}: final validated TTS text`);
  stageLatency.push(performance.now() - started);
}

const realConflict = detectEvidenceConflict([
  {
    ...locationEvidence, recordId: 'location-a', retrievalScore: 0.92,
    authoritativeData: { itemKey: 'same-record', price: 100 },
  },
  {
    ...locationEvidence, recordId: 'location-b', retrievalScore: 0.9,
    authoritativeData: { itemKey: 'same-record', price: 200 },
  },
]);
assert.equal(realConflict.detected, true);
assert.equal(resolveConfidenceResponseRoute({
  evidence: [locationEvidence], conflict: realConflict,
}).outcome, 'clarify', 'real contradictory facts still clarify');

const snapshot = memory.snapshot();
assert.equal(snapshot.pendingQuestion, null, 'completed introduction question is not repeated');
assert.equal(snapshot.lastAnswer, location, 'latest answer is retained in generic memory');
assert.ok(snapshot.recentTurns.some((turn) => turn.content === turns.at(-1).utterance));
memory.close();

const sorted = [...stageLatency].sort((left, right) => left - right);
const percentile = (value) => sorted[Math.min(
  sorted.length - 1, Math.ceil(sorted.length * value / 100) - 1,
)];
const latency = { p50: percentile(50), p90: percentile(90), p95: percentile(95) };
assert.ok(latency.p95 < 100, `local replay p95 exceeded 100ms: ${latency.p95.toFixed(2)}ms`);

console.log(JSON.stringify({
  task: 'clarification-loop-production-replay', passed: true,
  turns: turns.length, sttAccepted: turns.length,
  retrievalValidated: turns.length, conflictsRejected: turns.length,
  directResponses, groundedDecisions, callCheckDecisions,
  ttsTextsValidated: turns.length, memoryValidated: true,
  localReplayLatencyMs: Object.fromEntries(Object.entries(latency)
    .map(([key, value]) => [key, Number(value.toFixed(2))])),
}));
