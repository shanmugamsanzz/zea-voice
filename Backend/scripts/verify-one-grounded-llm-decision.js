import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createGroundedDecisionStreamDecoder,
  groundedDecisionContract,
  groundedDecisionJsonSchema,
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

const contract = groundedDecisionContract(envelope, runtime);
const jsonSchema = groundedDecisionJsonSchema(envelope, runtime);
assert.deepEqual(contract.exactFields, [
  'decision', 'answer', 'evidenceIds', 'stateUpdate', 'pendingQuestion', 'toolRequest',
]);
assert.deepEqual(contract.allowedEvidenceIds, ['source_1', 'source_2']);
assert.equal(contract.configuredToolSchemas[0].name, 'create_visit');
assert.equal(jsonSchema.additionalProperties, false);
assert.deepEqual(jsonSchema.required, contract.exactFields);
assert.deepEqual(jsonSchema.properties.decision.enum.sort(), ['action', 'answer', 'clarify']);

const emptyStateOrdinaryAnswer = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(emptyStateOrdinaryAnswer.valid, true);
assert.equal(emptyStateOrdinaryAnswer.currentTopic, null);
assert.deepEqual(emptyStateOrdinaryAnswer.selectedEntityKeys, []);
assert.deepEqual(emptyStateOrdinaryAnswer.fieldUpdates, {});

const invalidStateField = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source_2'],
  stateUpdate: { internalStage: 'hidden' }, pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(invalidStateField.valid, false);
assert.equal(invalidStateField.reason, 'invalid_state_update');

const invalidJsonTamil = validateGroundedLlmDecision('Premium service பற்றி சொல்லுங்க', envelope, runtime);
assert.equal(invalidJsonTamil.reason, 'invalid_json');

const missingShapeTanglish = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'Premium service INR 3200 irukku.', evidenceIds: ['source_1'],
}), envelope, runtime);
assert.equal(missingShapeTanglish.reason, 'invalid_response_shape');

const missingAnswerTamil = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: '', evidenceIds: ['source_1'], stateUpdate: {},
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(missingAnswerTamil.reason, 'answer_required');

const tamil = validateGroundedLlmDecision(JSON.stringify({
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
  const result = validateGroundedLlmDecision(JSON.stringify({
    decision: 'answer', answer, evidenceIds: ['source_1'],
    stateUpdate: { currentTopic: 'premium service', knownEntityKeys: ['premium-service'], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }), envelope, runtime);
  assert.equal(result.valid, true, `natural multilingual answer should validate: ${answer}`);
}

const clarification = validateGroundedLlmDecision(JSON.stringify({
  decision: 'clarify', answer: 'I need one detail.', evidenceIds: [],
  stateUpdate: { currentTopic: 'service choice', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service do you mean?', toolRequest: null,
}), envelope, runtime);
assert.equal(clarification.valid, true);
assert.equal(clarification.pendingQuestion, 'Which service do you mean?');

const multipleClarifications = validateGroundedLlmDecision(JSON.stringify({
  decision: 'clarify', answer: 'Which service? Which location?', evidenceIds: [],
  stateUpdate: { currentTopic: 'clarification', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: 'Which service?', toolRequest: null,
}), envelope, runtime);
assert.equal(multipleClarifications.valid, true);
assert.equal(multipleClarifications.answer, '');
assert.equal(multipleClarifications.pendingQuestion, 'Which service?');

const rollingStateAliases = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'Premium service costs INR 3200.', evidenceIds: ['source_1'],
  stateUpdate: {
    currentTopic: 'premium service', selectedEntityKeys: ['premium-service'],
    fieldUpdates: {}, correctedFields: [], pendingQuestionRelevant: false,
  },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(rollingStateAliases.valid, true);
assert.deepEqual(rollingStateAliases.selectedEntityKeys, ['premium-service']);

const missingActionField = validateGroundedLlmDecision(JSON.stringify({
  decision: 'clarify', answer: 'I need the visit date.', evidenceIds: [],
  stateUpdate: {
    currentTopic: 'visit booking', knownEntityKeys: [], collectedInformation: {}, correctedFields: [],
    activeToolRequest: { name: 'create_visit' },
  },
  pendingQuestion: 'Which date do you prefer?', toolRequest: null,
}), envelope, runtime);
assert.equal(missingActionField.valid, true);
assert.equal(missingActionField.activeToolRequest.name, 'create_visit');

const action = validateGroundedLlmDecision(JSON.stringify({
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

const unknownTool = validateGroundedLlmDecision(JSON.stringify({
  decision: 'action', answer: '', evidenceIds: [],
  stateUpdate: { currentTopic: 'action', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: { name: 'invented_tool', arguments: {} },
}), envelope, runtime);
assert.equal(unknownTool.valid, false);
assert.equal(unknownTool.reason, 'invalid_tool_request');

const internal = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'JSON: {"toolRequest":null}', evidenceIds: ['source_1'],
  stateUpdate: { currentTopic: 'debug', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null,
}), envelope, runtime);
assert.equal(internal.valid, false);
assert.equal(internal.reason, 'internal_text');

const extraInternalField = validateGroundedLlmDecision(JSON.stringify({
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
assert.equal(decoder.push('","pendingQuestion":null,"toolRequest":null}').delta, '');

const agentRuntimeSource = readFileSync(new URL('../src/agents/agent-runtime.service.js', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../src/voice/providers/llm/llm-response.service.js', import.meta.url), 'utf8');
const orchestratorSource = readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
assert.match(agentRuntimeSource, /groundedDecisionContract/u);
assert.match(agentRuntimeSource, /Answer the latest caller question first/u);
assert.match(providerSource, /tools:\s*groundedResponseMode\s*\?\s*\[\]\s*:\s*assignedTools/u);
assert.match(providerSource, /responseFormat:\s*\{\s*type:\s*'json_schema'/u);
assert.match(providerSource, /schema:\s*groundedDecisionJsonSchema/u);
const ordinaryTurn = orchestratorSource.slice(
  orchestratorSource.indexOf('response = await this.#llm(query, history, knowledge'),
  orchestratorSource.indexOf('if (response.toolCalls.length)'),
);
assert.equal((ordinaryTurn.match(/await this\.#llm\(/gu) ?? []).length, 1);
assert.match(orchestratorSource, /grounded\.decision === 'action'/u);
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

console.log('One grounded LLM decision verification passed.');
