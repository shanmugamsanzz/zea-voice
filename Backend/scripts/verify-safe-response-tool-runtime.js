import assert from 'node:assert/strict';
import { createKnowledgeEngineInput, knowledgeEngineDecisionTypes } from '../src/knowledge-engine/engine-contract.js';
import { knowledgeQueryClasses } from '../src/knowledge-engine/query-classifier.js';
import {
  executeAuthorizedToolWorkflow,
  finalizeGroundedLlmResponse,
  planAuthorizedToolWorkflow,
  planSafeKnowledgeResponse,
  validateFinalKnowledgeResponse,
} from '../src/knowledge-engine/safe-response-tool-runtime.js';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const agentId = 'a0000000-0000-4000-8000-000000000002';
const callId = 'a0000000-0000-4000-8000-000000000003';
const inputFor = (memory = {}) => createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'latest finalized tenant request',
  usageDirection: 'inbound', memory,
});
const classification = (intentClass, extra = {}) => ({
  tenantId, agentId, callId, intentClass, confidence: 0.96,
  requiresConfirmation: false, ...extra,
});
const source = (id, recordType, content, authoritativeData = {}, extra = {}) => Object.freeze({
  id, recordId: `record-${id}`, recordType, tenantId, agentId,
  knowledgeBaseId: 'a0000000-0000-4000-8000-000000000004',
  publicationRevision: 7, callerFacing: true, hydrationValidated: true,
  publicationValidated: true,
  content, authoritativeData: Object.freeze(authoritativeData), ...extra,
});
const authoritative = (evidence, extra = {}) => ({
  tenantId, agentId, callId, evidence,
  ambiguity: { detected: false, candidates: [] },
  conflict: { detected: false, conflicts: [] },
  ...extra,
});

const faq = source('published:faq:one', 'FAQ', 'Support is available on weekdays.', {
  question: 'When is support available?', answer: 'Support is available on weekdays.',
});
const direct = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([faq]), runtimeProfile: { tools: [] },
});
assert.equal(direct.type, knowledgeEngineDecisionTypes.DIRECT);
assert.equal(direct.response.text, 'Support is available on weekdays.');
assert.deepEqual(direct.evidenceIds, [faq.id]);

const second = source('published:faq:two', 'FAQ', 'Priority support is available.', {
  question: 'What is priority support?', answer: 'Priority support is available.',
});
const complex = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.COMPARISON_COMPLEX),
  resolution: {}, authoritative: authoritative([faq, second]), runtimeProfile: { tools: [] },
});
assert.equal(complex.type, knowledgeEngineDecisionTypes.LLM);
assert.deepEqual(new Set(complex.evidenceIds), new Set([faq.id, second.id]));
const finalizedComplex = finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex,
  answer: 'Weekday support is available. Priority support is available.',
  selectedEvidenceIds: [faq.id, second.id], authoritative: authoritative([faq, second]),
});
assert.equal(finalizedComplex.type, knowledgeEngineDecisionTypes.DIRECT);
assert.equal(finalizedComplex.reason, 'validated_grounded_llm_response');
assert.equal(finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex, answer: 'A complimentary meal is included.',
  selectedEvidenceIds: [faq.id], authoritative: authoritative([faq, second]),
}).type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex, answer: faq.content,
  selectedEvidenceIds: ['unplanned-source'], authoritative: authoritative([faq, second]),
}).reason, 'llm_selected_unplanned_citation');

const weak = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.UNKNOWN),
  resolution: {}, authoritative: authoritative([]), runtimeProfile: { tools: [] },
});
assert.equal(weak.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(weak.clarification.kind, 'no_evidence');

const ambiguity = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([faq, second], {
    ambiguity: { detected: true, candidates: [{ name: 'Option One' }, { name: 'Option Two' }] },
  }), runtimeProfile: { tools: [] },
});
assert.equal(ambiguity.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.match(ambiguity.clarification.prompt, /Option One.*Option Two/u);

assert.equal(validateFinalKnowledgeResponse({
  input: inputFor(), answer: 'Support is available on 9 weekdays.',
  selectedEvidenceIds: [faq.id], evidence: [faq],
}).reason, 'unsupported_numeric_fact');
assert.equal(validateFinalKnowledgeResponse({
  input: inputFor(), answer: faq.content,
  selectedEvidenceIds: ['foreign-source'], evidence: [faq],
}).reason, 'unknown_citation');
assert.equal(validateFinalKnowledgeResponse({
  input: inputFor(), answer: 'Support includes a complimentary meal.',
  selectedEvidenceIds: [faq.id], evidence: [faq],
}).reason, 'unsupported_claim');
assert.equal(validateFinalKnowledgeResponse({
  input: inputFor({ knownEntities: [{ key: 'option-beta', name: 'Option Beta' }] }),
  answer: 'Option Beta is available.', selectedEvidenceIds: [faq.id], evidence: [faq],
}).reason, 'unsupported_entity');
assert.equal(validateFinalKnowledgeResponse({
  input: inputFor(), answer: faq.content,
  selectedEvidenceIds: [faq.id], evidence: [{ ...faq, tenantId: 'foreign-tenant' }],
}).reason, 'non_authoritative_evidence_selected');

const workflow = source(
  'published:workflow_rule:one', 'WORKFLOW_RULE', 'Collect configured fields and execute.',
  {
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'create_request' },
    responseTemplate: '',
  },
  { callerFacing: false },
);
const tool = {
  id: 'a0000000-0000-4000-8000-000000000010',
  name: 'create_request',
  type: 'webhook_api',
  configuration: {
    inputSchema: {
      type: 'object',
      properties: {
        reference: { type: 'string', title: 'Reference', 'x-question': 'What is the reference?' },
        requestedDate: { type: 'string', format: 'date', 'ui:question': 'Which date do you prefer?' },
      },
      required: ['reference', 'requestedDate'],
      additionalProperties: false,
      'x-requires-confirmation': true,
      'x-confirmation-message': 'Should I submit this request?',
    },
  },
};
const runtimeProfile = {
  agent: { id: agentId, tenantId, workspaceId: 'workspace-one' },
  tools: [tool],
};
const actionClassification = classification(knowledgeQueryClasses.ACTION_TOOL_REQUEST);
const actionEvidence = authoritative([workflow]);

const collectReference = planAuthorizedToolWorkflow({
  input: inputFor(), authoritative: actionEvidence, runtimeProfile,
});
assert.equal(collectReference.type, knowledgeEngineDecisionTypes.TOOL);
assert.equal(collectReference.toolWorkflow.status, 'COLLECTING_FIELDS');
assert.deepEqual(collectReference.toolWorkflow.missingFields, ['reference', 'requestedDate']);
assert.equal(collectReference.toolWorkflow.prompt, 'What is the reference?');

const collectDate = planAuthorizedToolWorkflow({
  input: inputFor({
    activeTool: { name: tool.name },
    collectedToolFields: { reference: 'tenant-reference' },
  }),
  authoritative: actionEvidence, runtimeProfile,
});
assert.equal(collectDate.toolWorkflow.prompt, 'Which date do you prefer?');

const completedInput = inputFor({
  activeTool: { name: tool.name },
  collectedToolFields: { reference: 'tenant-reference', requestedDate: '2026-09-10' },
});
const awaiting = planSafeKnowledgeResponse({
  input: completedInput, classification: actionClassification, resolution: {},
  authoritative: actionEvidence, runtimeProfile,
});
assert.equal(awaiting.type, knowledgeEngineDecisionTypes.TOOL);
assert.equal(awaiting.toolWorkflow.status, 'AWAITING_CONFIRMATION');
assert.equal(awaiting.toolWorkflow.prompt, 'Should I submit this request?');

await assert.rejects(() => executeAuthorizedToolWorkflow({
  input: completedInput, plan: awaiting, runtimeProfile, call: { id: callId },
}), /confirmed, complete TOOL plan/u);

const ready = planSafeKnowledgeResponse({
  input: completedInput, classification: actionClassification, resolution: {},
  authoritative: actionEvidence, runtimeProfile, confirmation: true,
});
assert.equal(ready.toolWorkflow.status, 'READY_TO_EXECUTE');
assert.deepEqual(ready.tool.input, {
  reference: 'tenant-reference', requestedDate: '2026-09-10',
});

let executionCount = 0;
const verified = await executeAuthorizedToolWorkflow({
  input: completedInput, plan: ready, runtimeProfile, call: { id: callId },
}, {
  executor: async (_profile, _call, request, security) => {
    executionCount += 1;
    assert.equal(request.authorizationRecordId, workflow.id);
    assert.deepEqual(request.arguments, ready.tool.input);
    assert.equal(security.requireWorkflowAuthorization, true);
    assert.deepEqual(security.workflowAuthorization, {
      recordId: workflow.id, toolName: tool.name,
    });
    return {
      toolId: tool.id, verified: true, success: true,
      output: { success: true, message: 'Your request was completed successfully.' },
    };
  },
});
assert.equal(executionCount, 1);
assert.equal(verified.decision.type, knowledgeEngineDecisionTypes.DIRECT);
assert.equal(verified.decision.reason, 'verified_tool_success');
assert.equal(verified.evidence.authoritativeData.verified, true);

const unverified = await executeAuthorizedToolWorkflow({
  input: completedInput, plan: ready, runtimeProfile, call: { id: callId },
}, {
  executor: async () => ({ toolId: tool.id, verified: true, success: false, output: { success: false } }),
});
assert.equal(unverified.decision.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(unverified.decision.reason, 'tool_success_not_verified');
assert.doesNotMatch(unverified.decision.clarification.prompt, /completed successfully/iu);

const unauthorized = planAuthorizedToolWorkflow({
  input: inputFor(), authoritative: actionEvidence,
  runtimeProfile: { ...runtimeProfile, tools: [] },
});
assert.equal(unauthorized.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(unauthorized.reason, 'authorized_assigned_tool_unavailable');

const catalogWorkflow = Object.freeze({
  ...workflow,
  id: 'published:workflow_rule:catalog',
  recordId: 'record-workflow-catalog',
  authoritativeData: Object.freeze({
    ...workflow.authoritativeData,
    actionConfig: { toolIdentifier: 'create_request', requiresCatalogItem: true },
  }),
});
assert.equal(planAuthorizedToolWorkflow({
  input: inputFor(), authoritative: authoritative([catalogWorkflow]), runtimeProfile,
}).type, knowledgeEngineDecisionTypes.CLARIFY);
const selectableItem = source('published:catalog_item:one', 'CATALOG_ITEM', 'Selectable option.', {
  itemKey: 'tenant-option', name: 'Tenant Option', selectionRules: { selectable: true },
});
const catalogAuthorized = planAuthorizedToolWorkflow({
  input: inputFor(), authoritative: authoritative([catalogWorkflow, selectableItem]), runtimeProfile,
});
assert.equal(catalogAuthorized.type, knowledgeEngineDecisionTypes.TOOL);
assert.ok(catalogAuthorized.evidenceIds.includes(selectableItem.id));

console.log('Safe direct/LLM/clarification routing and verified schema-driven tool execution verified.');
