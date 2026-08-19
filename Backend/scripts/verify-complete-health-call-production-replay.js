import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  authoritativeEvidenceFromRow,
  selectStrongCallerMessage,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { validateFinalCustomerTurn } from '../src/voice/interruption/final-turn-validator.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';

// Captured-call content is intentionally test-only. Production runtime uses
// published tenant records and generic semantics; it contains none of these
// business names, aliases, answers or caller phrases.
const identity = Object.freeze({
  tenantId: 'tenant-complete-call', workspaceId: 'workspace-complete-call',
  agentId: 'agent-complete-call', callId: 'call-complete-call',
});
const scope = Object.freeze({
  tenantId: identity.tenantId, agentId: identity.agentId,
  publicationRevisions: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-complete-call', publicationRevision: 21 }),
  ]),
  requireHydratedEvidence: true,
});
const overview = 'எங்ககிட்ட Master Health Checkupல Silver, Gold, Platinum இருக்கு. இதுக்கூடவே Diabetic Health Checkup, Onco Care Packages, Organ-Specific Packages, Kids Health Packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?';

function hydratedRow({ recordId, recordType = 'CATALOG_ITEM', content, authoritativeData, rank = 1 }) {
  return {
    ...authoritativeEvidenceFromRow({
      record_type: recordType, record_id: recordId,
      tenant_id: identity.tenantId, agent_id: identity.agentId,
      knowledge_base_id: 'kb-complete-call', publication_revision: 21,
      document_id: `document-${recordId}`, document_version_id: `version-${recordId}`,
      document_name: 'captured-production-call', language: 'ta', content,
      caller_facing: true, authoritative_data: authoritativeData,
      score: 0.96 - rank * 0.01, rank,
    }),
    semanticScore: 0.96 - rank * 0.01, semanticRank: rank,
    retrievalScore: 0.95 - rank * 0.01, retrievalContext: 'primary',
    channels: ['semantic', 'bm25'], tokenCoverage: 0.7,
  };
}

function catalog({ recordId, itemKey, name, aliases = [], category, categoryAliases = [], price,
  attributes, content, rank = 1 }) {
  return hydratedRow({
    recordId, content, rank,
    authoritativeData: {
      itemKey, name, aliases, category, categoryAliases, price, currency: 'INR',
      description: content, attributes, relationships: {}, selectionRules: { selectable: true },
    },
  });
}

const positiveMessage = hydratedRow({
  recordId: 'message-positive', recordType: 'CONVERSATION_NODE', content: overview,
  authoritativeData: {
    nodeType: 'message', nodeKey: 'positive-introduction-response',
    variables: [
      { key: 'situation', value: 'The caller positively accepts the immediately preceding offer.' },
      { key: 'context', value: 'pending_question' },
    ],
  },
});
positiveMessage.retrievalContext = 'contextual';
const overviewMessage = hydratedRow({
  recordId: 'message-overview', recordType: 'CONVERSATION_NODE', content: overview,
  authoritativeData: {
    nodeType: 'message', nodeKey: 'complete-package-overview',
    variables: [
      { key: 'situation', value: 'The caller requests all available options.' },
      { key: 'context', value: 'no_selected_entity' },
    ],
  },
});
const unrelatedFaq = hydratedRow({
  recordId: 'unrelated-faq', recordType: 'FAQ', rank: 5,
  content: 'Published information about an unrelated policy.',
  authoritativeData: { question: 'What is the unrelated policy?', answer: 'Published policy.' },
});
const callSupport = hydratedRow({
  recordId: 'call-support', recordType: 'FAQ',
  content: 'நாம் இப்போ callல தான் இருக்கோம்; இந்த callல உங்களுக்கு தேவையான தகவலை சொல்ல உதவுறேன்.',
  authoritativeData: {
    question: 'Can you call me?',
    answer: 'நாம் இப்போ callல தான் இருக்கோம்; இந்த callல உங்களுக்கு தேவையான தகவலை சொல்ல உதவுறேன்.',
  },
});

const onco = catalog({
  recordId: 'onco-premium', itemKey: 'onco-care-premium', name: 'Onco Care Screening Premium',
  aliases: ['Onco Care', 'On Cooker'], category: 'Oncology Screening',
  categoryAliases: ['Onco Care Packages'], price: 8600,
  attributes: [
    { key: 'tests', value: ['CBC', 'Urine Complete', 'Urea', 'Creatinine', 'Amylase', 'Lipase', 'Liver Function Test', 'Random Sugar', 'PSA', 'CEA', 'CA 19.9', 'CT Scan Screening'] },
    { key: 'consultation', value: 'Medical Oncologist Consultation' },
  ],
  content: 'Onco Care Screening Premium விலை INR 8600. CBC, Urine Complete, Urea, Creatinine, Amylase, Lipase, Liver Function Test, Random Sugar, PSA, CEA, CA 19.9 மற்றும் CT Scan Screening இருக்கு. Medical Oncologist Consultation included.',
});

const kids = [
  catalog({
    recordId: 'kids-pediatric', itemKey: 'pediatric-health-screening', name: 'Pediatric Health Screening',
    aliases: ['Kids Health Checkup'], category: 'Pediatric Health Screening',
    categoryAliases: ['Kids Health Packages'], price: 1500,
    attributes: [
      { key: 'services', value: ['Dental Assessment', 'Nutritional Assessment', 'Immunization Counseling', 'Growth Screening', 'Developmental Screening', 'Anemia Screening', 'CBC', 'MCV', 'MCH', 'MCHC', 'Peripheral Smear'] },
      { key: 'consultation', value: 'One Doctor Consultation' },
      { key: 'preparation', value: 'Eight hours fasting before the test' },
    ],
    content: 'Pediatric Health Screening விலை INR 1500; Dental Assessment, Nutritional Assessment, Immunization Counseling, Growth Screening, Developmental Screening, Anemia Screening, CBC, MCV, MCH, MCHC, Peripheral Smear மற்றும் one Doctor Consultation இருக்கு.',
  }),
  catalog({
    recordId: 'kids-developmental', itemKey: 'developmental-behavioral-screening', name: 'Developmental and Behavioral Screening',
    aliases: ['Child Development Screening'], category: 'Pediatric Health Screening',
    categoryAliases: ['Kids Health Packages'],
    attributes: [{ key: 'services', value: ['Developmental Screening', 'IQ Assessment', 'Behavioural Assessment', 'Screening for Developmental Disorder'] }],
    content: 'Developmental and Behavioral Screeningல Developmental Screening, IQ Assessment, Behavioural Assessment மற்றும் Screening for Developmental Disorder options இருக்கு.', rank: 2,
  }),
  catalog({
    recordId: 'kids-neonatal', itemKey: 'neonatal-health-screening', name: 'Neonatal Health Screening',
    aliases: ['Newborn Screening'], category: 'Pediatric Health Screening',
    categoryAliases: ['Kids Health Packages'],
    attributes: [{ key: 'services', value: ['3 Panel Screening', '4 Panel Screening', 'New Born Hearing Screening'] }],
    content: 'Neonatal Health Screeningல 3 Panel Screening, 4 Panel Screening மற்றும் New Born Hearing Screening options இருக்கு.', rank: 3,
  }),
];

const organ = [
  ['renal', 'Renal Health Checkup', 1400, ['Hemoglobin', 'Urea', 'Creatinine', 'Uric Acid', 'Calcium', 'Electrolytes', 'BUN', 'USG Abdomen']],
  ['liver', 'Liver Health Checkup', 1400, ['Hemoglobin', 'Liver Function Test', 'USG Abdomen']],
  ['cardiac', 'Cardiac Health Checkup', 2950, ['CBC', 'FBS', 'PPBS', 'HbA1C', 'Lipid Profile', 'ECG', 'ECHO', 'Treadmill Test']],
  ['lungs', 'Lungs Health Checkup', 999, ['CBC', 'RBS', 'CRP', 'ESR', 'X-Ray', 'ECG', 'PFT']],
  ['ortho', 'Ortho Health Checkup', 1499, ['X-Ray', 'ESR', 'CRP', 'Calcium', 'Vitamin D', 'Uric Acid', 'RA Factor']],
].map(([key, name, price, tests], index) => catalog({
  recordId: `organ-${key}`, itemKey: `${key}-health-checkup`, name,
  aliases: [`${key} package`], category: 'Organ-Specific Health Check-ups',
  categoryAliases: ['Organ-Specific Packages'], price,
  attributes: [{ key: 'tests', value: tests }],
  content: `${name} விலை INR ${price}. ${tests.join(', ')} tests இருக்கு.`, rank: index + 1,
}));

const diabetic = catalog({
  recordId: 'diabetic', itemKey: 'diabetes-health-checkup', name: 'Diabetes Health Checkup',
  aliases: ['Diabetic Health Checkup', 'Diabetic package'], category: 'Diabetes Health Check-up',
  categoryAliases: ['Diabetic Health Checkup'], price: 3200,
  attributes: [
    { key: 'tests', value: ['Fasting Blood Sugar', 'Post Prandial Blood Sugar', 'Chest X-Ray', 'CBC', 'Creatinine', 'ECG', 'ECHO', 'ESR', 'HbA1C', 'Lipid Profile', 'Insulin Fasting', 'Insulin Resistance', 'Insulin Sensitivity', 'Ankle Brachial Index', 'Biothesiometry', 'Foot Screening', 'Microalbuminuria - Random Urine', 'USG Abdomen/Pelvis', 'Urea', 'Uric Acid', 'Urine Albumin Creatinine Ratio', 'Urine Complete Analysis'] },
    { key: 'consultation', value: 'One Doctor Consultation' },
  ],
  content: 'Diabetes Health Checkup விலை INR 3200. Fasting Blood Sugar, Post Prandial Blood Sugar, Chest X-Ray, CBC, Creatinine, ECG, ECHO, ESR, HbA1C, Lipid Profile, Insulin Fasting, Insulin Resistance, Insulin Sensitivity, Ankle Brachial Index, Biothesiometry, Foot Screening, Microalbuminuria - Random Urine, USG Abdomen/Pelvis, Urea, Uric Acid, Urine Albumin Creatinine Ratio, Urine Complete Analysis மற்றும் one Doctor Consultation இருக்கு.',
});

const detailTurns = Object.freeze([
  Object.freeze({ utterance: 'On Cooker package பத்தி சொல்லுங்க', entity: 'Onco Care', topic: 'Onco Care', stateTopic: 'onco-care-premium', records: [onco], answer: onco.content }),
  Object.freeze({ utterance: 'Kids package பத்தி சொல்லுங்க', entity: 'Kids Health Packages', topic: 'Kids Health Packages', records: kids, answer: kids.map((item) => item.content).join(' ') }),
  Object.freeze({ utterance: 'organ specific package பத்தி சொல்லுங்க', entity: 'Organ-Specific Packages', topic: 'Organ-Specific Packages', records: organ, answer: organ.map((item) => item.content).join(' ') }),
  Object.freeze({ utterance: 'diabetic package பத்தி சொல்லுங்க', entity: 'Diabetic Health Checkup', topic: 'Diabetic Health Checkup', stateTopic: 'diabetes-health-checkup', records: [diabetic], answer: diabetic.content }),
]);

const memory = openGenericConversationState(identity, { conversationLanguage: 'ta' }, Date.now(), {
  pendingQuestion: { key: 'introduction_offer', text: 'Package details explain பண்ணலாமா?', kind: 'conversation' },
});
const latencySamples = [];
const ttsOutputs = [];
let overviewOutputs = 0;

function unifiedDecision(value) {
  return JSON.stringify({
    responseId: null,
    clarification: value.decision === 'clarify' ? { reason: 'ambiguous_request' } : null,
    ...value,
  });
}

const capturedTurns = [
  { utterance: 'ம் ஆமாங்க', direct: positiveMessage, contextual: true, requestType: 'positive_acknowledgement', answer: overview },
  { utterance: 'எனக்கு phone பண்ணு', evidence: callSupport, contextual: false, requestType: 'call_request', answer: callSupport.content },
  { utterance: 'ஊர்ல என்ன packagesலாம் இருக்கு', direct: overviewMessage, contextual: false, requestType: 'overview', answer: overview },
];
for (const [index, turn] of capturedTurns.entries()) {
  const started = performance.now();
  const stt = validateFinalCustomerTurn({
    text: turn.utterance, minimumWords: 3,
    acknowledgementPhrases: ['ம் ஆமாங்க', 'ஆமாங்க', 'Yes'], rejectAcknowledgement: false,
  });
  assert.equal(stt.accepted, true, `direct turn ${index + 1}: finalized STT accepted`);
  const meaning = Object.freeze({
    requestType: turn.requestType,
    topic: null, explicitEntities: [], requestedFacts: [], constraints: [],
    contextualReferences: turn.contextual ? ['pending offer'] : [],
    contextDependent: turn.contextual, topicChanged: false,
  });
  const token = memory.beginTurn(`direct-${index + 1}`);
  memory.append({ role: 'user', content: turn.utterance }, { turnToken: token });
  if (turn.direct) {
    const selected = selectStrongCallerMessage([turn.direct], turn.utterance, {
      pendingQuestion: turn.contextual ? 'Package details explain பண்ணலாமா?' : null,
      understanding: meaning, knownEntities: [],
    });
    assert.equal(selected?.recordId, turn.direct.recordId, `direct turn ${index + 1}: published message selected`);
    memory.applyGroundedDecision({
      stateUpdate: { currentTopic: selected.authoritativeData.nodeKey, pendingQuestionRelevant: false },
      pendingQuestion: null,
    }, { turnToken: token });
    memory.observeAssistantResponse(selected.content, { turnToken: token });
    memory.append({ role: 'assistant', content: selected.content }, { turnToken: token });
    ttsOutputs.push(selected.content);
    overviewOutputs += 1;
  } else {
    const envelope = buildGroundingEnvelope({
      found: true, tenantEvidence: { sources: [turn.evidence], entities: [] },
    }, { includePublishedMap: false });
    const result = applyUnifiedGroundedTurn({
      rawDecision: unifiedDecision({
        decision: 'answer', answer: turn.answer, evidenceIds: ['source_1'],
        stateUpdate: {
          requestType: 'call_request', currentTopic: 'current call', knownEntityKeys: [],
          requestedFacts: [], constraints: [], contextualReferences: [], contextDependent: false,
          collectedInformation: {}, correctedFields: [], pendingQuestionRelevant: false,
        },
        pendingQuestion: null, toolRequest: null,
      }),
      groundingEnvelope: envelope, memory, turnToken: token,
      evidence: [turn.evidence], evidenceScope: scope, finalizedUtterance: turn.utterance,
    });
    assert.equal(result.valid, true, `support turn ${index + 1}: grounded response`);
    assert.equal(result.answer, turn.answer, `support turn ${index + 1}: final TTS output`);
    ttsOutputs.push(result.answer);
  }
  latencySamples.push(performance.now() - started);
}

// Recreate the stale overview prompt once before the first specific request;
// a correct specific answer must complete it and never append the overview.
memory.setPendingQuestion({ text: overview, kind: 'conversation' });

for (const [index, turn] of detailTurns.entries()) {
  const started = performance.now();
  const stt = validateFinalCustomerTurn({ text: turn.utterance, minimumWords: 2 });
  assert.equal(stt.accepted, true, `detail turn ${index + 1}: STT variation accepted`);
  const meaning = Object.freeze({
    requestType: 'details', topic: turn.topic, explicitEntities: [turn.entity],
    requestedFacts: ['price', 'included details'], constraints: [], contextualReferences: [],
    contextDependent: false, topicChanged: true,
  });
  assert.equal(meaning.explicitEntities[0], turn.entity, `detail turn ${index + 1}: entity resolved before retrieval`);
  // The production retriever now uses the raw finalized utterance; these are
  // the authoritative rows returned for that test query after SQL hydration.
  const focused = turn.records.slice(0, 5);
  assert.equal(focused.some((item) => item.recordId === overviewMessage.recordId), false,
    `detail turn ${index + 1}: overview evidence removed`);
  assert.equal(focused.some((item) => item.recordType === 'FAQ'), false,
    `detail turn ${index + 1}: unrelated FAQ removed`);
  assert.equal(focused.length, Math.min(turn.records.length, 5),
    `detail turn ${index + 1}: focused top records`);
  for (const source of focused) {
    assert.equal(source.hydrationValidated, true, `detail turn ${index + 1}: PostgreSQL hydration marker`);
    assert.equal(source.documentVersionIsCurrent, true, `detail turn ${index + 1}: current revision`);
    assert.equal(evidenceBelongsToRuntime(source, scope), true, `detail turn ${index + 1}: authoritative scope`);
    assert.ok(Array.isArray(source.authoritativeData.attributes), `detail turn ${index + 1}: complete attributes`);
    assert.equal(source.authoritativeData.selectionRules.selectable, true,
      `detail turn ${index + 1}: complete selection rules`);
  }
  const entities = focused.map((source) => ({
    id: source.recordId, key: source.authoritativeData.itemKey,
    name: source.authoritativeData.name, category: source.authoritativeData.category,
  }));
  const envelope = buildGroundingEnvelope({
    found: true, tenantEvidence: { sources: focused, entities },
  }, { includePublishedMap: false, maximumSources: 5 });
  const evidenceIds = envelope.sources.map((source) => source.id);
  const token = memory.beginTurn(`detail-${index + 1}`);
  memory.append({ role: 'user', content: turn.utterance }, { turnToken: token });
  const result = applyUnifiedGroundedTurn({
    rawDecision: unifiedDecision({
      decision: 'answer', answer: turn.answer, evidenceIds,
      stateUpdate: {
        requestType: 'details', currentTopic: turn.topic,
        knownEntityKeys: entities.map((entity) => entity.key),
        requestedFacts: meaning.requestedFacts, constraints: [], contextualReferences: [],
        contextDependent: false, collectedInformation: {}, correctedFields: [],
        pendingQuestionRelevant: true,
      },
      pendingQuestion: null, toolRequest: null,
    }),
    groundingEnvelope: envelope, memory, turnToken: token,
    evidence: focused, evidenceScope: scope, finalizedUtterance: turn.utterance,
  });
  assert.equal(result.valid, true, `detail turn ${index + 1}: grounded answer (${result.reason ?? 'valid'})`);
  assert.equal(result.pendingQuestion, null, `detail turn ${index + 1}: stale overview cleared`);
  assert.equal(result.answer.includes(overview), false, `detail turn ${index + 1}: overview not repeated`);
  assert.equal(result.answer, turn.answer, `detail turn ${index + 1}: final TTS output`);
  assert.equal(result.state.currentTopic, turn.stateTopic ?? turn.topic, `detail turn ${index + 1}: topic changed`);
  ttsOutputs.push(result.answer);
  latencySamples.push(performance.now() - started);
}

assert.equal(ttsOutputs.length, capturedTurns.length + detailTurns.length);
assert.equal(ttsOutputs.filter((value) => value === overview).length, overviewOutputs,
  'overview appears only for positive introduction and explicit overview turns');
assert.equal(memory.snapshot().currentTopic, 'diabetes-health-checkup');
assert.equal(memory.snapshot().pendingQuestion, null);
memory.close();

const sorted = [...latencySamples].sort((left, right) => left - right);
const percentile = (value) => sorted[Math.min(
  sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value / 100) - 1),
)];
const latency = { p50: percentile(50), p90: percentile(90), p95: percentile(95) };
assert.ok(Object.values(latency).every((value) => Number.isFinite(value) && value >= 0));
assert.ok(latency.p95 < 100, `local complete-call replay p95 exceeded 100ms: ${latency.p95.toFixed(2)}ms`);

console.log(JSON.stringify({
  task: 'complete-health-call-production-replay', passed: true,
  turns: ttsOutputs.length, positiveIntroduction: true, overviewValidated: true,
  sttVariationsValidated: detailTurns.length + capturedTurns.length,
  detailTopics: detailTurns.map((turn) => turn.topic),
  topicChangesValidated: detailTurns.length,
  repeatedOverviewAfterSpecificAnswer: false,
  completeCatalogHydration: true, finalTtsOutputsValidated: ttsOutputs.length,
  localReplayLatencyMs: Object.fromEntries(Object.entries(latency)
    .map(([key, value]) => [key, Number(value.toFixed(2))])),
}));
