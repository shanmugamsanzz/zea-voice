import assert from 'node:assert/strict';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import { mergeToolFieldSchemas } from '../src/voice/interaction/tool-field-schema.js';
import { resolveNextConfiguredQuestion } from '../src/voice/interaction/next-question-policy.js';
import { executeAgentTools } from '../src/voice/tools/tool-executor.service.js';

const catalogEvidence = [{
  id: 'source_catalog', recordId: 'item-1', recordType: 'CATALOG_ITEM',
  content: 'Standard plan includes an assessment and follow-up service.',
  authoritativeData: { itemKey: 'standard-plan', services: ['assessment', 'follow-up'] },
}];

assert.equal(validateGroundedClaim(
  'The standard plan is best for your breathing problem.',
  catalogEvidence,
  { finalizedUtterance: 'I have a breathing problem. Which plan should I choose?' },
).reason, 'unsupported_suitability_recommendation');
assert.equal(validateGroundedClaim(
  'The follow-up service is not included.', catalogEvidence,
).reason, 'unsupported_claim_polarity');
assert.equal(validateGroundedClaim(
  'I cannot recommend a plan based on symptoms.', catalogEvidence,
  { finalizedUtterance: 'I have pain. Which plan is best?' },
).valid, true);

const tool = {
  id: 'tool-1', name: 'create_request',
  inputSchema: {
    type: 'object',
    required: ['customerName', 'requestedDate'],
    properties: {
      customerName: { type: 'string', title: 'Customer name', 'x-question': 'What name should I use?' },
      requestedDate: { type: 'string', format: 'date', title: 'Requested date', 'x-question': 'Which date do you prefer?' },
    },
    'x-requires-confirmation': true,
    'x-confirmation-message': 'Should I submit this request?',
  },
};
const fields = mergeToolFieldSchemas([], [tool]);
assert.deepEqual(fields.map(({ key, type, required }) => ({ key, type, required })), [
  { key: 'customerName', type: 'text', required: true },
  { key: 'requestedDate', type: 'date', required: true },
]);

const actionEvidence = [{
  recordId: 'workflow-1', activationAllowed: true,
  authoritativeData: { actionType: 'configured_tool', actionConfig: { toolIdentifier: 'create_request' } },
}];
const firstQuestion = resolveNextConfiguredQuestion({
  afterState: { activeToolRequest: { name: 'create_request' }, collectedInformation: {} },
  fieldSchemas: fields, tools: [tool], actionEvidence,
});
assert.equal(firstQuestion?.key, 'customerName');
const confirmation = resolveNextConfiguredQuestion({
  afterState: {
    activeToolRequest: { name: 'create_request' },
    collectedInformation: { customerName: 'Ari', requestedDate: '2026-09-01' },
  },
  fieldSchemas: fields, tools: [tool], actionEvidence,
});
assert.equal(confirmation?.kind, 'confirmation');
assert.match(confirmation?.question ?? '', /Should I submit this request/u);

const runtimeProfile = {
  agent: { id: 'agent-1', tenantId: 'tenant-1', workspaceId: 'workspace-1' },
  tools: [{
    id: 'tool-1', name: 'create_request', type: 'webhook_api',
    configuration: {
      url: 'https://actions.example.com/create', method: 'POST',
      inputSchema: tool.inputSchema,
    },
  }],
};
const call = { id: 'call-1', providerCallId: 'provider-1', direction: 'inbound' };
const dependencies = {
  requireWorkflowAuthorization: true,
  workflowAuthorization: { recordId: 'workflow-1', toolName: 'create_request' },
  resolveDns: false,
  fetchImpl: async () => new Response(JSON.stringify({ success: true, requestId: 'request-1' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }),
};
const denied = await executeAgentTools(runtimeProfile, call, [{
  id: 'call-tool-1', name: 'create_request',
  arguments: { customerName: 'Ari', requestedDate: '2026-09-01' },
}], dependencies);
assert.equal(denied[0].success, false);
assert.equal(denied[0].error.code, 'VOICE_TOOL_WORKFLOW_AUTHORIZATION_REQUIRED');

const allowed = await executeAgentTools(runtimeProfile, call, [{
  id: 'call-tool-2', name: 'create_request', authorizationRecordId: 'workflow-1',
  arguments: { customerName: 'Ari', requestedDate: '2026-09-01' },
}], dependencies);
assert.equal(allowed[0].verified, true);
assert.equal(allowed[0].success, true);

const unverifiedSuccess = await executeAgentTools(runtimeProfile, call, [{
  id: 'call-tool-3', name: 'create_request', authorizationRecordId: 'workflow-1',
  arguments: { customerName: 'Ari', requestedDate: '2026-09-01' },
}], {
  ...dependencies,
  fetchImpl: async () => new Response(JSON.stringify({ status: 'created' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }),
});
assert.equal(unverifiedSuccess[0].success, false);
assert.equal(unverifiedSuccess[0].error.code, 'VOICE_TOOL_REPORTED_FAILURE');

console.log('Grounding and schema-driven action runtime verification passed');
