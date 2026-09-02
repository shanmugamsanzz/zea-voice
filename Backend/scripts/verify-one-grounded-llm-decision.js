import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createGroundedDecisionStreamDecoder,
  groundedDecisionContract,
  groundedDecisionJsonSchema,
  isOperationalGroundedDecisionFailure,
  isRepairableGroundedDecisionReason,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';
import {
  assertGroundedStructuredCompletion,
  createSelectedLlmStream,
} from '../src/voice/providers/llm/llm-response.service.js';

const envelope = Object.freeze({
  found: true,
  sources: Object.freeze([
    Object.freeze({ id: 'source_1', recordId: 'record-1', content: 'Premium service costs INR 3200 and includes priority support.' }),
    Object.freeze({ id: 'source_2', recordId: 'record-2', content: 'The office is on Central Road.' }),
  ]),
  sourceMap: Object.freeze([
    Object.freeze({ sourceId: 'source_1', recordId: 'record-1' }),
    Object.freeze({ sourceId: 'source_2', recordId: 'record-2' }),
  ]),
  entities: Object.freeze([
    Object.freeze({
      id: 'item-1', key: 'premium-service', name: 'Premium service',
      aliases: ['Translated premium name'], sourceId: 'source_1',
    }),
  ]),
});
const runtime = Object.freeze({
  fieldSchemas: Object.freeze([
    Object.freeze({ key: 'customer_name', type: 'text', required: true, requiredAction: 'create_visit' }),
    Object.freeze({ key: 'visit_date', type: 'date', required: true, requiredAction: 'create_visit' }),
  ]),
  toolSchemas: Object.freeze([Object.freeze({
    name: 'create_visit', description: 'Create a visit',
    inputSchema: Object.freeze({
      type: 'object', required: ['customer_name', 'visit_date'], additionalProperties: false,
      properties: Object.freeze({
        customer_name: Object.freeze({ type: 'string' }),
        visit_date: Object.freeze({ type: 'string' }),
      }),
    }),
  })]),
});

function decisionJson(value) {
  const externalDecision = ({
    answer: 'RESPONSE', action: 'TOOL', clarify: 'CLARIFY', no_match: 'NO_MATCH',
  })[value.decision] ?? value.decision;
  return JSON.stringify({
    responseId: null,
    clarification: ['clarify', 'CLARIFY'].includes(value.decision)
      ? { reason: 'ambiguous_request' } : null,
    ...value,
    decision: externalDecision,
  });
}

const contract = groundedDecisionContract(envelope, runtime);
const jsonSchema = groundedDecisionJsonSchema(envelope, runtime);
assert.deepEqual(contract.exactFields, [
  'decision', 'answer', 'responseId', 'evidenceIds', 'toolName',
  'toolArguments', 'clarificationReason',
]);
assert.deepEqual(contract.allowedEvidenceIds, ['source_1', 'source_2']);
assert.equal(contract.configuredToolSchemas[0].name, 'create_visit');
assert.equal(jsonSchema.additionalProperties, false);
assert.deepEqual(jsonSchema.required, contract.exactFields);
assert.deepEqual(jsonSchema.properties.decision.enum.sort(), ['CLARIFY', 'NO_MATCH', 'RESPONSE', 'TOOL']);

const noMatch = validateGroundedLlmDecision(JSON.stringify({
  decision: 'NO_MATCH', answer: '', responseId: null, evidenceIds: [],
  toolName: null, toolArguments: null, clarificationReason: null,
}), envelope, runtime);
assert.equal(noMatch.valid, true);
assert.equal(noMatch.decision, 'no_match');
assert.deepEqual(noMatch.evidenceIds, []);
assert.equal(noMatch.answer, '');

const invalidNoMatchSpeech = validateGroundedLlmDecision(JSON.stringify({
  decision: 'NO_MATCH', answer: 'The price is 3200.', responseId: null,
  evidenceIds: ['source_1'], toolName: null, toolArguments: null,
  clarificationReason: null,
}), envelope, runtime);
assert.equal(invalidNoMatchSpeech.valid, false);
assert.equal(invalidNoMatchSpeech.reason, 'invalid_response_shape');
assert.equal(invalidNoMatchSpeech.structuralDiagnostic.parsed, true);
assert.equal(invalidNoMatchSpeech.structuralDiagnostic.normalizedDecision, 'no_match');
assert.equal(JSON.stringify(invalidNoMatchSpeech.structuralDiagnostic).includes('3200'), false,
  'Structural diagnostics must not contain provider answer values');

const providerParsedAliasResponse = validateGroundedLlmDecision({
  output_parsed: {
    decision_type: 'RESPONSE',
    response_text: 'Premium service costs INR 3200.',
    response_id: null,
    evidence_ids: ['source_1'],
    state_update: {},
    pending_question: null,
  },
}, envelope, runtime);
assert.equal(providerParsedAliasResponse.valid, true);
assert.equal(providerParsedAliasResponse.decision, 'answer');
assert.deepEqual(providerParsedAliasResponse.evidenceIds, ['source_1']);

const providerObjectTool = validateGroundedLlmDecision({
  decision: 'TOOL_CALL', answer: '', responseId: null, evidenceIds: ['source_1'],
  tool_name: 'create_visit',
  tool_arguments: { customer_name: 'Asha', visit_date: '2026-09-03' },
  clarification_reason: null,
  state_update: {
    collectedInformation: { customer_name: 'Asha', visit_date: '2026-09-03' },
    activeToolRequest: { name: 'create_visit' },
  },
}, envelope, runtime);
assert.equal(providerObjectTool.valid, false);
assert.equal(providerObjectTool.reason, 'invalid_decision');
for (const unsupportedDecision of [
  'ANSWER', 'ACTION', 'TOOL_CALL', 'response', 'tool', 'clarify', 'no_match',
]) {
  const rejected = validateGroundedLlmDecision(JSON.stringify({
    decision: unsupportedDecision,
    answer: '', responseId: null, evidenceIds: [],
    toolName: null, toolArguments: null, clarificationReason: null,
  }), envelope, runtime);
  assert.equal(rejected.valid, false, `${unsupportedDecision} must be rejected`);
  assert.equal(rejected.reason, 'invalid_decision');
}

const phoneticClarificationRuntime = {
  ...runtime,
  clarificationContext: {
    genuineAmbiguity: false,
    candidates: [{
      canonicalName: 'Published Gamma Service',
      confidenceBand: 'MEDIUM',
      recordId: 'published-gamma-service',
    }],
    ambiguityCandidates: [],
  },
};
const recoveredInvalidJsonClarification = validateGroundedLlmDecision(
  'provider returned malformed output', envelope, phoneticClarificationRuntime,
);
assert.equal(recoveredInvalidJsonClarification.valid, true);
assert.equal(recoveredInvalidJsonClarification.decision, 'clarify');
assert.match(recoveredInvalidJsonClarification.pendingQuestion, /Published Gamma Service/u);
assert.equal(recoveredInvalidJsonClarification.clarification.reason, 'ambiguous_request');

const recoveredInvalidShapeClarification = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', unexpectedProviderField: true,
}), envelope, phoneticClarificationRuntime);
assert.equal(recoveredInvalidShapeClarification.valid, true);
assert.equal(recoveredInvalidShapeClarification.decision, 'clarify');
assert.match(recoveredInvalidShapeClarification.pendingQuestion, /Published Gamma Service/u);

const unrecoverableInvalidJson = validateGroundedLlmDecision(
  'provider returned malformed output', envelope, runtime,
);
assert.equal(unrecoverableInvalidJson.valid, false);
assert.equal(unrecoverableInvalidJson.reason, 'invalid_json');

const uncitedFactualResponse = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'The office is on Central Road.',
  responseId: null, evidenceIds: [], toolName: null,
  toolArguments: null, clarificationReason: null,
}), envelope, runtime);
assert.equal(uncitedFactualResponse.valid, false);
assert.equal(uncitedFactualResponse.reason, 'selected_evidence_ids_required');

const compactResponse = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'The office is on Central Road.',
  responseId: null, evidenceIds: ['source_2'], toolName: null,
  toolArguments: null, clarificationReason: null,
}), envelope, runtime);
assert.equal(compactResponse.valid, true);

const compactClarification = validateGroundedLlmDecision(JSON.stringify({
  decision: 'CLARIFY', answer: 'Which published service do you mean?',
  responseId: null, evidenceIds: [], toolName: null,
  toolArguments: null, clarificationReason: 'missing_entity',
}), envelope, {
  ...runtime, clarificationContext: { requestedFact: 'price', canonicalMemory: {} },
});
assert.equal(compactClarification.valid, true);
assert.equal(compactClarification.pendingQuestion, 'Which published service do you mean?');

const malformedCompactTool = validateGroundedLlmDecision(JSON.stringify({
  decision: 'TOOL', answer: '', responseId: null, evidenceIds: [],
  toolName: 'create_visit', toolArguments: '{', clarificationReason: null,
}), envelope, runtime);
assert.equal(malformedCompactTool.valid, false);
assert.equal(malformedCompactTool.reason, 'invalid_response_shape');
const compactTool = validateGroundedLlmDecision(JSON.stringify({
  decision: 'TOOL', answer: '', responseId: null, evidenceIds: [],
  toolName: 'create_visit',
  toolArguments: JSON.stringify({ customer_name: 'Asha', visit_date: '2030-04-05' }),
  clarificationReason: null,
}), envelope, runtime);
assert.equal(compactTool.valid, true);
assert.equal(compactTool.toolRequest.name, 'create_visit');
assert.deepEqual(compactTool.toolRequest.arguments, {
  customer_name: 'Asha', visit_date: '2030-04-05',
});

const responseWithToolFields = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'The office is on Central Road.',
  responseId: null, evidenceIds: ['source_2'], toolName: 'create_visit',
  toolArguments: JSON.stringify({ customer_name: 'Asha', visit_date: '2030-04-05' }),
  clarificationReason: null,
}), envelope, runtime);
assert.equal(responseWithToolFields.valid, true);
assert.equal(responseWithToolFields.toolRequest, null,
  'unused TOOL fields must be discarded from a valid RESPONSE');

const toolWithCallerSpeech = validateGroundedLlmDecision(JSON.stringify({
  decision: 'TOOL', answer: 'Your visit is booked.', responseId: null, evidenceIds: [],
  toolName: 'create_visit',
  toolArguments: JSON.stringify({ customer_name: 'Asha', visit_date: '2030-04-05' }),
  clarificationReason: null,
}), envelope, runtime);
assert.equal(toolWithCallerSpeech.valid, true);
assert.equal(toolWithCallerSpeech.answer, '',
  'unverified caller speech must be discarded from a TOOL decision');

const clarifyWithStaleEvidence = validateGroundedLlmDecision(JSON.stringify({
  decision: 'CLARIFY', answer: 'Which published service do you mean?',
  responseId: null, evidenceIds: ['source_1'], toolName: null,
  toolArguments: null, clarificationReason: 'missing_entity',
}), envelope, runtime);
assert.equal(clarifyWithStaleEvidence.valid, true);
assert.deepEqual(clarifyWithStaleEvidence.evidenceIds, [],
  'unused evidence must be discarded from a fact-free CLARIFY decision');
assert.doesNotThrow(() => assertGroundedStructuredCompletion(
  { type: 'completed', finishReason: 'stop' }, JSON.stringify({
    decision: 'RESPONSE', answer: 'Grounded.', responseId: null,
    evidenceIds: [], toolName: null, toolArguments: null,
    clarificationReason: null,
  }),
));
assert.throws(
  () => assertGroundedStructuredCompletion({ type: 'completed', finishReason: 'length' }, '{}'),
  (error) => error.code === 'LLM_STRUCTURED_OUTPUT_TRUNCATED',
);
assert.throws(
  () => assertGroundedStructuredCompletion({ type: 'completed', finishReason: 'stop' }, '{'),
  (error) => error.code === 'LLM_STRUCTURED_OUTPUT_INVALID_JSON',
);
assert.throws(
  () => assertGroundedStructuredCompletion({ finishReason: 'stop' }, '{}'),
  (error) => error.code === 'LLM_STRUCTURED_OUTPUT_INCOMPLETE',
);

const emptyStateOrdinaryAnswer = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(emptyStateOrdinaryAnswer.valid, true);
assert.equal(emptyStateOrdinaryAnswer.currentTopic, null);
assert.deepEqual(emptyStateOrdinaryAnswer.selectedEntityKeys, []);
assert.deepEqual(emptyStateOrdinaryAnswer.fieldUpdates, {});
assert.equal(emptyStateOrdinaryAnswer.requestType, undefined);

const translatedAliasSelection = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: { knownEntityKeys: ['Translated premium name'] },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(translatedAliasSelection.valid, true);
assert.deepEqual(translatedAliasSelection.selectedEntityKeys, ['premium-service'],
  'A published translated alias must canonicalize instead of being rejected');

const answerWithStaleClarificationMetadata = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
  clarification: { reason: 'ambiguous_request' },
}), envelope, runtime);
assert.equal(answerWithStaleClarificationMetadata.valid, true);
assert.equal(answerWithStaleClarificationMetadata.clarification, null,
  'inert clarification metadata must not reject an otherwise grounded answer');

const answerEndingWithQuestion = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE',
  answer: 'Available options are Standard and Premium. Which option would you like?',
  evidenceIds: ['source_1'], stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), {
  ...envelope,
  sources: [{
    ...envelope.sources[0],
    content: 'Available options are Standard and Premium. Which option would you like?',
  }],
}, runtime);
assert.equal(answerEndingWithQuestion.valid, true);
assert.equal(
  answerEndingWithQuestion.answer,
  'Available options are Standard and Premium. Which option would you like?',
);

const exactEnvelope = Object.freeze({
  ...envelope,
  exactCallerResponses: Object.freeze(['source_1']),
  sources: Object.freeze([Object.freeze({
    ...envelope.sources[0], exactCallerResponse: true,
  })]),
});
const exactPublishedResponse = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'Model-authored wording that must never be spoken.',
  responseId: 'source_1', evidenceIds: ['source_1'], stateUpdate: {},
  pendingQuestion: null, toolRequest: null, clarification: null,
}), exactEnvelope, runtime);
assert.equal(exactPublishedResponse.valid, true);
assert.equal(exactPublishedResponse.responseId, 'source_1');
assert.equal(exactPublishedResponse.answer, envelope.sources[0].content);
const exactResponseIdIsEvidenceSelection = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'Provider wording is ignored.',
  responseId: 'source_1', evidenceIds: [], stateUpdate: {},
  pendingQuestion: null, toolRequest: null, clarification: null,
}), exactEnvelope, runtime);
assert.equal(exactResponseIdIsEvidenceSelection.valid, true);
assert.deepEqual(exactResponseIdIsEvidenceSelection.evidenceIds, ['source_1']);

const selectedEvidenceAlias = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', responseId: null,
  selectedEvidenceIds: ['source_2'], stateUpdate: {}, pendingQuestion: null,
  toolRequest: null, clarification: null,
}), envelope, runtime);
assert.equal(selectedEvidenceAlias.valid, true);
assert.deepEqual(selectedEvidenceAlias.evidenceIds, ['source_2']);

const authoritativeDecimalPrice = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3,200.00.',
  evidenceIds: ['source_price'], stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), {
  found: true, entities: [], sources: [{
    id: 'source_price', publishedEvidenceId: 'published-price', recordId: 'price-record',
    content: 'Approved Premium service.', authoritativeData: { price: 3200, currency: 'INR' },
  }],
}, runtime);
assert.equal(authoritativeDecimalPrice.valid, true,
  'formatted published prices must validate against complete authoritative fields');
const missingExactResponseId = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: envelope.sources[0].content,
  evidenceIds: ['source_1'], stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), exactEnvelope, runtime);
assert.equal(missingExactResponseId.valid, false);
assert.equal(missingExactResponseId.reason, 'response_id_required');

const mixedExactEnvelope = Object.freeze({
  ...exactEnvelope,
  sources: Object.freeze([
    ...exactEnvelope.sources,
    Object.freeze({
      id: 'source_2', recordId: 'catalog-record', recordType: 'CATALOG_ITEM',
      content: 'Current Item includes complete approved attributes.',
      exactCallerResponse: false,
      authoritativeData: { itemKey: 'current-item', name: 'Current Item' },
    }),
  ]),
});
const catalogAnswerWithUnrelatedExactAlternative = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Current Item includes complete approved attributes.',
  evidenceIds: ['source_1', 'source_2'], responseId: null,
  stateUpdate: { requestType: 'item_details' }, pendingQuestion: null, toolRequest: null,
}), mixedExactEnvelope, runtime);
assert.equal(catalogAnswerWithUnrelatedExactAlternative.valid, true);

const genericMeaning = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: {
    requestType: 'item_details', currentTopic: 'premium service',
    knownEntityKeys: ['premium-service'], requestedFacts: ['price', 'included support'],
    constraints: ['this week'], contextualReferences: ['that service'],
    contextDependent: true, collectedInformation: {}, correctedFields: [],
  },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(genericMeaning.valid, true);
assert.equal(genericMeaning.requestType, 'item_details');
assert.deepEqual(genericMeaning.requestedFacts, ['price', 'included support']);
assert.deepEqual(genericMeaning.constraints, ['this week']);
assert.deepEqual(genericMeaning.contextualReferences, ['that service']);
assert.equal(genericMeaning.contextDependent, true);

const runtimeRequiredCatalogEvidence = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_2'],
  stateUpdate: { contextDependent: true }, pendingQuestion: null, toolRequest: null,
}), envelope, { ...runtime, requiredEvidenceIds: ['source_1'] });
assert.equal(runtimeRequiredCatalogEvidence.valid, true);
assert.deepEqual(runtimeRequiredCatalogEvidence.evidenceIds, ['source_1', 'source_2'],
  'runtime-required canonical evidence must take priority over model-selected evidence');

const invalidMeaning = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: { requestType: 'NOT VALID!' }, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(invalidMeaning.valid, true);
assert.deepEqual(invalidMeaning.stateUpdate.knownEntityKeys, []);
assert.equal(invalidMeaning.requestType, undefined);

const invalidStateField = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: { internalStage: 'hidden' }, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(invalidStateField.valid, true);
assert.deepEqual(invalidStateField.stateUpdate.knownEntityKeys, []);

const invalidClarificationState = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [],
  stateUpdate: { internalStage: 'hidden' },
  pendingQuestion: 'Which option did you mean?', toolRequest: null,
}), envelope, runtime);
assert.equal(invalidClarificationState.valid, true,
  'invalid optional memory metadata must not discard a safe clarification');
assert.deepEqual(invalidClarificationState.stateUpdate.knownEntityKeys, []);

const partiallyRecoverableState = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: {
    knownEntityKeys: ['not-published'], pendingQuestionRelevant: false,
    currentTopic: 'office location', requestType: 'location_details',
  },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(partiallyRecoverableState.valid, true);
assert.equal(partiallyRecoverableState.pendingQuestionRelevant, false);
assert.equal(partiallyRecoverableState.currentTopic, 'office location');
assert.equal(partiallyRecoverableState.requestType, 'location_details');
assert.deepEqual(partiallyRecoverableState.selectedEntityKeys, []);

const invalidActionState = validateGroundedLlmDecision(decisionJson({
  decision: 'TOOL', answer: '', evidenceIds: [], stateUpdate: { internalStage: 'hidden' },
  pendingQuestion: null,
  toolRequest: { name: 'create_visit', arguments: { customer_name: 'Ravi', visit_date: '2026-08-20' } },
}), envelope, runtime);
assert.equal(invalidActionState.valid, false);
assert.equal(invalidActionState.reason, 'invalid_state_update');

const invalidJsonTamil = validateGroundedLlmDecision('Premium service பற்றி சொல்லுங்க', envelope, runtime);
assert.equal(invalidJsonTamil.reason, 'invalid_json');

const missingShapeTanglish = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'Premium service INR 3200 irukku.', evidenceIds: ['source_1'],
}), envelope, runtime);
assert.equal(missingShapeTanglish.valid, true,
  'safe omitted null fields must be normalized before strict semantic validation');

const topLevelRequestType = validateGroundedLlmDecision(JSON.stringify({
  decision: 'RESPONSE', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  requestType: 'side_question',
}), envelope, runtime);
assert.equal(topLevelRequestType.valid, true);
assert.equal(topLevelRequestType.requestType, 'side_question');

const missingAnswerTamil = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: '', evidenceIds: ['source_1'], stateUpdate: {},
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(missingAnswerTamil.reason, 'answer_required');

const tamil = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE',
  answer: 'Premium service விலை INR 3200.',
  evidenceIds: ['source_1'],
  stateUpdate: {
    currentTopic: 'premium service', knownEntityKeys: ['premium-service'],
    collectedInformation: {}, correctedFields: [], language: 'ta', pendingQuestionRelevant: false,
  },
  pendingQuestion: null,
  toolRequest: null,
}), envelope, runtime);
assert.equal(tamil.valid, true);
assert.equal(tamil.decision, 'answer');
assert.equal(tamil.answer, 'Premium service விலை INR 3200.');
assert.deepEqual(tamil.evidenceIds, ['source_1']);

for (const answer of [
  'Premium service costs INR 3200.',
  'Premium service INR 3200 irukku.',
  'Premium service விலை INR 3200.',
]) {
  const result = validateGroundedLlmDecision(decisionJson({
    decision: 'RESPONSE', answer, evidenceIds: ['source_1'],
    stateUpdate: { currentTopic: 'premium service', knownEntityKeys: ['premium-service'], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }), envelope, runtime);
  assert.equal(result.valid, true, `natural multilingual answer should validate: ${answer}`);
}

const clarification = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: 'I need one detail.', evidenceIds: [],
  stateUpdate: { currentTopic: 'service choice', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service do you mean?', toolRequest: null,
}), envelope, runtime);
assert.equal(clarification.valid, true);
assert.equal(clarification.pendingQuestion, 'Which service do you mean?');
const clarificationWithoutReason = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [], stateUpdate: {},
  pendingQuestion: 'Which service do you mean?', toolRequest: null, clarification: null,
}), envelope, runtime);
assert.equal(clarificationWithoutReason.valid, true);
assert.equal(clarificationWithoutReason.clarification.reason, 'missing_evidence');

const missingEntityClarification = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [], stateUpdate: {},
  pendingQuestion: 'Which published service do you mean?', toolRequest: null,
  clarification: { reason: 'missing_entity' },
}), envelope, {
  ...runtime,
  clarificationContext: {
    requestedFact: 'price',
    canonicalMemory: { activeEntity: null, activeCategory: null },
    ambiguityCandidates: [],
  },
});
assert.equal(missingEntityClarification.valid, true);
assert.equal(missingEntityClarification.clarification.reason, 'missing_entity');

const missingFactClarification = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [], stateUpdate: {},
  pendingQuestion: 'What would you like to know about Premium service?', toolRequest: null,
  clarification: { reason: 'missing_fact' },
}), envelope, {
  ...runtime,
  clarificationContext: {
    requestedFact: null,
    canonicalMemory: {
      activeEntity: { recordId: 'record-1', name: 'Premium service' },
      activeCategory: null,
    },
    ambiguityCandidates: [],
  },
});
assert.equal(missingFactClarification.valid, true);
assert.equal(missingFactClarification.clarification.reason, 'missing_fact');

const authoritativeAmbiguity = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [], stateUpdate: {},
  pendingQuestion: 'Do you mean Premium service or Standard service?', toolRequest: null,
  clarification: { reason: 'authoritative_ambiguity' },
}), envelope, {
  ...runtime,
  clarificationContext: {
    requestedFact: 'details',
    canonicalMemory: {},
    ambiguityCandidates: [
      { recordId: 'record-1', name: 'Premium service' },
      { recordId: 'record-3', name: 'Standard service' },
    ],
  },
});
assert.equal(authoritativeAmbiguity.valid, true);
assert.equal(authoritativeAmbiguity.clarification.reason, 'authoritative_ambiguity');

const forcedPhoneticClarification = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service is selected.', evidenceIds: ['source_1'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), envelope, {
  ...runtime,
  clarificationContext: {
    genuineAmbiguity: true,
    ambiguityCandidates: [
      { recordId: 'record-1', name: 'Premium service' },
      { recordId: 'record-3', name: 'Standard service' },
    ],
  },
});
assert.equal(forcedPhoneticClarification.valid, true);
assert.equal(forcedPhoneticClarification.decision, 'clarify');
assert.equal(forcedPhoneticClarification.clarification.reason, 'authoritative_ambiguity');
assert.match(forcedPhoneticClarification.pendingQuestion, /Premium service/u);
assert.match(forcedPhoneticClarification.pendingQuestion, /Standard service/u);

const multipleClarifications = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: 'Which service? Which location?', evidenceIds: [],
  stateUpdate: { currentTopic: 'clarification', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service?', toolRequest: null,
}), envelope, runtime);
assert.equal(multipleClarifications.valid, true);
assert.equal(multipleClarifications.answer, '');
assert.equal(multipleClarifications.pendingQuestion, 'Which service?');

const rollingStateAliases = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: {
    currentTopic: 'premium service', selectedEntityKeys: ['premium-service'],
    fieldUpdates: {}, correctedFields: [], pendingQuestionRelevant: false,
  },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(rollingStateAliases.valid, true);
assert.deepEqual(rollingStateAliases.selectedEntityKeys, ['premium-service']);

const missingActionField = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: 'I need the visit date.', evidenceIds: [],
  stateUpdate: {
    currentTopic: 'visit booking', knownEntityKeys: [], collectedInformation: {}, correctedFields: [],
    activeToolRequest: { name: 'create_visit' },
  },
  pendingQuestion: 'Which date do you prefer?', toolRequest: null,
}), envelope, runtime);
assert.equal(missingActionField.valid, true);
assert.equal(missingActionField.activeToolRequest.name, 'create_visit');

const partialActionField = validateGroundedLlmDecision(decisionJson({
  decision: 'CLARIFY', answer: '', evidenceIds: [],
  stateUpdate: {
    currentTopic: 'visit booking', knownEntityKeys: [],
    collectedInformation: { contact_number: '96' }, correctedFields: [],
    activeToolRequest: { name: 'create_visit' },
  },
  pendingQuestion: 'Please provide the complete contact number.', toolRequest: null,
}), envelope, {
  ...runtime,
  fieldSchemas: [{
    key: 'contact_number', type: 'phone', required: true, requiredAction: 'create_visit',
  }],
});
assert.equal(partialActionField.valid, true);
assert.deepEqual(partialActionField.fieldUpdates, {});

const action = validateGroundedLlmDecision(decisionJson({
  decision: 'TOOL', answer: '', evidenceIds: [],
  stateUpdate: {
    currentTopic: 'visit booking', knownEntityKeys: [],
    collectedInformation: { customer_name: 'Ravi', visit_date: '2026-08-20' },
    correctedFields: [], language: 'en', pendingQuestionRelevant: false,
    activeToolRequest: { name: 'create_visit' },
  },
  pendingQuestion: null,
  toolRequest: { name: 'create_visit', arguments: { customer_name: 'Ravi', visit_date: '2026-08-20' } },
}), envelope, runtime);
assert.equal(action.valid, true);
assert.equal(action.toolRequest.name, 'create_visit');
assert.deepEqual(action.fieldUpdates, { customer_name: 'Ravi', visit_date: '2026-08-20' });

const unknownTool = validateGroundedLlmDecision(decisionJson({
  decision: 'TOOL', answer: '', evidenceIds: [],
  stateUpdate: { currentTopic: 'action', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: { name: 'invented_tool', arguments: {} },
}), envelope, runtime);
assert.equal(unknownTool.valid, false);
assert.equal(unknownTool.reason, 'invalid_tool_request');

const internal = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'JSON: {"toolRequest":null}', evidenceIds: ['source_1'],
  stateUpdate: { currentTopic: 'debug', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(internal.valid, false);
assert.equal(internal.reason, 'internal_text');

const extraInternalField = validateGroundedLlmDecision(decisionJson({
  decision: 'RESPONSE', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: { currentTopic: 'premium service', knownEntityKeys: ['premium-service'], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null, reasoning: 'hidden',
}), envelope, runtime);
assert.equal(extraInternalField.valid, false);
assert.equal(extraInternalField.reason, 'invalid_response_shape');

const decoder = createGroundedDecisionStreamDecoder(envelope);
assert.equal(decoder.push('{"evidenceIds":["source_1"],"stateUpdate":{},').delta, '');
assert.equal(decoder.push('"decision":"RESPONSE","answer":"Premium service costs INR 3200.').delta,
  '');
assert.equal(decoder.push('","responseId":null,"pendingQuestion":null,"clarification":null,"toolRequest":null}').delta, '');

const agentRuntimeSource = readFileSync(new URL('../src/agents/agent-runtime.service.js', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../src/voice/providers/llm/llm-response.service.js', import.meta.url), 'utf8');
const orchestratorSource = readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
assert.match(agentRuntimeSource, /groundedDecisionContract/u);
assert.match(agentRuntimeSource, /Answer the latest caller question first/u);
assert.match(providerSource, /tools:\s*groundedResponseMode\s*\?\s*\[\]\s*:\s*assignedTools/u);
assert.match(providerSource, /responseFormat:\s*\{\s*type:\s*'json_schema'/u);
assert.match(providerSource, /schema:\s*responseSchema/u);
assert.doesNotMatch(providerSource, /createMeaningResolutionLlmStream/u);
assert.doesNotMatch(orchestratorSource, /resolvePreRetrievalMeaning|pre_retrieval_meaning/u);
assert.match(orchestratorSource, /#knowledge\(query, retrievalAbortController\.signal\)/u);
const ordinaryTurn = orchestratorSource.slice(
  orchestratorSource.indexOf('const latencyResult = await awaitLlmWithSafeLatency(this.#llm(query, history, knowledge'),
  orchestratorSource.indexOf('if (response.toolCalls.length)'),
);
assert.equal((ordinaryTurn.match(/this\.#llm\(/gu) ?? []).length, 1);
assert.match(orchestratorSource, /grounded\.decision === 'action'/u);
assert.match(orchestratorSource, /llm\.native_tool_events_rejected/u);
assert.doesNotMatch(orchestratorSource, /return \{ toolCalls: providerToolCalls/u);
assert.doesNotMatch(orchestratorSource, /streaming\.onSentence\?\.\(text\)/u);

let providerRequests = 0;
let providerInput;
const adapter = {
  stream(input) {
    providerRequests += 1;
    providerInput = input;
    return (async function* events() {
      yield { type: 'completed', toolCalls: [], usage: {} };
    }());
  },
  cancel() {}, close() {},
};
const session = await createSelectedLlmStream({
  agent: {
    id: 'agent-1', name: 'Universal Agent', description: '', goal: 'Answer the latest question',
    language: 'Tamil', prompt: 'Speak naturally.', temperature: 0, settings: {},
  },
  providers: { llm: { providerId: 'provider-1', providerName: 'test', modelId: 'model-1', modelKey: 'test-model' } },
  tools: [{
    id: 'tool-1', name: 'create_visit', description: 'Create a visit',
    configuration: { inputSchema: runtime.toolSchemas[0].inputSchema },
  }],
}, {
  callId: 'call-1', query: 'நாளைக்கு appointment book பண்ணுங்க', history: [], usageDirection: 'inbound',
  knowledge: { found: true, route: 'semantic', content: envelope.sources[0].content },
  context: {
    groundedResponseMode: true,
    groundingEnvelope: envelope,
    configuredInformationFields: runtime.fieldSchemas,
    groundedDecisionInput: {
      currentQuestion: 'Book the selected published option.',
      recentRelevantTurns: [
        { role: 'user', content: 'Tell me about the published option.' },
        { role: 'assistant', content: 'It is available in the verified catalog.' },
      ],
      canonicalMemory: {
        activeEntity: { recordId: 'record-1', name: 'Published option' },
      },
      hydratedRecords: envelope.sources.map((source) => ({
        sourceId: source.id, recordId: source.recordId,
        recordType: 'CATALOG_ITEM', content: source.content,
      })),
      workflowAuthorization: [{ workflowEvidenceId: 'workflow-1', toolName: 'create_visit' }],
      toolSchemas: runtime.toolSchemas,
    },
  },
}, { adapter, skipDefaultRegistration: true });
for await (const _event of session.events) { /* consume the single provider stream */ }
await session.close();
assert.equal(providerRequests, 1);
assert.equal(session.groundedEnvelopeVersion, 1);
assert.equal(session.groundedEvidenceRecords, 2);
assert.equal(session.groundedAuthorizedTools, 1);
assert.equal(session.groundedContextMessages, 2);
assert.deepEqual(providerInput.tools, []);
assert.equal(providerInput.messages.at(-1).content, 'Book the selected published option.');
assert.equal(providerInput.responseFormat.type, 'json_schema');
assert.equal(providerInput.responseFormat.name, 'grounded_voice_decision');
assert.equal(providerInput.responseFormat.strict, true);
assert.equal(providerInput.responseFormat.schema.additionalProperties, false);
assert.deepEqual(providerInput.responseFormat.schema.required, contract.exactFields);
assert.match(providerInput.messages[0].content, /"toolArguments"/u);
assert.match(providerInput.messages[0].content, /"create_visit"/u);
assert.match(providerInput.messages[0].content, /"Published option"/u);
assert.match(providerInput.messages[0].content, /"Tell me about the published option\."/u);
assert.ok(providerInput.messages[0].content.length <= 12_000);
assert.match(providerInput.messages[0].content, /<\/grounded_response_contract>/u);
assert.equal(isRepairableGroundedDecisionReason('invalid_response_shape'), true);
assert.equal(isRepairableGroundedDecisionReason('invalid_clarification'), true);
assert.equal(isRepairableGroundedDecisionReason('answer_required'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_numeric_fact'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_structured_fact'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_technical_term'), true);
assert.equal(isRepairableGroundedDecisionReason('authoritative_ambiguity'), true);
assert.equal(isRepairableGroundedDecisionReason('invalid_json'), true);
assert.equal(isOperationalGroundedDecisionFailure('invalid_json'), true);
assert.equal(isOperationalGroundedDecisionFailure('invalid_response_shape'), true);
assert.equal(isOperationalGroundedDecisionFailure('unsupported_numeric_fact'), false);
assert.equal(isOperationalGroundedDecisionFailure('unsupported_entity'), false);
assert.doesNotMatch(orchestratorSource, /stage: 'llm\.decision_repair_retry'/u);
assert.doesNotMatch(orchestratorSource, /stage: 'llm\.retry'/u);
assert.match(orchestratorSource, /deferDecisionRepair: false/u);
const toolExecutionBlock = orchestratorSource.slice(
  orchestratorSource.indexOf('if (response.toolCalls.length) {'),
  orchestratorSource.indexOf('if (response.cancelled || epoch !== this.epoch || this.finalized)'),
);
assert.equal((toolExecutionBlock.match(/this\.#llm\(/gu) ?? []).length, 0,
  'Verified tool execution must not trigger a second LLM request');

console.log('One grounded LLM decision verification passed.');
