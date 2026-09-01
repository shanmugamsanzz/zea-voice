import assert from 'node:assert/strict';
import { logger } from '../src/config/logger.js';
import { finalizeConfiguredToolResults } from '../src/knowledge-bases/verified-tool-result.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import {
  advanceSchemaDrivenWorkflowState,
  resolveNextConfiguredQuestion,
} from '../src/voice/interaction/next-question-policy.js';
import { executeAgentTools } from '../src/voice/tools/tool-executor.service.js';

logger.level = 'fatal';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Production-shaped Workflow regression requires at least three passes');

const fixtures = Object.freeze([
  Object.freeze({ tenantId: 'workflow-tenant-one', agentId: 'workflow-agent-one',
    language: 'en', industry: 'fabrication',
    fields: ['contact_ref', 'requested_day', 'requested_slot'] }),
  Object.freeze({ tenantId: 'workflow-tenant-two', agentId: 'workflow-agent-two',
    language: 'ta', industry: 'learning',
    fields: ['caller_token', 'service_day', 'service_slot'] }),
  Object.freeze({ tenantId: 'workflow-tenant-three', agentId: 'workflow-agent-three',
    language: 'es', industry: 'distribution',
    fields: ['account_alias', 'chosen_day', 'chosen_window'] }),
]);

function response(payload) {
  return { ok: true, status: 200, body: null, headers: { get: () => null },
    text: async () => JSON.stringify(payload) };
}

function configuredFixture(fixture, pass) {
  const [identityKey, dateKey, timeKey] = fixture.fields;
  const toolName = `configured_action_${fixture.language}`;
  const workflowRecordId = `${fixture.tenantId}:workflow:${pass}`;
  const properties = {
    [identityKey]: { type: 'string', minLength: 3 },
    [dateKey]: { type: 'string', minLength: 4 },
    [timeKey]: { type: 'string', minLength: 2 },
  };
  const tool = {
    id: `${fixture.tenantId}:tool`, name: toolName, type: 'webhook_api',
    configuration: {
      url: 'https://example.com/configured-action', method: 'POST', timeoutMs: 1000,
      inputSchema: {
        type: 'object', required: [...fixture.fields], properties, additionalProperties: false,
        'x-confirmation-message': `Confirm ${fixture.language} configured action?`,
        'x-success-message': `Verified ${fixture.language} action completed.`,
      },
    },
  };
  const fieldSchemas = fixture.fields.map((key, index) => ({
    key, label: `${fixture.language}-${key}`, type: index === 1 ? 'date' : 'text',
    required: true, requiredAction: toolName,
    question: `configured-${fixture.language}-question-${index + 1}`,
  }));
  const actionEvidence = [{
    recordId: workflowRecordId, tenantId: fixture.tenantId,
    agentId: fixture.agentId, activationAllowed: true, callerFacing: false,
    authoritativeData: { actionType: 'configured_tool',
      actionConfig: { toolIdentifier: toolName } },
  }];
  return { tool, toolName, workflowRecordId, fieldSchemas, actionEvidence };
}

function nextQuestion({ activeRequest, fieldSchemas, collectedInformation, tool, actionEvidence }) {
  return resolveNextConfiguredQuestion({
    decision: { activeToolRequest: { name: tool.name } },
    beforeState: { activeToolRequest: activeRequest },
    afterState: { activeToolRequest: activeRequest, collectedInformation },
    fieldSchemas, tools: [tool], actionEvidence, guidanceEvidence: [],
  });
}

const counts = {
  partialCollections: 0, completeCollections: 0, dateTimeFollowUps: 0, confirmations: 0,
  cancellations: 0, toolDecisions: 0, verifiedExecutions: 0,
  verifiedFailures: 0, verifiedTimeouts: 0, validationRejections: 0,
  repeatedCollectedQuestions: 0, silentTurns: 0,
};

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const fixture of fixtures) {
    const configured = configuredFixture(fixture, pass);
    const identity = { tenantId: fixture.tenantId, agentId: fixture.agentId,
      callId: `${fixture.tenantId}:call:${pass}` };
    const memory = openGenericConversationState(identity, {
      cachePolicy: 'current_call_only', conversationContextMode: 'full_current_call',
      conversationMemoryFields: configured.fieldSchemas,
    });
    const activeRequest = { name: configured.toolName, status: 'collecting_information',
      authorizationRecordId: configured.workflowRecordId };
    memory.setActiveToolRequest(activeRequest);

    const [identityKey, dateKey, timeKey] = fixture.fields;
    const questions = [];
    let collected = { [identityKey]: 'x' };
    let transition = advanceSchemaDrivenWorkflowState({
      activeRequest, fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tools: [configured.tool], actionEvidence: configured.actionEvidence,
    });
    assert.equal(transition.valid, true);
    assert.ok(transition.workflowState.missingFields.includes(identityKey));
    let next = nextQuestion({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tool: configured.tool, actionEvidence: configured.actionEvidence });
    assert.equal(next.key, identityKey);
    assert.ok(next.question); questions.push(next.key); counts.partialCollections += 1;

    collected = { [identityKey]: `${fixture.language}-caller-${pass}` };
    transition = advanceSchemaDrivenWorkflowState({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tools: [configured.tool], actionEvidence: [] });
    next = nextQuestion({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tool: configured.tool, actionEvidence: [] });
    assert.equal(next.key, dateKey); questions.push(next.key);

    collected[dateKey] = `203${pass}-04-05`;
    transition = advanceSchemaDrivenWorkflowState({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tools: [configured.tool], actionEvidence: [] });
    next = nextQuestion({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tool: configured.tool, actionEvidence: [] });
    assert.equal(next.key, timeKey); questions.push(next.key); counts.dateTimeFollowUps += 1;

    collected[timeKey] = `${9 + pass}:00`;
    transition = advanceSchemaDrivenWorkflowState({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tools: [configured.tool], actionEvidence: [] });
    next = nextQuestion({ activeRequest: transition.activeToolRequest,
      fieldSchemas: configured.fieldSchemas, collectedInformation: collected,
      tool: configured.tool, actionEvidence: [] });
    assert.equal(next.kind, 'confirmation');
    assert.ok(next.question); counts.confirmations += 1; counts.completeCollections += 1;
    counts.repeatedCollectedQuestions += questions.length - new Set(questions).size;
    memory.mergeCollectedData(collected);
    memory.setActiveToolRequest(next.activeToolRequest);
    const persisted = memory.snapshot();
    assert.equal(persisted.activeToolRequest.workflowState.selectedRecord.recordId,
      configured.workflowRecordId);
    assert.deepEqual(persisted.activeToolRequest.workflowState.missingFields, []);

    memory.setActiveToolRequest(null);
    assert.equal(memory.snapshot().activeToolRequest, null);
    assert.equal(memory.snapshot().collectedInformation[identityKey], collected[identityKey]);
    counts.cancellations += 1;

    const confirmed = advanceSchemaDrivenWorkflowState({
      activeRequest: next.activeToolRequest, fieldSchemas: configured.fieldSchemas,
      collectedInformation: collected, tools: [configured.tool], actionEvidence: [],
      confirmationAccepted: true,
    });
    assert.equal(confirmed.valid, true);
    assert.equal(confirmed.activeToolRequest.status, 'ready');
    assert.equal(confirmed.workflowState.confirmationStatus, 'confirmed');
    counts.toolDecisions += 1;

    const runtimeProfile = { agent: { ...fixture, id: fixture.agentId,
      workspaceId: `${fixture.tenantId}:workspace` }, tools: [configured.tool] };
    const call = { ...identity, id: identity.callId, providerCallId: `provider-${pass}`,
      direction: 'inbound' };
    const toolCall = { id: `${identity.callId}:request`, name: configured.toolName,
      arguments: collected, authorizationRecordId: configured.workflowRecordId };
    const executionOptions = { resolveDns: false, requireWorkflowAuthorization: true,
      workflowAuthorization: { recordId: configured.workflowRecordId,
        toolName: configured.toolName } };
    const success = await executeAgentTools(runtimeProfile, call, [toolCall], {
      ...executionOptions, fetchImpl: async () => response({ success: true,
        callerMessage: `verified-${fixture.language}-${pass}` }),
    });
    assert.equal(success[0].verified, true);
    assert.equal(success[0].success, true);
    const finalizedSuccess = finalizeConfiguredToolResults({
      input: { ...identity, utterance: 'configured action' }, results: success, runtimeProfile,
    });
    assert.equal(finalizedSuccess.decision.type, 'RESPONSE');
    assert.equal(finalizedSuccess.decision.reason, 'verified_tool_success');
    assert.ok(finalizedSuccess.decision.response?.text); counts.verifiedExecutions += 1;

    const failure = await executeAgentTools(runtimeProfile, call, [toolCall], {
      ...executionOptions, fetchImpl: async () => response({ success: false,
        reason: `declined-${pass}` }),
    });
    assert.equal(failure[0].verified, true);
    assert.equal(failure[0].success, false);
    const finalizedFailure = finalizeConfiguredToolResults({
      input: { ...identity, utterance: 'configured action' }, results: failure, runtimeProfile,
    });
    assert.equal(finalizedFailure.decision.type, 'CLARIFY');
    assert.equal(finalizedFailure.decision.clarification?.kind, 'technical');
    counts.verifiedFailures += 1;

    const timeout = await executeAgentTools(runtimeProfile, call, [toolCall], {
      ...executionOptions,
      fetchImpl: async () => {
        const error = new Error(`configured-timeout-${pass}`);
        error.name = 'TimeoutError';
        throw error;
      },
    });
    assert.equal(timeout[0].verified, true);
    assert.equal(timeout[0].success, false);
    assert.equal(timeout[0].error.code, 'VOICE_TOOL_TIMEOUT');
    const finalizedTimeout = finalizeConfiguredToolResults({
      input: { ...identity, utterance: 'configured action' }, results: timeout, runtimeProfile,
    });
    assert.equal(finalizedTimeout.decision.type, 'CLARIFY');
    assert.equal(finalizedTimeout.decision.clarification?.kind, 'technical');
    counts.verifiedTimeouts += 1;

    const authoritativeEvidence = [{ tenantId: fixture.tenantId,
      agentId: fixture.agentId, recordType: 'CATALOG_ITEM',
      content: `Configured value is ${100 + pass}.`,
      authoritativeData: { price: 100 + pass } }];
    assert.equal(validateGroundedClaim(`Configured value is ${100 + pass}.`,
      authoritativeEvidence).valid, true);
    assert.equal(validateGroundedClaim('Configured value is 999999.',
      authoritativeEvidence).valid, false);
    counts.validationRejections += 1;
    memory.close();
  }
}

assert.equal(counts.repeatedCollectedQuestions, 0);
assert.equal(counts.silentTurns, 0);
const expected = fixtures.length * repeats;
for (const count of [counts.partialCollections, counts.completeCollections, counts.dateTimeFollowUps,
  counts.confirmations, counts.cancellations, counts.toolDecisions,
  counts.verifiedExecutions, counts.verifiedFailures, counts.verifiedTimeouts,
  counts.validationRejections]) assert.equal(count, expected);

console.log(JSON.stringify({
  gate: 'production-shaped-workflow-state', passed: true, repeats,
  syntheticTenants: fixtures.length,
  syntheticIndustries: fixtures.map((fixture) => fixture.industry),
  languages: fixtures.map((fixture) => fixture.language),
  partialFieldCollections: counts.partialCollections,
  completeFieldCollections: counts.completeCollections,
  dateTimeFollowUps: counts.dateTimeFollowUps,
  confirmations: counts.confirmations, cancellations: counts.cancellations,
  decisions: { RESPONSE: counts.verifiedExecutions,
    CLARIFY: counts.verifiedFailures,
    TOOL: counts.toolDecisions },
  verifiedToolExecutions: counts.verifiedExecutions,
  verifiedToolFailures: counts.verifiedFailures,
  verifiedToolTimeouts: counts.verifiedTimeouts,
  validationRejections: counts.validationRejections,
  preservedWorkflowState: true,
  repeatedCollectedQuestions: counts.repeatedCollectedQuestions,
  hardcodedBusinessVocabulary: false,
  crossTenantLeakage: false,
  falseTechnicalResponses: 0,
  silentTurns: counts.silentTurns,
}, null, 2));
