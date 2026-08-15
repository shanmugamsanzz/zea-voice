import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
} from '../src/voice/interaction/next-question-policy.js';

const tools = [{
  id: 'tool-1',
  name: 'create_visit',
  configuration: {
    inputSchema: {
      type: 'object',
      required: ['customer_name', 'visit_date'],
      properties: {
        customer_name: { type: 'string' },
        visit_date: { type: 'string' },
      },
    },
  },
}];
const fieldSchemas = [
  {
    key: 'customer_name', required: true, requiredAction: 'create_visit',
    question: 'Please tell me your name.',
  },
  {
    key: 'visit_date', required: true, requiredAction: 'create_visit',
    question: 'Which date do you prefer?',
  },
];
const actionEvidence = [{
  recordId: 'workflow-record-1',
  authoritativeData: {
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'create_visit' },
  },
}];

function resolve(overrides = {}) {
  return resolveNextConfiguredQuestion({
    decision: {}, beforeState: {}, afterState: {}, fieldSchemas, tools,
    actionEvidence, guidanceEvidence: [], ...overrides,
  });
}

// A side question is answered first and the still-relevant saved question is
// appended exactly once.
const resumed = resolve({
  decision: { pendingQuestionRelevant: true },
  beforeState: {
    pendingQuestion: { key: 'visit_date', text: 'Which date do you prefer?', kind: 'field' },
  },
  afterState: { collectedInformation: {} },
  fieldSchemas: [], tools: [], actionEvidence: [],
});
assert.equal(resumed.source, 'redis_pending_question');
assert.equal(
  composeConfiguredTurnResponse('The office is on Central Road.', resumed),
  'The office is on Central Road. Which date do you prefer?',
);

// A topic change explicitly discards an irrelevant pending question.
const discarded = resolve({
  decision: { pendingQuestionRelevant: false },
  beforeState: {
    pendingQuestion: { key: 'visit_date', text: 'Which date do you prefer?', kind: 'field' },
  },
  afterState: { collectedInformation: {} },
  fieldSchemas: [], tools: [], actionEvidence: [],
});
assert.equal(discarded, null);

// UI schema array order is authoritative for tool-field collection.
const firstField = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: {} },
});
assert.equal(firstField.source, 'ui_tool_field_question');
assert.equal(firstField.key, 'customer_name');
assert.equal(firstField.question, 'Please tell me your name.');
assert.equal(firstField.activeToolRequest.authorizationRecordId, 'workflow-record-1');

const secondField = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: { customer_name: 'Ravi' } },
});
assert.equal(secondField.key, 'visit_date');

// Completed fields cannot be asked again, including through saved pending state.
const completed = resolve({
  decision: { activeToolRequest: { name: 'create_visit' }, pendingQuestionRelevant: true },
  beforeState: {
    pendingQuestion: { key: 'customer_name', text: 'Please tell me your name.', kind: 'field' },
  },
  afterState: { collectedInformation: { customer_name: 'Ravi', visit_date: '2026-08-20' } },
});
assert.equal(completed, null);

// A UI tool can never start field collection without published Workflow
// authorization, even if the model names the assigned tool.
const unauthorized = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: {} },
  actionEvidence: [],
});
assert.equal(unauthorized, null);

// Stored authorization permits later turns to continue without requiring the
// same Workflow record to be retrieved again.
const authorizedContinuation = resolve({
  beforeState: {
    activeToolRequest: {
      name: 'create_visit', status: 'collecting_information',
      authorizationRecordId: 'workflow-record-1',
    },
  },
  afterState: { collectedInformation: { customer_name: 'Ravi' } },
  actionEvidence: [],
});
assert.equal(authorizedContinuation.key, 'visit_date');

// Conversation Guidance is the final configured source before waiting.
const guidance = resolve({
  fieldSchemas: [], tools: [], actionEvidence: [],
  guidanceEvidence: [{
    recordId: 'guidance-record-1',
    content: 'Continue naturally.',
    authoritativeData: {
      variables: [{ key: 'nextQuestion', value: 'Would you like to continue?' }],
    },
  }],
});
assert.equal(guidance.source, 'conversation_guidance');
assert.equal(guidance.question, 'Would you like to continue?');

// With no configured source, the agent waits; it cannot invent a sales,
// booking, or other automatic follow-up.
const waits = resolve({ fieldSchemas: [], tools: [], actionEvidence: [], guidanceEvidence: [] });
assert.equal(waits, null);
assert.equal(composeConfiguredTurnResponse('Here is the approved answer.', waits), 'Here is the approved answer.');

const resolverSource = readFileSync(
  new URL('../src/voice/interaction/next-question-policy.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(resolverSource, /package|appointment|booking|sales/iu);

console.log('Configuration-driven next-question verification passed.');
