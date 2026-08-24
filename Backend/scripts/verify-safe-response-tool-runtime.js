import assert from 'node:assert/strict';
import {
  createKnowledgeEngineInput,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';
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
assert.equal(direct.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(direct.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.equal(direct.response, null);
assert.deepEqual(direct.evidenceIds, [faq.id]);

const categoryOne = source('published:catalog_item:category-one', 'CATALOG_ITEM',
  'Starter Option. Approved starter service.', {
    itemKey: 'starter-option', categoryKey: 'service-options', name: 'Starter Option',
    category: 'Service Options', categoryDescription: 'Approved service options.',
    description: 'Approved starter service.',
  });
const categoryTwo = source('published:catalog_item:category-two', 'CATALOG_ITEM',
  'Advanced Option. Approved advanced service.', {
    itemKey: 'advanced-option', categoryKey: 'service-options', name: 'Advanced Option',
    category: 'Service Options', categoryDescription: 'Approved service options.',
    description: 'Approved advanced service.',
  });
const categoryDecision = planSafeKnowledgeResponse({
  input: inputFor({ knownEntities: [{
    id: 'stale-record', key: 'stale-option', name: 'Stale Option',
  }] }),
  classification: classification(knowledgeQueryClasses.CATEGORY_OVERVIEW),
  resolution: { candidate: {
    recordId: categoryOne.recordId, entityType: 'CATEGORY', categoryKey: 'service-options',
    label: 'Service Options', categoryDescription: 'Approved service options.',
  } },
  authoritative: authoritative([categoryOne, categoryTwo]), runtimeProfile: { tools: [] },
});
assert.equal(categoryDecision.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(categoryDecision.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.deepEqual(new Set(categoryDecision.evidenceIds), new Set([categoryOne.id, categoryTwo.id]));

const categoryWithLongHydratedDescription = source(
  'published:catalog_item:category-description', 'CATALOG_ITEM', 'Raw publication source.', {
    itemKey: 'tenant-option', categoryKey: 'tenant-services', name: 'Tenant Option',
    category: 'Tenant Services',
    categoryDescription: 'Approved multilingual services for current published customers.',
    description: 'Approved option details.',
  },
);
const alignedCategoryDecision = planSafeKnowledgeResponse({
  input: inputFor(),
  classification: classification(knowledgeQueryClasses.CATEGORY_OVERVIEW),
  resolution: { candidate: {
    recordId: categoryWithLongHydratedDescription.recordId,
    entityType: 'CATEGORY', categoryKey: 'tenant-services',
    label: 'Untrusted index label', categoryDescription: 'Untrusted index description',
  } },
  authoritative: authoritative([categoryWithLongHydratedDescription]), runtimeProfile: { tools: [] },
});
assert.equal(alignedCategoryDecision.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(alignedCategoryDecision.mode, knowledgeEngineResponseModes.GROUNDED_LLM);

const second = source('published:faq:two', 'FAQ', 'Priority support is available.', {
  question: 'What is priority support?', answer: 'Priority support is available.',
});
const complex = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.COMPARISON_COMPLEX),
  resolution: { routingCandidates: [
    { recordId: categoryOne.recordId, entityType: 'ITEM', explicit: true },
    { recordId: categoryTwo.recordId, entityType: 'ITEM', explicit: true },
  ] },
  authoritative: authoritative([categoryOne, categoryTwo]), runtimeProfile: { tools: [] },
});
assert.equal(complex.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(complex.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.deepEqual(new Set(complex.evidenceIds), new Set([categoryOne.id, categoryTwo.id]));
const finalizedComplex = finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex,
  answer: 'Starter Option. Approved starter service. Advanced Option. Approved advanced service.',
  selectedEvidenceIds: [categoryOne.id, categoryTwo.id],
  authoritative: authoritative([categoryOne, categoryTwo]),
});
assert.equal(finalizedComplex.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(finalizedComplex.reason, 'validated_grounded_llm_response');
assert.equal(finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex, answer: 'A complimentary meal is included.',
  selectedEvidenceIds: [categoryOne.id], authoritative: authoritative([categoryOne, categoryTwo]),
}).type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(finalizeGroundedLlmResponse({
  input: inputFor(), plan: complex, answer: categoryOne.content,
  selectedEvidenceIds: ['unplanned-source'], authoritative: authoritative([categoryOne, categoryTwo]),
}).reason, 'llm_selected_unplanned_citation');

const weak = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.UNKNOWN),
  resolution: {}, authoritative: authoritative([]), runtimeProfile: { tools: [] },
});
assert.equal(weak.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(weak.clarification.kind, 'no_evidence');

const groundedGeneral = source('published:knowledge_chunk:location', 'KNOWLEDGE_CHUNK',
  'The approved office location is Central City.', {
    heading: 'Office location', content: 'The approved office location is Central City.',
  });
const groundedGeneralPlan = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.UNKNOWN),
  resolution: {}, authoritative: authoritative([groundedGeneral]), runtimeProfile: { tools: [] },
});
assert.equal(groundedGeneralPlan.type, knowledgeEngineDecisionTypes.RESPONSE,
  'Retrieved General Knowledge must use grounded LLM instead of a false clarification');
assert.deepEqual(groundedGeneralPlan.evidenceIds, [groundedGeneral.id]);

const ambiguity = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([faq, second], {
    ambiguity: { detected: true, candidates: [{ name: 'Option One' }, { name: 'Option Two' }] },
  }), runtimeProfile: { tools: [] },
});
assert.equal(ambiguity.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.match(ambiguity.clarification.prompt, /Option One.*Option Two/u);
const workflowAmbiguity = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([faq, second], {
    ambiguity: { detected: true, candidates: [
      { name: 'internal_rule_one', recordType: 'WORKFLOW_RULE' },
      { name: 'internal_rule_two', recordType: 'WORKFLOW_RULE' },
    ] },
  }), runtimeProfile: { tools: [] },
});
assert.doesNotMatch(workflowAmbiguity.clarification.prompt, /internal_rule/u);

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
const groundedAction = planSafeKnowledgeResponse({
  input: completedInput, classification: actionClassification, resolution: {},
  authoritative: actionEvidence, runtimeProfile,
});
assert.equal(groundedAction.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(groundedAction.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
const awaiting = planAuthorizedToolWorkflow({
  input: completedInput, authoritative: actionEvidence, runtimeProfile,
});
assert.equal(awaiting.type, knowledgeEngineDecisionTypes.TOOL);
assert.equal(awaiting.toolWorkflow.status, 'AWAITING_CONFIRMATION');
assert.equal(awaiting.toolWorkflow.prompt, 'Should I submit this request?');

await assert.rejects(() => executeAuthorizedToolWorkflow({
  input: completedInput, plan: awaiting, runtimeProfile, call: { id: callId },
}), /confirmed, complete TOOL plan/u);

const ready = planAuthorizedToolWorkflow({
  input: completedInput, authoritative: actionEvidence, runtimeProfile, confirmation: true,
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
assert.equal(verified.decision.type, knowledgeEngineDecisionTypes.RESPONSE);
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

const catalogDirect = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([source(
    'published:catalog_item:render', 'CATALOG_ITEM',
    'ITEM: Tenant Option ITEM KEY: tenant-option ALIASES: option',
    {
      name: 'Tenant Option', description: 'Approved tenant description.', price: 25, currency: 'USD',
      attributes: [{ key: 'support', name: 'Support', value: 'Included' }],
    },
  )]), runtimeProfile: { tools: [] },
});
assert.equal(catalogDirect.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(catalogDirect.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.equal(catalogDirect.response, null);

const goldWithStructuredTests = source(
  'published:catalog_item:gold-structured', 'CATALOG_ITEM', 'Raw source is not spoken.',
  {
    itemKey: 'gold-option', name: 'Gold Option', description: 'Approved health screening.',
    attributes: [{ key: 'tests', name: 'Tests', value: ['CBC', 'HS-CRP', 'ECG'] }],
  },
);
const goldDecision = planSafeKnowledgeResponse({
  input: inputFor(), classification: classification(knowledgeQueryClasses.KNOWN_INFORMATION),
  resolution: {}, authoritative: authoritative([goldWithStructuredTests]), runtimeProfile: { tools: [] },
});
assert.equal(goldDecision.type, knowledgeEngineDecisionTypes.RESPONSE,
  'A Catalog record must use the single grounded natural-response path');
assert.equal(goldDecision.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.equal(validateFinalKnowledgeResponse({
  input: inputFor(), answer: 'Gold Option. Approved health screening. Tests: CBC, HS-CRP, ECG.',
  selectedEvidenceIds: [goldWithStructuredTests.id], evidence: [goldWithStructuredTests],
}).valid, true);

console.log('Safe direct/LLM/clarification routing and verified schema-driven tool execution verified.');
