import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createGroundedDecisionStreamDecoder,
  groundedDecisionContract,
  groundedDecisionJsonSchema,
  isRepairableGroundedDecisionReason,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';
import { createSelectedLlmStream } from '../src/voice/providers/llm/llm-response.service.js';

const envelope = Object.freeze({
  found: true,
  sources: Object.freeze([
    Object.freeze({ id: 'source_1', recordId: 'record-1', content: 'Premium service costs INR 3200 and includes priority support.' }),
    Object.freeze({ id: 'source_2', recordId: 'record-2', content: 'The office is on Central Road.' }),
  ]),
  entities: Object.freeze([
    Object.freeze({ id: 'item-1', key: 'premium-service', name: 'Premium service', sourceId: 'source_1' }),
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
  return JSON.stringify({
    responseId: null,
    clarification: value.decision === 'clarify' ? { reason: 'ambiguous_request' } : null,
    ...value,
  });
}

const contract = groundedDecisionContract(envelope, runtime);
const jsonSchema = groundedDecisionJsonSchema(envelope, runtime);
assert.deepEqual(contract.exactFields, [
  'decision', 'answer', 'responseId', 'evidenceIds', 'stateUpdate',
  'pendingQuestion', 'toolRequest', 'clarification',
]);
assert.deepEqual(contract.allowedEvidenceIds, ['source_1', 'source_2']);
assert.equal(contract.configuredToolSchemas[0].name, 'create_visit');
assert.equal(jsonSchema.additionalProperties, false);
assert.deepEqual(jsonSchema.required, contract.exactFields);
assert.deepEqual(jsonSchema.properties.decision.enum.sort(), ['action', 'answer', 'clarify']);

const emptyStateOrdinaryAnswer = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(emptyStateOrdinaryAnswer.valid, true);
assert.equal(emptyStateOrdinaryAnswer.currentTopic, null);
assert.deepEqual(emptyStateOrdinaryAnswer.selectedEntityKeys, []);
assert.deepEqual(emptyStateOrdinaryAnswer.fieldUpdates, {});
assert.equal(emptyStateOrdinaryAnswer.requestType, undefined);

const answerEndingWithQuestion = validateGroundedLlmDecision(decisionJson({
  decision: 'answer',
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
  decision: 'answer', answer: 'Model-authored wording that must never be spoken.',
  responseId: 'source_1', evidenceIds: ['source_1'], stateUpdate: {},
  pendingQuestion: null, toolRequest: null, clarification: null,
}), exactEnvelope, runtime);
assert.equal(exactPublishedResponse.valid, true);
assert.equal(exactPublishedResponse.responseId, 'source_1');
assert.equal(exactPublishedResponse.answer, envelope.sources[0].content);
const missingExactResponseId = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: envelope.sources[0].content,
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
  decision: 'answer', answer: 'Current Item includes complete approved attributes.',
  evidenceIds: ['source_1', 'source_2'], responseId: null,
  stateUpdate: { requestType: 'item_details' }, pendingQuestion: null, toolRequest: null,
}), mixedExactEnvelope, runtime);
assert.equal(catalogAnswerWithUnrelatedExactAlternative.valid, true);

const genericMeaning = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
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
  decision: 'answer', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_2'],
  stateUpdate: { contextDependent: true }, pendingQuestion: null, toolRequest: null,
}), envelope, { ...runtime, requiredEvidenceIds: ['source_1'] });
assert.equal(runtimeRequiredCatalogEvidence.valid, true);
assert.deepEqual(runtimeRequiredCatalogEvidence.evidenceIds, ['source_2', 'source_1']);

const invalidMeaning = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: { requestType: 'NOT VALID!' }, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(invalidMeaning.valid, true);
assert.deepEqual(invalidMeaning.stateUpdate.knownEntityKeys, []);
assert.equal(invalidMeaning.requestType, undefined);

const invalidStateField = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: { internalStage: 'hidden' }, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(invalidStateField.valid, true);
assert.deepEqual(invalidStateField.stateUpdate.knownEntityKeys, []);

const partiallyRecoverableState = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
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
  decision: 'action', answer: '', evidenceIds: [], stateUpdate: { internalStage: 'hidden' },
  pendingQuestion: null,
  toolRequest: { name: 'create_visit', arguments: { customer_name: 'Ravi', visit_date: '2026-08-20' } },
}), envelope, runtime);
assert.equal(invalidActionState.valid, false);
assert.equal(invalidActionState.reason, 'invalid_state_update');

const invalidJsonTamil = validateGroundedLlmDecision('Premium service பற்றி சொல்லுங்க', envelope, runtime);
assert.equal(invalidJsonTamil.reason, 'invalid_json');

const missingShapeTanglish = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'Premium service INR 3200 irukku.', evidenceIds: ['source_1'],
}), envelope, runtime);
assert.equal(missingShapeTanglish.valid, true,
  'safe omitted null fields must be normalized before strict semantic validation');

const topLevelRequestType = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  requestType: 'side_question',
}), envelope, runtime);
assert.equal(topLevelRequestType.valid, true);
assert.equal(topLevelRequestType.requestType, 'side_question');

const missingAnswerTamil = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: '', evidenceIds: ['source_1'], stateUpdate: {},
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(missingAnswerTamil.reason, 'answer_required');

const tamil = validateGroundedLlmDecision(decisionJson({
  decision: 'answer',
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
    decision: 'answer', answer, evidenceIds: ['source_1'],
    stateUpdate: { currentTopic: 'premium service', knownEntityKeys: ['premium-service'], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }), envelope, runtime);
  assert.equal(result.valid, true, `natural multilingual answer should validate: ${answer}`);
}

const clarification = validateGroundedLlmDecision(decisionJson({
  decision: 'clarify', answer: 'I need one detail.', evidenceIds: [],
  stateUpdate: { currentTopic: 'service choice', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service do you mean?', toolRequest: null,
}), envelope, runtime);
assert.equal(clarification.valid, true);
assert.equal(clarification.pendingQuestion, 'Which service do you mean?');

const multipleClarifications = validateGroundedLlmDecision(decisionJson({
  decision: 'clarify', answer: 'Which service? Which location?', evidenceIds: [],
  stateUpdate: { currentTopic: 'clarification', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service?', toolRequest: null,
}), envelope, runtime);
assert.equal(multipleClarifications.valid, true);
assert.equal(multipleClarifications.answer, '');
assert.equal(multipleClarifications.pendingQuestion, 'Which service?');

const rollingStateAliases = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: {
    currentTopic: 'premium service', selectedEntityKeys: ['premium-service'],
    fieldUpdates: {}, correctedFields: [], pendingQuestionRelevant: false,
  },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(rollingStateAliases.valid, true);
assert.deepEqual(rollingStateAliases.selectedEntityKeys, ['premium-service']);

const missingActionField = validateGroundedLlmDecision(decisionJson({
  decision: 'clarify', answer: 'I need the visit date.', evidenceIds: [],
  stateUpdate: {
    currentTopic: 'visit booking', knownEntityKeys: [], collectedInformation: {}, correctedFields: [],
    activeToolRequest: { name: 'create_visit' },
  },
  pendingQuestion: 'Which date do you prefer?', toolRequest: null,
}), envelope, runtime);
assert.equal(missingActionField.valid, true);
assert.equal(missingActionField.activeToolRequest.name, 'create_visit');

const action = validateGroundedLlmDecision(decisionJson({
  decision: 'action', answer: '', evidenceIds: [],
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
  decision: 'action', answer: '', evidenceIds: [],
  stateUpdate: { currentTopic: 'action', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: { name: 'invented_tool', arguments: {} },
}), envelope, runtime);
assert.equal(unknownTool.valid, false);
assert.equal(unknownTool.reason, 'invalid_tool_request');

const internal = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'JSON: {"toolRequest":null}', evidenceIds: ['source_1'],
  stateUpdate: { currentTopic: 'debug', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(internal.valid, false);
assert.equal(internal.reason, 'internal_text');

const extraInternalField = validateGroundedLlmDecision(decisionJson({
  decision: 'answer', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: { currentTopic: 'premium service', knownEntityKeys: ['premium-service'], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null, reasoning: 'hidden',
}), envelope, runtime);
assert.equal(extraInternalField.valid, false);
assert.equal(extraInternalField.reason, 'invalid_response_shape');

const decoder = createGroundedDecisionStreamDecoder(envelope);
assert.equal(decoder.push('{"evidenceIds":["source_1"],"stateUpdate":{},').delta, '');
assert.equal(decoder.push('"decision":"answer","answer":"Premium service costs INR 3200.').delta,
  '');
assert.equal(decoder.push('","responseId":null,"pendingQuestion":null,"clarification":null,"toolRequest":null}').delta, '');

const agentRuntimeSource = readFileSync(new URL('../src/agents/agent-runtime.service.js', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../src/voice/providers/llm/llm-response.service.js', import.meta.url), 'utf8');
const orchestratorSource = readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
assert.match(agentRuntimeSource, /groundedDecisionContract/u);
assert.match(agentRuntimeSource, /Answer the latest caller question first/u);
assert.match(providerSource, /tools:\s*groundedResponseMode\s*\?\s*\[\]\s*:\s*assignedTools/u);
assert.match(providerSource, /responseFormat:\s*\{\s*type:\s*'json_schema'/u);
assert.match(providerSource, /schema:\s*groundedDecisionJsonSchema/u);
assert.doesNotMatch(providerSource, /createMeaningResolutionLlmStream/u);
assert.doesNotMatch(orchestratorSource, /resolvePreRetrievalMeaning|pre_retrieval_meaning/u);
assert.match(orchestratorSource, /#knowledge\(query, retrievalAbortController\.signal\)/u);
const ordinaryTurn = orchestratorSource.slice(
  orchestratorSource.indexOf('response = await this.#llm(query, history, llmKnowledge'),
  orchestratorSource.indexOf('if (response.toolCalls.length)'),
);
assert.equal((ordinaryTurn.match(/await this\.#llm\(/gu) ?? []).length, 1);
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
  context: { groundedResponseMode: true, configuredInformationFields: runtime.fieldSchemas },
}, { adapter, skipDefaultRegistration: true });
for await (const _event of session.events) { /* consume the single provider stream */ }
await session.close();
assert.equal(providerRequests, 1);
assert.deepEqual(providerInput.tools, []);
assert.equal(providerInput.responseFormat.type, 'json_schema');
assert.equal(providerInput.responseFormat.name, 'grounded_voice_decision');
assert.equal(providerInput.responseFormat.schema.additionalProperties, false);
assert.deepEqual(providerInput.responseFormat.schema.required, contract.exactFields);
assert.match(providerInput.messages[0].content, /"toolRequest"/u);
assert.match(providerInput.messages[0].content, /"create_visit"/u);
assert.ok(providerInput.messages[0].content.length <= 12_000);
assert.match(providerInput.messages[0].content, /<\/grounded_response_contract>/u);
assert.equal(isRepairableGroundedDecisionReason('invalid_response_shape'), true);
assert.equal(isRepairableGroundedDecisionReason('answer_required'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_numeric_fact'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_structured_fact'), true);
assert.equal(isRepairableGroundedDecisionReason('unsupported_technical_term'), true);
assert.equal(isRepairableGroundedDecisionReason('invalid_json'), true);
assert.match(orchestratorSource, /stage: 'llm\.decision_repair_retry'/u);
assert.match(orchestratorSource, /deferDecisionRepair: false/u);

console.log('One grounded LLM decision verification passed.');
