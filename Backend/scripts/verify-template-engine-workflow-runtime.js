import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activateTemplateEngineWorkflow,
  advanceTemplateEngineWorkflowTurn,
  collectTemplateEngineWorkflowFields,
  createTemplateEngineWorkflowSpeechTask,
  executeAndPhraseTemplateEngineWorkflow,
  executeTemplateEngineWorkflow,
  phraseTemplateEngineWorkflowSpeech,
} from '../src/voice/interaction/template-engine-workflow-runtime.js';

const scope = Object.freeze({
  tenantId: 'tenant-a', agentId: 'agent-a',
  publications: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-a', publicationRevision: 4 }),
  ]),
});
const workflow = Object.freeze({
  recordId: 'workflow-1', recordType: 'WORKFLOW_RULE', tenantId: 'tenant-a',
  knowledgeBaseId: 'kb-a', publicationRevision: 4, published: true,
  actionType: 'configured_tool',
  actionConfig: Object.freeze({ toolIdentifier: 'create_record' }),
});
const tool = Object.freeze({
  id: 'tool-1', name: 'create_record', status: 'active', type: 'webhook_api',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false,
    required: Object.freeze(['full_name', 'quantity']),
    properties: Object.freeze({
      full_name: Object.freeze({ type: 'string', minLength: 2 }),
      quantity: Object.freeze({ type: 'integer', minimum: 1 }),
    }),
    'x-confirmation-message': 'Please confirm these details.',
  }),
});
const fields = Object.freeze([
  Object.freeze({
    key: 'full_name', label: 'Full name', type: 'text', required: true,
    requiredAction: 'create_record', question: 'Please tell me the full name.',
  }),
  Object.freeze({
    key: 'quantity', label: 'Quantity', type: 'number', required: true,
    requiredAction: 'create_record', question: 'What quantity should I use?',
  }),
]);
const toolDecision = Object.freeze({
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: Object.freeze({
    name: 'create_record',
    arguments: Object.freeze({ full_name: 'LLM invented value', quantity: 99 }),
  }),
  nextQuestion: null,
  stateUpdate: null,
});
const common = Object.freeze({
  publishedWorkflows: Object.freeze([workflow]),
  assignedTools: Object.freeze([tool]),
  informationFields: fields,
  scope,
});

const activated = activateTemplateEngineWorkflow({
  ...common, toolDecision,
  state: { activeWorkflowId: null, collectedToolFields: {}, confirmationStatus: null },
});
assert.equal(activated.state.activeWorkflowId, 'workflow-1');
assert.deepEqual(activated.state.collectedToolFields, {});
assert.equal(activated.state.confirmationStatus, 'pending_fields');
assert.equal(activated.progress.nextField.key, 'full_name');

const aliasActivated = activateTemplateEngineWorkflow({
  ...common,
  publishedWorkflows: [{
    ...workflow,
    recordId: 'workflow-alias',
    actionConfig: { toolIdentifier: 'published_action_identifier' },
  }],
  assignedTools: [{
    ...tool,
    identifiers: ['published_action_identifier'],
  }],
  toolDecision,
  state: { activeWorkflowId: null, collectedToolFields: {}, confirmationStatus: null },
});
assert.equal(aliasActivated.configuration.workflowId, 'workflow-alias',
  'A published Workflow identifier must resolve through the assigned UI tool identity set');
assert.equal(aliasActivated.configuration.tool.id, 'tool-1');

const firstTask = createTemplateEngineWorkflowSpeechTask({
  configuration: activated.configuration, state: activated.state,
});
assert.equal(firstTask.type, 'ASK_FIELD');
assert.equal(firstTask.field.key, 'full_name');
let speechCalls = 0;
const firstSpeech = await phraseTemplateEngineWorkflowSpeech({
  mainPrompt: 'Speak briefly and naturally.', task: firstTask,
}, {
  invokeStructuredLlm: async (request) => {
    speechCalls += 1;
    assert.deepEqual(request.responseFormat.schema.required, ['speech']);
    assert.equal(Object.hasOwn(request.responseFormat.schema.properties, 'success'), false);
    return { outputParsed: { speech: 'Could you tell me the full name?' } };
  },
});
assert.equal(firstSpeech.speech, 'Could you tell me the full name?');

const withName = collectTemplateEngineWorkflowFields({
  ...common, state: activated.state, candidateValues: { full_name: 'Alex Example' },
  candidateValuesVerified: true,
});
assert.deepEqual(withName.acceptedFields, ['full_name']);
assert.equal(withName.progress.nextField.key, 'quantity');
const invalidQuantity = collectTemplateEngineWorkflowFields({
  ...common, state: withName.state, candidateValues: { quantity: 'zero' },
  candidateValuesVerified: true,
});
assert.deepEqual(invalidQuantity.rejectedFields, ['quantity']);
assert.equal(invalidQuantity.progress.complete, false);
assert.throws(() => collectTemplateEngineWorkflowFields({
  ...common, state: withName.state, candidateValues: { quantity: '2' },
}), /verified caller input/u);
const complete = collectTemplateEngineWorkflowFields({
  ...common, state: invalidQuantity.state, candidateValues: { quantity: '2' },
  candidateValuesVerified: true,
});
assert.equal(complete.state.collectedToolFields.quantity, 2);
assert.equal(complete.progress.complete, true);
assert.equal(complete.state.confirmationStatus, 'awaiting_confirmation');

const confirmationTask = createTemplateEngineWorkflowSpeechTask({
  configuration: complete.configuration, state: complete.state,
});
assert.equal(confirmationTask.type, 'CONFIRM');
assert.equal(confirmationTask.values.length, 2);
assert.deepEqual(confirmationTask.values.map((entry) => entry.value), ['Alex Example', 2]);

let executions = 0;
await assert.rejects(() => executeTemplateEngineWorkflow({
  ...common, state: complete.state,
  confirmation: { accepted: false, explicit: true },
}, {
  executeAuthorizedTool: async () => { executions += 1; },
}), (error) => error.code === 'TEMPLATE_ENGINE_WORKFLOW_CONFIRMATION_REQUIRED');
assert.equal(executions, 0);
await assert.rejects(() => executeTemplateEngineWorkflow({
  ...common, state: complete.state,
  confirmation: { accepted: true, explicit: false },
}, {
  executeAuthorizedTool: async () => { executions += 1; },
}), (error) => error.code === 'TEMPLATE_ENGINE_WORKFLOW_CONFIRMATION_REQUIRED');
assert.equal(executions, 0);

const completed = await executeAndPhraseTemplateEngineWorkflow({
  ...common, mainPrompt: 'Speak briefly and naturally.',
  state: complete.state, confirmation: { accepted: true, explicit: true },
  conversationGuidance: {
    recordId: 'result-guidance',
    purpose: 'Offer one relevant continuation after a verified result.',
    nextQuestion: 'Would you like any further help?',
  },
}, {
  validateToolResultSpeechClaims: async () => ({ supported: true }),
  executeAuthorizedTool: async (request) => {
    executions += 1;
    assert.equal(request.authorizationRecordId, 'workflow-1');
    assert.deepEqual(request.arguments, { full_name: 'Alex Example', quantity: 2 });
    return { verified: true, success: true, output: { reference: 'result-1' } };
  },
  invokeStructuredLlm: async (request) => {
    speechCalls += 1;
    assert.match(request.messages[0].content, /"type":"RESULT","success":true/u);
    assert.deepEqual(request.responseFormat.schema.required, ['speech', 'nextQuestion']);
    return { outputParsed: {
      speech: 'The action was completed successfully.',
      nextQuestion: {
        question: 'Would you like any further help?', reason: 'Relevant continuation',
      },
    } };
  },
});
assert.equal(executions, 1);
assert.equal(completed.result.success, true);
assert.equal(completed.state.activeWorkflowId, null);
assert.equal(completed.state.confirmationStatus, 'executed_success');
assert.equal(completed.speech,
  'The action was completed successfully. Would you like any further help?');
assert.equal(completed.followUpValidation.accepted, true);
assert.equal(completed.nextQuestion.question, 'Would you like any further help?');
assert.equal(speechCalls, 2);

const coordinated = await advanceTemplateEngineWorkflowTurn({
  ...common, mainPrompt: 'Speak briefly and naturally.',
  state: complete.state, confirmation: { accepted: true, explicit: true },
}, {
  persistWorkflowState: async () => {},
  validateToolResultSpeechClaims: async () => ({ supported: true }),
  executeAuthorizedTool: async () => ({
    verified: true, success: false,
    output: { accepted: false }, error: { code: 'DECLINED' },
  }),
  invokeStructuredLlm: async () => ({
    outputParsed: { speech: 'The action could not be completed.', nextQuestion: null },
  }),
});
assert.equal(coordinated.status, 'FAILED');
assert.equal(coordinated.verifiedResult.verified, true);
assert.equal(coordinated.verifiedResult.success, false);
assert.equal(coordinated.state.activeWorkflowId, 'workflow-1');
assert.equal(coordinated.state.confirmationStatus, 'execution_failed');

await assert.rejects(() => executeTemplateEngineWorkflow({
  ...common, state: complete.state, confirmation: { accepted: true, explicit: true },
}, {
  executeAuthorizedTool: async () => ({ verified: false, success: true }),
}), (error) => error.code === 'TEMPLATE_ENGINE_WORKFLOW_RESULT_UNVERIFIED');
assert.throws(() => activateTemplateEngineWorkflow({
  ...common,
  toolDecision: { ...toolDecision, tool: { name: 'unassigned_action', arguments: {} } },
  state: {},
}), (error) => error.code === 'TEMPLATE_ENGINE_WORKFLOW_NOT_AUTHORIZED');

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-workflow-runtime.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false,
    `Workflow runtime contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine Workflow runtime verification passed.');
