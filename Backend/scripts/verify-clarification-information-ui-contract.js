import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { buildGroundedLlmInput } = await import('../src/knowledge-bases/grounded-turn-evidence.js');
const { deterministicSourceEntry } = await import('../src/knowledge-engine/deterministic-source-mapping.js');
const { createContextCachePolicy } = await import('../src/voice/interaction/context-cache-policy.js');
const { openGenericConversationState } = await import('../src/voice/interaction/generic-conversation-state.js');
const { resolveLiveMemoryConfiguration } = await import('../src/voice/interaction/live-memory-config.js');
const {
  isOperationalGroundedDecisionFailure,
  validateGroundedLlmDecision,
} = await import('../src/voice/interaction/grounded-llm-decision.js');
const { applyUnifiedGroundedTurn } = await import('../src/voice/interaction/unified-grounded-turn.js');
const {
  configuredClarificationRecovery,
  configuredInformationUnavailableResponse,
  configuredLatencyAcknowledgementResponse,
  configuredSafeFailureResponse,
  configuredTechnicalFailureResponse,
} = await import('../src/voice/realtime-conversation-orchestrator.js');

const scope = Object.freeze({
  tenantId: '51000000-0000-4000-8000-000000000001',
  workspaceId: '51000000-0000-4000-8000-000000000002',
  agentId: '51000000-0000-4000-8000-000000000003',
  callId: '51000000-0000-4000-8000-000000000004',
});
const settings = Object.freeze({
  cachePolicy: 'disabled',
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 5,
  knowledgeHighConfidence: 0.86,
  knowledgeClarificationConfidence: 0.64,
  knowledgeAmbiguityMargin: 0.06,
  knowledgeClarificationMessage: 'Did you mean {{candidates}}?',
  informationUnavailableMessage: 'That information is not available right now.',
  technicalFailureMessage: 'The service is temporarily unavailable.',
  latencyAcknowledgementMessage: 'Configured acknowledgement.',
  conversationMemoryFields: Object.freeze([
    Object.freeze({
      key: 'contact_name', label: 'Contact name', type: 'text', required: false,
      question: 'What name should I use?',
    }),
    Object.freeze({
      key: 'requested_date', label: 'Requested date', type: 'date', required: true,
      question: 'Which date do you want?', requiredAction: 'create_request',
    }),
  ]),
});

const liveConfiguration = resolveLiveMemoryConfiguration(settings, { strict: true });
assert.equal(liveConfiguration.recentTurns, 5);
assert.deepEqual(liveConfiguration.fields.map((field) => field.key), [
  'contact_name', 'requested_date',
]);

const runtimeProfile = Object.freeze({ agent: Object.freeze({
  id: scope.agentId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, settings,
}) });
assert.equal(configuredLatencyAcknowledgementResponse(runtimeProfile),
  'Configured acknowledgement.');
assert.equal(configuredSafeFailureResponse(runtimeProfile, {
  tenantEvidence: { ambiguity: { candidates: [{ name: 'Canonical Option' }] } },
}), 'Did you mean Canonical Option?');
const configuredRecovery = configuredClarificationRecovery(runtimeProfile, {
  tenantEvidence: { ambiguity: { candidates: [{ name: 'Canonical Option' }] } },
});
assert.equal(configuredRecovery.question, 'Did you mean Canonical Option?');
assert.equal(configuredInformationUnavailableResponse(runtimeProfile),
  'That information is not available right now.');
assert.equal(configuredTechnicalFailureResponse(runtimeProfile),
  'The service is temporarily unavailable.');
const cachePolicy = createContextCachePolicy({
  runtimeProfile, call: { id: scope.callId },
  contextResolution: { contextId: 'current-caller', source: 'test' },
});
assert.deepEqual({
  policy: cachePolicy.policy, readEnabled: cachePolicy.readEnabled,
  writeEnabled: cachePolicy.writeEnabled, crossCall: cachePolicy.crossCall,
}, { policy: 'disabled', readEnabled: false, writeEnabled: false, crossCall: false });

const record = Object.freeze({
  id: 'published-evidence-1', recordId: 'record-1', recordType: 'CATALOG_ITEM',
  tenantId: scope.tenantId, agentId: scope.agentId,
  knowledgeBaseId: '51000000-0000-4000-8000-000000000005', publicationRevision: 3,
  documentId: '51000000-0000-4000-8000-000000000006',
  documentVersionId: '51000000-0000-4000-8000-000000000007',
  hydrationValidated: true, publicationValidated: true,
  documentStatus: 'ready', documentVersionStatus: 'ready', documentVersionIsCurrent: true,
  callerFacing: true, callerFacingHint: true, callerFacingValidated: true,
  content: 'Published canonical option includes approved support.',
  authoritativeData: Object.freeze({ itemKey: 'canonical-option', name: 'Canonical Option' }),
});
const heardText = 'Can you explain the spoken option?';
const groundedInput = buildGroundedLlmInput({
  input: {
    ...scope, latestQuestion: heardText, requestedFact: 'details',
    memory: {
      recentTurns: [],
      collectedInformation: { contact_name: 'Asha', unknown_internal: 'must-not-pass' },
    },
  },
  classification: {
    intentClass: 'DETAILS_OR_PRICE',
    confidenceConfiguration: {
      highConfidence: 0.86, clarificationConfidence: 0.64, ambiguityMargin: 0.06,
    },
  },
  resolution: {
    candidateNamespace: 'CATALOG', candidate: null,
    confidenceConfiguration: {
      highConfidence: 0.86, clarificationConfidence: 0.64, ambiguityMargin: 0.06,
    },
    routingCandidates: [{
      recordId: record.recordId, recordType: record.recordType,
      name: 'Untrusted candidate label', score: 0.75,
    }],
  },
  authoritative: { evidence: [record] }, runtimeProfile,
});
assert.equal(groundedInput.clarificationContext.heardText, heardText);
assert.equal(groundedInput.clarificationContext.requestedFact, 'details');
assert.equal(groundedInput.clarificationContext.candidates[0].confidenceBand, 'MEDIUM');
assert.equal(groundedInput.clarificationContext.candidates[0].name, 'Canonical Option');
assert.deepEqual(groundedInput.clarificationContext.canonicalNames, ['Canonical Option']);
assert.deepEqual(groundedInput.clarificationContext.collectedFields, { contact_name: 'Asha' });

const envelope = Object.freeze({
  found: true,
  sources: Object.freeze([Object.freeze({
    ...record,
    id: 'source_1', publishedEvidenceId: record.id,
  })]),
  sourceMap: Object.freeze([deterministicSourceEntry(record, 'source_1')]),
  entities: Object.freeze([]),
});
const targetedClarification = validateGroundedLlmDecision(JSON.stringify({
  decision: 'CLARIFY', answer: 'Did you mean Canonical Option?', responseId: null,
  evidenceIds: [], toolName: null, toolArguments: null,
  clarificationReason: 'ambiguous_request',
}), envelope, {
  fieldSchemas: liveConfiguration.fields, toolSchemas: [],
  clarificationContext: groundedInput.clarificationContext,
});
assert.equal(targetedClarification.valid, true);
assert.match(targetedClarification.pendingQuestion, /Canonical Option/u);
const genericMediumClarification = validateGroundedLlmDecision(JSON.stringify({
  decision: 'CLARIFY', answer: 'Please repeat that.', responseId: null,
  evidenceIds: [], toolName: null, toolArguments: null,
  clarificationReason: 'ambiguous_request',
}), envelope, {
  fieldSchemas: liveConfiguration.fields, toolSchemas: [],
  clarificationContext: groundedInput.clarificationContext,
  clarificationPrompt: 'Did you mean Canonical Option?',
});
assert.equal(genericMediumClarification.valid, true);
assert.equal(genericMediumClarification.recoveredFrom,
  'candidate_specific_clarification_required');
assert.equal(genericMediumClarification.pendingQuestion, 'Did you mean Canonical Option?');

const memory = openGenericConversationState(scope, settings, Date.now());
memory.beginTurn('current-call-field');
const currentCallField = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'RESPONSE', answer: record.content, responseId: null,
    evidenceIds: ['source_1'], toolName: null, toolArguments: null,
    clarificationReason: null,
    stateUpdate: { collectedInformation: { contact_name: 'Asha' } },
  }),
  groundingEnvelope: envelope, memory, turnToken: 'current-call-field',
  fieldSchemas: liveConfiguration.fields, tools: [], evidence: [record],
  finalizedUtterance: 'My name is Asha.',
});
assert.equal(currentCallField.valid, true, JSON.stringify(currentCallField));
assert.equal(currentCallField.state.collectedInformation.contact_name, 'Asha');

memory.beginTurn('action-field-without-tool');
const actionFieldWithoutAuthorizedTool = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'RESPONSE', answer: record.content, responseId: null,
    evidenceIds: ['source_1'], toolName: null, toolArguments: null,
    clarificationReason: null,
    stateUpdate: { collectedInformation: { requested_date: '2030-04-05' } },
  }),
  groundingEnvelope: envelope, memory, turnToken: 'action-field-without-tool',
  fieldSchemas: liveConfiguration.fields, tools: [], evidence: [record],
  finalizedUtterance: 'Use 2030-04-05.',
});
assert.equal(actionFieldWithoutAuthorizedTool.valid, true);
assert.equal(actionFieldWithoutAuthorizedTool.state.collectedInformation.requested_date, undefined,
  'A field tied to an external action must not enter memory before tool authorization');

const unauthorizedTool = validateGroundedLlmDecision(JSON.stringify({
  decision: 'TOOL', answer: '', responseId: null, evidenceIds: [],
  toolName: 'create_request', toolArguments: JSON.stringify({ requested_date: '2030-04-05' }),
  clarificationReason: null,
}), envelope, { fieldSchemas: liveConfiguration.fields, toolSchemas: [] });
assert.equal(unauthorizedTool.valid, false);
assert.equal(unauthorizedTool.reason, 'invalid_tool_request');

memory.beginTurn('configured-unavailable');
const configuredUnavailable = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'NO_MATCH', answer: '', responseId: null, evidenceIds: [],
    toolName: null, toolArguments: null, clarificationReason: null,
  }),
  groundingEnvelope: { found: false, sources: [], sourceMap: [], entities: [] },
  memory, turnToken: 'configured-unavailable', evidence: [],
  finalizedUtterance: 'Ask for an unpublished fact.',
  zeroEvidenceResponse: settings.informationUnavailableMessage,
});
assert.equal(configuredUnavailable.valid, true);
assert.equal(configuredUnavailable.answer, settings.informationUnavailableMessage);
assert.equal(configuredUnavailable.approvedConfiguredUnavailableResponse, true);
assert.equal(isOperationalGroundedDecisionFailure('unsupported_numeric_fact'), false);
assert.equal(isOperationalGroundedDecisionFailure('invalid_json'), true);
memory.close();

console.log(JSON.stringify({
  passed: true,
  settings: [
    'cachePolicy', 'conversationContextTurns', 'knowledgeConfidence',
    'knowledgeClarificationMessage', 'latencyAcknowledgementMessage',
    'conversationMemoryFields',
  ],
}));
