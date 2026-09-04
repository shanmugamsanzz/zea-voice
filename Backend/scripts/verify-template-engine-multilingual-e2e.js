import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';

const locales = Object.freeze([
  Object.freeze({
    code: 'ta',
    acknowledgement: '\u0b9a\u0bb0\u0bbf\u0b99\u0bcd\u0b95, \u0ba8\u0ba9\u0bcd\u0bb1\u0bbf.',
    acknowledgementResponse: '\u0b9a\u0bb0\u0bbf\u0b99\u0bcd\u0b95, \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95.',
    missingAttribute: '\u0b87\u0ba8\u0bcd\u0ba4 detail published information-\u0bb2 \u0b87\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bbe?',
    unavailable: '\u0bae\u0ba9\u0bcd\u0ba9\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd, \u0b85\u0ba8\u0bcd\u0ba4 detail published information-\u0b87\u0bb2\u0bcd \u0b87\u0bb2\u0bcd\u0bb2\u0bc8.',
    workflowStart: '\u0b87\u0ba4\u0bc8 \u0b87\u0baa\u0bcd\u0baa\u0bcb book \u0baa\u0ba3\u0bcd\u0ba3\u0bc1\u0b99\u0bcd\u0b95.',
    confirmation: '\u0b86\u0bae\u0bbe\u0bae\u0bcd, confirm \u0baa\u0ba3\u0bcd\u0ba3\u0bc1\u0b99\u0bcd\u0b95.',
    overview: 'என்னென்ன packages இருக்கு?', explanation: 'Silver package பற்றி சொல்லுங்க.',
    price: 'இதோட விலை எவ்வளவு?', comparison: 'Silver மற்றும் Gold வித்தியாசம் என்ன?',
    followUp: 'இதுல என்னென்ன tests இருக்கு?', switching: 'இப்ப Gold பற்றி சொல்லுங்க.',
    answer: 'Silver package விலை 100 ரூபாய்.',
    question: 'வேறு package பற்றி தெரிந்துகொள்ள வேண்டுமா?',
    askName: 'பெயரை சொல்ல முடியுமா?', askDate: 'எந்த தேதி வேண்டும்?',
    confirm: 'Alex, 2026-09-10 விவரங்களை உறுதி செய்கிறீர்களா?',
    cancel: 'வேண்டாம், இதை ரத்து செய்யுங்கள்.', cancelled: 'சரி, கோரிக்கை ரத்து செய்யப்பட்டது.',
    success: 'கோரிக்கை வெற்றிகரமாக முடிந்தது.', failure: 'கோரிக்கை முடிக்கப்படவில்லை.',
    further: 'வேறு உதவி வேண்டுமா?', close: 'நன்றி, வணக்கம்.',
  }),
  Object.freeze({
    code: 'ta-Latn',
    acknowledgement: 'Saringa, nandri.', acknowledgementResponse: 'Saringa, sollunga.',
    missingAttribute: 'Indha detail published information-la irukka?',
    unavailable: 'Mannikkavum, andha detail published information-la illa.',
    workflowStart: 'Idha ippo book pannunga.', confirmation: 'Aamam, confirm pannunga.',
    overview: 'Enna packages irukku?', explanation: 'Silver package pathi sollunga.',
    price: 'Idhoda price evlo?', comparison: 'Silver-க்கும் Gold-க்கும் difference enna?',
    followUp: 'Idhula enna tests irukku?', switching: 'Ippo Gold pathi sollunga.',
    answer: 'Silver package price 100 rupees.',
    question: 'Vera package pathi therinjikanuma?',
    askName: 'Unga name sollunga?', askDate: 'Entha date venum?',
    confirm: 'Alex, 2026-09-10 details confirm panreengala?',
    cancel: 'Vendam, idha cancel pannunga.', cancelled: 'Saringa, request cancel aayiduchu.',
    success: 'Request successful-aa complete aayiduchu.', failure: 'Request complete aagala.',
    further: 'Vera help venuma?', close: 'Nandri, vanakkam.',
  }),
  Object.freeze({
    code: 'en',
    acknowledgement: 'Okay, thank you.', acknowledgementResponse: 'You are welcome.',
    missingAttribute: 'Does the published information contain this detail?',
    unavailable: 'That detail is not present in the published information.',
    workflowStart: 'Book this now.', confirmation: 'Yes, confirm it.',
    overview: 'What packages are available?', explanation: 'Explain the Silver package.',
    price: 'What is its price?', comparison: 'Compare Silver and Gold.',
    followUp: 'Which tests does it include?', switching: 'Now explain Gold.',
    answer: 'The Silver package costs 100 rupees.',
    question: 'Would you like to hear about another package?',
    askName: 'What name should I use?', askDate: 'Which date would you like?',
    confirm: 'Do you confirm Alex and 2026-09-10?',
    cancel: 'Cancel this request.', cancelled: 'The pending request was cancelled.',
    success: 'The request completed successfully.', failure: 'The request was not completed.',
    further: 'Would you like any further help?', close: 'Thank you. Goodbye.',
  }),
]);

function ids(language) {
  const key = language.replace(/[^a-z]/giu, '-').toLowerCase();
  return {
    tenantId: `tenant-${key}`, agentId: `agent-${key}`, knowledgeBaseId: `kb-${key}`,
  };
}

function scoped(language) {
  const identity = ids(language);
  return {
    ...identity,
    scope: {
      tenantId: identity.tenantId, agentId: identity.agentId,
      publications: [{ knowledgeBaseId: identity.knowledgeBaseId, publicationRevision: 3 }],
    },
  };
}

function evidenceFor(configuration, comparison = false, switched = false) {
  const identity = scoped(configuration.code);
  const names = comparison ? ['Silver', 'Gold'] : [switched ? 'Gold' : 'Silver'];
  return names.map((name, index) => Object.freeze({
    verified: true, callerFacing: true,
    evidenceId: `evidence-${configuration.code}-${name}`,
    recordId: `record-${configuration.code}-${name}`,
    recordType: 'CATALOG_ITEM', ...identity,
    publicationRevision: 3,
    content: `${name} package. Price ${name === 'Silver' ? 100 : 200} rupees. Tests A and B.`,
    canonicalName: `${name} package`, aliases: [name],
    authoritativeData: { name: `${name} package`, price: name === 'Silver' ? 100 : 200 },
  }));
}

function guidance(configuration, scenario) {
  const identity = scoped(configuration.code);
  return Object.freeze({
    recordId: `guidance-${configuration.code}-${scenario}`,
    recordType: 'CONVERSATION_NODE', ...identity, publicationRevision: 3, published: true,
    nodeKey: scenario, intentClass: null,
    purpose: `${scenario} package response with a relevant package continuation.`,
    situation: `${scenario} request`, examples: [], context: null, catalogReferences: [],
    nextQuestion: configuration.question,
  });
}

function searchDecision(utterance, requestedFact, preferredRecordIds = []) {
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: utterance, requestedFact, contextualReference: 'current package',
      preferredRecordIds,
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function factualResponse(configuration, records, scenario) {
  let response = configuration.answer;
  if (scenario === 'overview') response = configuration.code === 'en'
    ? 'Silver and Gold packages are available.' : configuration.code === 'ta'
      ? 'Silver மற்றும் Gold packages இருக்கின்றன.' : 'Silver and Gold packages irukku.';
  if (scenario === 'comparison') response = configuration.code === 'en'
    ? 'Silver costs 100 rupees and Gold costs 200 rupees.' : configuration.code === 'ta'
      ? 'Silver விலை 100 ரூபாய், Gold விலை 200 ரூபாய்.'
      : 'Silver price 100 rupees, Gold price 200 rupees.';
  if (scenario === 'topic_switching') response = configuration.code === 'en'
    ? 'The Gold package costs 200 rupees.' : configuration.code === 'ta'
      ? 'Gold package விலை 200 ரூபாய்.' : 'Gold package price 200 rupees.';
  return Object.freeze({
    decision: 'RESPONSE', response, clarification: null,
    evidenceIds: records.map((_record, index) => `E${index + 1}`),
    nextQuestion: { question: configuration.question, reason: 'Published continuation' },
    stateUpdate: null,
  });
}

function questionCount(value) {
  return (String(value).match(/[?\uFF1F]/gu) ?? []).length;
}

function occurrences(value, fragment) {
  return String(value).split(String(fragment)).length - 1;
}

function assertNumbersGrounded(speech, records) {
  const spoken = new Set(String(speech).match(/\d+(?:[.,]\d+)?/gu) ?? []);
  const allowed = new Set(records.flatMap((record) => (
    String(record.content).match(/\d+(?:[.,]\d+)?/gu) ?? []
  )));
  for (const number of spoken) assert.equal(allowed.has(number), true,
    `Hallucinated number ${number} in ${speech}`);
}

async function runFactualScenario(configuration, scenario, utterance) {
  const identity = scoped(configuration.code);
  const comparison = scenario === 'comparison';
  const switched = scenario === 'topic_switching';
  const records = evidenceFor(configuration, comparison, switched);
  const priorId = `record-${configuration.code}-Silver`;
  const history = ['contextual_follow_up', 'topic_switching'].includes(scenario) ? [
    { role: 'user', content: configuration.explanation },
    { role: 'assistant', content: configuration.answer },
  ] : [];
  const preferred = scenario === 'contextual_follow_up' ? [priorId] : [];
  const decisions = [
    searchDecision(utterance, scenario, preferred),
    factualResponse(configuration, records, scenario),
  ];
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId: identity.tenantId }, scope: identity.scope,
    callId: `${configuration.code}-${scenario}`, usageDirection: 'inbound',
    language: configuration.code, mainPrompt: 'Search factual requests and use published guidance.',
    latestUtterance: utterance, conversationHistory: history,
    state: { lastReferencedRecordIds: history.length ? [priorId] : [] },
    assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => decisions.shift(),
    loadPublishedContext: async () => ({
      scope: identity.scope, artifacts: {}, publishedWorkflows: [],
      publishedConversationGuidance: [guidance(configuration, scenario)],
    }),
    retrieveEvidence: async ({ searchDecision: routed }) => {
      assert.equal(routed.decision, 'SEARCH');
      if (scenario === 'contextual_follow_up') {
        assert.deepEqual(routed.search.preferredRecordIds, [priorId]);
      }
      return {
        scope: identity.scope, evidence: records,
        diagnostics: {
          retrievalCount: records.length, hydrationCount: records.length,
          verifiedEvidenceCount: records.length,
        },
      };
    },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('factual route executed a tool'); },
    validateGroundedClaims: async () => ({
      supported: true, successClaimed: false, requestedFactAddressed: true,
    }),
    validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  });
  assert.equal(result.decision.decision, 'RESPONSE');
  assert.equal(result.followUpValidation.accepted, true);
  assert.equal(questionCount(result.speech), 1);
  assert.equal(occurrences(result.speech, configuration.question), 1);
  assert.equal(new Set(result.evidenceIds).size, records.length);
  assertNumbersGrounded(result.speech, records);
  if (switched) assert.deepEqual(result.state.lastReferencedRecordIds, [records[0].recordId]);
  assert.equal(decisions.length, 0);
}

function workflowFixture(configuration) {
  const identity = scoped(configuration.code);
  const tool = {
    id: `tool-${configuration.code}`, name: 'create_request', status: 'active',
    identifiers: ['published_request_action'],
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['full_name', 'requested_date'],
      properties: {
        full_name: { type: 'string', minLength: 2 },
        requested_date: { type: 'string', minLength: 10 },
      },
      'x-confirmation-message': configuration.confirm,
    },
  };
  const workflow = {
    recordId: `workflow-${configuration.code}`, recordType: 'WORKFLOW_RULE',
    ...identity, publicationRevision: 3, published: true,
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'published_request_action' },
  };
  const resultGuidance = {
    ...guidance(configuration, 'execution_result'), nextQuestion: configuration.further,
    purpose: 'Report the verified execution result and offer further help.',
  };
  return {
    identity, tool, workflow, resultGuidance,
    fields: [
      { key: 'full_name', label: 'Full name', type: 'text', required: true,
        question: configuration.askName, requiredAction: 'create_request' },
      { key: 'requested_date', label: 'Date', type: 'text', required: true,
        question: configuration.askDate, requiredAction: 'create_request' },
    ],
  };
}

function toolDecision(argumentsValue = {}, confirmation = false) {
  return {
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: { name: 'create_request', arguments: argumentsValue }, nextQuestion: null,
    stateUpdate: confirmation
      ? { set: { confirmationStatus: 'confirmed' }, clear: [] } : null,
  };
}

async function workflowTurn(configuration, fixture, utterance, state, outputs, execute) {
  return runTemplateEngineProductionTurn({
    auth: { tenantId: fixture.identity.tenantId }, scope: fixture.identity.scope,
    callId: `${configuration.code}-workflow`, usageDirection: 'inbound',
    language: configuration.code, mainPrompt: 'Use the authorized Workflow and speak naturally.',
    latestUtterance: utterance, conversationHistory: [], state,
    assignedTools: [fixture.tool], informationFields: fixture.fields,
  }, {
    invokeStructuredLlm: async () => outputs.shift(),
    loadPublishedContext: async () => ({
      scope: fixture.identity.scope, artifacts: {}, publishedWorkflows: [fixture.workflow],
      publishedConversationGuidance: [fixture.resultGuidance],
    }),
    retrieveEvidence: async () => { throw new Error('Workflow route searched knowledge'); },
    persistWorkflowState: async () => {}, executeAuthorizedTool: execute,
    validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
    validateToolResultSpeechClaims: async ({ speech, verifiedResult }) => ({
      supported: true,
      successClaimed: verifiedResult.success === true && speech === configuration.success,
    }),
  });
}

async function runWorkflowScenarios(configuration) {
  const fixture = workflowFixture(configuration);
  const selectedRecordId = `record-${configuration.code}-Silver`;
  let executions = 0;
  let result = await workflowTurn(configuration, fixture, configuration.workflowStart, {
    lastReferencedRecordIds: [selectedRecordId],
  }, [
    toolDecision(), { speech: configuration.askName },
  ], async () => { executions += 1; });
  assert.equal(result.workflow.status, 'AWAITING_FIELD');
  assert.equal(result.provenance.workflowId, fixture.workflow.recordId);
  assert.equal(result.provenance.toolId, fixture.tool.id);
  assert.deepEqual(result.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(result.speech, configuration.askName);
  assert.equal(questionCount(result.speech), 1);

  result = await workflowTurn(configuration, fixture, 'Alex', result.state, [
    toolDecision({ full_name: 'Alex' }), { speech: configuration.askDate },
  ], async () => { executions += 1; });
  assert.equal(result.workflow.status, 'AWAITING_FIELD');
  assert.deepEqual(result.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(result.speech, configuration.askDate);

  result = await workflowTurn(configuration, fixture, '2026-09-10', result.state, [
    toolDecision({ requested_date: '2026-09-10' }), { speech: configuration.confirm },
  ], async () => { executions += 1; });
  assert.equal(result.workflow.status, 'AWAITING_CONFIRMATION');
  assert.deepEqual(result.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(questionCount(result.speech), 1);
  assert.equal(executions, 0);

  const awaiting = result.state;
  result = await workflowTurn(configuration, fixture, configuration.confirmation, awaiting, [
    toolDecision({}, true), {
      speech: configuration.success,
      nextQuestion: { question: configuration.further, reason: 'Published continuation' },
    },
  ], async () => {
    executions += 1;
    return { verified: true, success: true, output: { accepted: true } };
  });
  assert.equal(result.workflow.status, 'SUCCEEDED');
  assert.equal(result.workflow.verifiedResult.verified, true);
  assert.deepEqual(result.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(result.followUpValidation.accepted, true);
  assert.equal(questionCount(result.speech), 1);
  assert.equal(occurrences(result.speech, configuration.further), 1);
  assert.equal(executions, 1);

  const failed = await workflowTurn(configuration, fixture, configuration.confirmation, awaiting, [
    toolDecision({}, true), {
      speech: configuration.failure,
      nextQuestion: { question: configuration.further, reason: 'Published continuation' },
    },
  ], async () => ({ verified: true, success: false, output: {}, error: { code: 'DECLINED' } }));
  assert.equal(failed.workflow.status, 'FAILED');
  assert.equal(failed.workflow.verifiedResult.verified, true);
  assert.deepEqual(failed.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(failed.followUpValidation.accepted, true);
  assert.equal(questionCount(failed.speech), 1);
  assert.equal(occurrences(failed.speech, configuration.further), 1);

  const cancellationOutputs = [{
    decision: 'RESPONSE', response: configuration.cancelled,
    clarification: null, search: null, tool: null, nextQuestion: null,
    stateUpdate: {
      set: { confirmationStatus: null },
      clear: ['activeWorkflowId', 'collectedToolFields', 'confirmationStatus'],
    },
  }];
  const cancelled = await workflowTurn(
    configuration, fixture, configuration.cancel, awaiting, cancellationOutputs,
    async () => { executions += 1; },
  );
  assert.equal(cancelled.state.activeWorkflowId, null);
  assert.deepEqual(cancelled.state.collectedToolFields, {});
  assert.equal(cancelled.state.confirmationStatus, null);
  assert.deepEqual(cancelled.state.lastReferencedRecordIds, [selectedRecordId]);
  assert.equal(cancelled.decision.nextQuestion, null);
  assert.equal(questionCount(cancelled.speech), 0);
  assert.equal(executions, 1);
}

async function runAcknowledgement(configuration) {
  const identity = scoped(configuration.code);
  let retrievalCalls = 0;
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId: identity.tenantId }, scope: identity.scope,
    callId: `${configuration.code}-acknowledgement`, usageDirection: 'inbound',
    language: configuration.code, mainPrompt: 'Reply naturally to non-factual conversation.',
    latestUtterance: configuration.acknowledgement, conversationHistory: [], state: {},
    assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => ({
      decision: 'RESPONSE', response: configuration.acknowledgementResponse,
      clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
    }),
    loadPublishedContext: async () => ({
      scope: identity.scope, artifacts: {}, publishedWorkflows: [],
      publishedConversationGuidance: [],
    }),
    retrieveEvidence: async () => { retrievalCalls += 1; },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Acknowledgement executed a tool'); },
    validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
    validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  });
  assert.equal(result.decision.decision, 'RESPONSE');
  assert.equal(result.speech, configuration.acknowledgementResponse);
  assert.equal(retrievalCalls, 0);
}

async function runMissingAttribute(configuration) {
  const identity = scoped(configuration.code);
  const records = evidenceFor(configuration);
  const decisions = [
    searchDecision(configuration.missingAttribute, 'unpublished detail'),
    {
      decision: 'NO_MATCH', response: configuration.unavailable,
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    },
  ];
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId: identity.tenantId }, scope: identity.scope,
    callId: `${configuration.code}-missing-attribute`, usageDirection: 'inbound',
    language: configuration.code, mainPrompt: 'Never infer a negative value from a missing fact.',
    latestUtterance: configuration.missingAttribute, conversationHistory: [], state: {},
    assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => decisions.shift(),
    loadPublishedContext: async () => ({
      scope: identity.scope, artifacts: {}, publishedWorkflows: [],
      publishedConversationGuidance: [],
    }),
    retrieveEvidence: async () => ({
      scope: identity.scope, evidence: records,
      diagnostics: { retrievalCount: 1, hydrationCount: 1, verifiedEvidenceCount: 1 },
    }),
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Missing attribute executed a tool'); },
    validateGroundedClaims: async ({ decision, response }) => ({
      supported: decision === 'NO_MATCH' && response === configuration.unavailable,
      successClaimed: false,
      requestedFactAddressed: decision === 'NO_MATCH',
    }),
    validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  });
  assert.equal(result.decision.decision, 'NO_MATCH');
  assert.equal(result.speech, configuration.unavailable);
  assert.equal(result.evidenceIds.length, 0);
  assert.equal(decisions.length, 0);
}

async function runClosing(configuration) {
  const identity = scoped(configuration.code);
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId: identity.tenantId }, scope: identity.scope,
    callId: `${configuration.code}-closing`, usageDirection: 'inbound',
    language: configuration.code, mainPrompt: 'Close naturally when the caller finishes.',
    latestUtterance: configuration.close, conversationHistory: [], state: {},
    assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => ({
      decision: 'RESPONSE', response: configuration.close,
      clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
    }),
    loadPublishedContext: async () => ({
      scope: identity.scope, artifacts: {}, publishedWorkflows: [],
      publishedConversationGuidance: [{
        ...guidance(configuration, 'completion'), nextQuestion: null,
        purpose: 'Close the completed conversation without another question.',
      }],
    }),
    retrieveEvidence: async () => { throw new Error('Closing searched knowledge'); },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Closing executed a tool'); },
    validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
    validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  });
  assert.equal(result.speech, configuration.close);
  assert.equal(questionCount(result.speech), 0);
}

const repeats = 3;
for (let pass = 0; pass < repeats; pass += 1) {
  for (const configuration of locales) {
    await runAcknowledgement(configuration);
    for (const [scenario, utterance] of Object.entries({
      overview: configuration.overview,
      package_explanation: configuration.explanation,
      price: configuration.price,
      comparison: configuration.comparison,
      contextual_follow_up: configuration.followUp,
      topic_switching: configuration.switching,
    })) await runFactualScenario(configuration, scenario, utterance);
    await runMissingAttribute(configuration);
    await runWorkflowScenarios(configuration);
    await runClosing(configuration);
  }
}

const hallucinationConfiguration = locales.at(-1);
const hallucinationIdentity = scoped(hallucinationConfiguration.code);
const hallucinationEvidence = evidenceFor(hallucinationConfiguration);
const unsupportedDecision = {
  decision: 'RESPONSE', response: 'The Silver package costs 999 rupees.',
  clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
};
const hallucinationOutputs = [
  searchDecision(hallucinationConfiguration.price, 'price'),
  unsupportedDecision,
  unsupportedDecision,
];
const hallucinationBlocked = await runTemplateEngineProductionTurn({
  auth: { tenantId: hallucinationIdentity.tenantId }, scope: hallucinationIdentity.scope,
  callId: 'hallucination-gate', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Never invent factual values.', latestUtterance: hallucinationConfiguration.price,
  conversationHistory: [], state: {}, assignedTools: [], informationFields: [],
  informationUnavailableResponse: 'That information is unavailable.',
}, {
  invokeStructuredLlm: async () => hallucinationOutputs.shift(),
  loadPublishedContext: async () => ({
    scope: hallucinationIdentity.scope, artifacts: {}, publishedWorkflows: [],
    publishedConversationGuidance: [],
  }),
  retrieveEvidence: async () => ({
    scope: hallucinationIdentity.scope, evidence: hallucinationEvidence,
    diagnostics: { retrievalCount: 1, hydrationCount: 1, verifiedEvidenceCount: 1 },
  }),
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(hallucinationBlocked.decision.decision, 'NO_MATCH');
assert.equal(hallucinationBlocked.speech.includes('999'), false);
assert.equal(hallucinationOutputs.length, 0);

const productionSources = [
  'template-engine-decision-contract.js', 'template-engine-orchestrator.js',
  'template-engine-production-runtime.js', 'template-engine-workflow-runtime.js',
  'template-engine-follow-up.js', 'template-engine-conversation-guidance.js',
].map((name) => readFileSync(new URL(`../src/voice/interaction/${name}`, import.meta.url), 'utf8'))
  .join('\n').toLocaleLowerCase();
for (const forbidden of ['silver', 'gold', 'shanmuga', 'hospital', 'appointment', 'patient_name']) {
  assert.equal(productionSources.includes(forbidden), false,
    `Production template engine contains business vocabulary: ${forbidden}`);
}

console.log(JSON.stringify({
  gate: 'template-engine-multilingual-e2e', passed: true,
  repeats,
  languages: locales.map((entry) => entry.code),
  scenarios: [
    'acknowledgement', 'overview', 'package_explanation', 'price', 'comparison',
    'contextual_follow_up', 'topic_switching', 'missing_attributes',
    'booking_fields', 'confirmation', 'cancellation',
    'tool_success', 'tool_failure', 'closing',
  ],
  duplicateQuestions: 0, hallucinatedFacts: 0, hardcodedBusinessVocabulary: 0,
}, null, 2));
