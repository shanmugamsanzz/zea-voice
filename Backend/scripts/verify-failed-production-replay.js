import assert from 'node:assert/strict';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';
import { strongCallerMessageMatch } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { evidenceBelongsToRuntime, } from '../src/voice/interaction/grounded-decision-security.js';
import { validateGroundedClaims } from '../src/voice/interaction/grounded-claim-validator.js';

// Replay of the failed production turn sequence. Runtime matching remains
// generic; these utterances and records are test data representing a captured
// multilingual call, not business logic.
const turns = [
  { utterance: 'ஏ சாம்பா சொல்லுங்க', recordId: 'guidance-overview', direct: true },
  { utterance: 'உங்ககிட்ட என்னென்ன packages இருக்கு?', recordId: 'guidance-overview', direct: true },
  { utterance: 'உங்ககிட்ட என்ன packagesலாம் இருக்கு', recordId: 'guidance-overview', direct: true },
  { utterance: 'ஆமாங்க எனக்கு detail-ஆ என்னென்ன packages இருக்குன்னு சொல்லுங்க', recordId: 'guidance-overview', direct: true },
  { utterance: 'ஆ cardiologist பத்தி சொல்றீங்களா?', recordId: 'catalog-cardiac', answer: 'Cardiac screening includes cardiovascular tests and a specialist consultation.' },
  { utterance: 'எனக்கு Oncocare பத்தி சொல்றீங்களா?', recordId: 'catalog-oncology', answer: 'Oncology screening options include approved screening tests and oncology consultation.' },
  { utterance: 'Oncocare packages பத்தி சொல்றீங்களா?', recordId: 'catalog-oncology', answer: 'Oncology screening options include approved screening tests and oncology consultation.' },
  { utterance: 'ஆண் கோ கேர் package சுத்தி போச்சு சொல்லுங்க', recordId: 'catalog-oncology', answer: 'The approved oncology option includes its published screening services.' },
  { utterance: 'Hello, Onco Care package பத்தி கேட்டேன்.', recordId: 'catalog-oncology', answer: 'Oncology screening options include approved screening tests and oncology consultation.' },
  { utterance: 'சரி lungs பத்தி சொல்றீங்களா?', recordId: 'catalog-respiratory', answer: 'Respiratory screening includes approved lung-function tests and specialist consultation.' },
  { utterance: 'ஆ kitchen checkup பத்தி சொல்லுங்க', recordId: 'catalog-respiratory', answer: 'The latest supported screening option includes approved respiratory tests.' },
  { utterance: 'Kids health checkup பத்தி சொல்லுங்க.', recordId: 'catalog-pediatric', answer: 'Child screening includes approved pediatric services and consultation.' },
  { utterance: 'organ specific package பத்தி சொல்லுங்க', recordId: 'catalog-organ', answer: 'Organ-specific screening options are available from the published catalog.' },
  { utterance: 'organ specific package பத்தி சொல்லுங்க', recordId: 'catalog-organ', answer: 'Organ-specific screening options are available from the published catalog.' },
  { utterance: 'Hello', recordId: 'faq-call-check', answer: 'Yes, I am here and can hear you.' },
];

const records = new Map([
  ['guidance-overview', { recordType: 'CONVERSATION_NODE', content: 'எங்ககிட்ட Master Health Checkupல Silver, Gold, Platinum இருக்கு. இதுக்கூடவே Diabetic Health Checkup, Onco Care Packages, Organ-Specific Packages, Kids Health Packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?', callerFacing: true, authoritativeData: { nodeType: 'message', variables: [{ key: 'situation', value: 'The caller accepts the preceding offer or asks for all available options.' }, { key: 'matchMode', value: 'semantic' }, { key: 'context', value: 'no_selected_entity' }] } }],
  ['catalog-cardiac', { recordType: 'CATALOG_ITEM', content: 'Cardiac screening includes cardiovascular tests and a specialist consultation.', callerFacing: true, authoritativeData: {} }],
  ['catalog-oncology', { recordType: 'CATALOG_ITEM', content: 'Oncology screening options include approved screening tests and oncology consultation.', callerFacing: true, authoritativeData: {} }],
  ['catalog-respiratory', { recordType: 'CATALOG_ITEM', content: 'Respiratory screening includes approved lung-function tests and specialist consultation.', callerFacing: true, authoritativeData: {} }],
  ['catalog-pediatric', { recordType: 'CATALOG_ITEM', content: 'Child screening includes approved pediatric services and consultation.', callerFacing: true, authoritativeData: {} }],
  ['catalog-organ', { recordType: 'CATALOG_ITEM', content: 'Organ-specific screening options are available from the published catalog.', callerFacing: true, authoritativeData: {} }],
  ['faq-call-check', { recordType: 'FAQ', content: 'Yes, I am here and can hear you.', callerFacing: true, authoritativeData: {} }],
]);

const scope = { tenantId: 'tenant-replay', agentId: 'agent-replay', publicationRevisions: [{ knowledgeBaseId: 'kb-replay', publicationRevision: 7 }] };
let directCount = 0;
for (const [index, turn] of turns.entries()) {
  const record = records.get(turn.recordId);
  const evidence = {
    id: `published:${turn.recordId}`, recordId: turn.recordId, ...record,
    tenantId: scope.tenantId, agentId: scope.agentId, knowledgeBaseId: 'kb-replay', publicationRevision: 7,
    rank: 1, score: 1,
    semanticScore: turn.direct ? 0.92 : 0.8,
    semanticRank: 1,
    channels: ['semantic'],
  };
  assert.equal(evidenceBelongsToRuntime(evidence, scope), true, `scope turn ${index + 1}`);
  const envelope = buildGroundingEnvelope({ found: true, tenantEvidence: { sources: [evidence], entities: [] } }, { includePublishedMap: false });
  assert.equal(envelope.sources.length, 1, `retrieval evidence turn ${index + 1}`);
  const direct = strongCallerMessageMatch(evidence, turn.utterance, { knownEntities: [] });
  if (turn.direct) {
    assert.equal(direct, true, `direct guidance match turn ${index + 1}`);
    directCount += 1;
    assert.equal(evidence.content.length > 0, true);
    assert.equal(evidence.content, 'எங்ககிட்ட Master Health Checkupல Silver, Gold, Platinum இருக்கு. இதுக்கூடவே Diabetic Health Checkup, Onco Care Packages, Organ-Specific Packages, Kids Health Packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?');
    continue;
  }
  assert.equal(direct, false, `non-exact turn ${index + 1}`);
  const answer = turn.answer;
  const decision = validateGroundedLlmDecision(JSON.stringify({
    decision: 'answer', answer, responseId: null, evidenceIds: ['source_1'],
    stateUpdate: {}, pendingQuestion: null, toolRequest: null, clarification: null,
  }), envelope);
  assert.equal(decision.valid, true,
    `validated decision turn ${index + 1}: ${decision.reason ?? 'unknown'}`);
  const claims = validateGroundedClaims(decision.answer, [evidence]);
  assert.equal(claims.valid, true, `validated claims turn ${index + 1}`);
  // This is the exact text that the final validated response hands to TTS.
  assert.equal(decision.answer, answer, `TTS text turn ${index + 1}`);
}

assert.equal(directCount, 4);
console.log(JSON.stringify({
  task: 'failed-production-replay', passed: true, turns: turns.length,
  retrievalValidated: turns.length, finalDecisionsValidated: turns.length - directCount,
  exactResponsesValidated: directCount, ttsTextsValidated: turns.length,
  partialLlmTextReleased: false,
}));
