import assert from 'node:assert/strict';
import {
  assertAgentWorkflowToolsRemainAssigned,
  assertKnowledgeBaseWorkflowToolsAssigned,
  validateWorkflowToolAssignments,
} from '../src/knowledge-bases/workflow-tool-authorization.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';
import { compactGroundedDecisionInput } from '../src/agents/agent-runtime.service.js';
import { finalizeConfiguredToolResults } from '../src/knowledge-bases/verified-tool-result.js';

const tenantId = '73000000-0000-4000-8000-000000000001';
const agentId = '73000000-0000-4000-8000-000000000002';
const knowledgeBaseId = '73000000-0000-4000-8000-000000000003';
const workflowRecordId = '73000000-0000-4000-8000-000000000004';
const toolId = '73000000-0000-4000-8000-000000000005';
const tool = {
  id: toolId,
  name: 'submit_tenant_request',
  configuration: {
    identifier: 'tenant.request.submit_v1',
    inputSchema: {
      type: 'object',
      properties: {
        contact_name: {
          type: 'string', title: 'Contact name',
          'x-question': 'What contact name should I use?',
        },
      },
      required: ['contact_name'],
      additionalProperties: false,
      'x-requires-confirmation': true,
      'x-confirmation-message': 'Should I submit these details?',
      'x-success-message': 'The request was submitted.',
    },
  },
};
const workflow = {
  id: workflowRecordId,
  name: 'Submit request',
  action_type: 'configured_tool',
  action_config: {
    toolIdentifier: 'tenant.request.submit_v1',
    requiresCatalogItem: false,
  },
};

assert.deepEqual(validateWorkflowToolAssignments({
  workflows: [workflow], agents: [{ agentId, tools: [tool] }],
}), []);
const missing = validateWorkflowToolAssignments({
  workflows: [workflow], agents: [{ agentId, tools: [] }],
});
assert.equal(missing.length, 1);
assert.equal(missing[0].reason, 'tool_not_assigned');
const invalidSchema = validateWorkflowToolAssignments({
  workflows: [workflow],
  agents: [{ agentId, tools: [{ id: 'schema-less', name: 'tenant.request.submit_v1' }] }],
});
assert.equal(invalidSchema[0].reason, 'tool_schema_root_must_be_object');
const ambiguousAssignment = validateWorkflowToolAssignments({
  workflows: [workflow],
  agents: [{ agentId, tools: [tool, { ...tool, id: 'duplicate-tool' }] }],
});
assert.equal(ambiguousAssignment[0].reason, 'tool_identifier_ambiguous');

const matchingClient = {
  async query(sql) {
    if (sql.includes('FROM workflow_rules')) return { rowCount: 1, rows: [workflow] };
    if (sql.includes('FROM agent_tools')) return {
      rowCount: 1, rows: [{ ...tool, agent_id: agentId }],
    };
    throw new Error(`Unexpected query: ${sql}`);
  },
};
assert.deepEqual(await assertKnowledgeBaseWorkflowToolsAssigned(matchingClient, {
  tenantId, knowledgeBaseId, agentIds: [agentId],
}), { validatedAgents: 1, workflows: 1 });
const missingClient = {
  async query(sql) {
    if (sql.includes('FROM workflow_rules')) return { rowCount: 1, rows: [workflow] };
    if (sql.includes('FROM agent_tools')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  },
};
await assert.rejects(assertKnowledgeBaseWorkflowToolsAssigned(missingClient, {
  tenantId, knowledgeBaseId, agentIds: [agentId],
}), (error) => error.code === 'KNOWLEDGE_WORKFLOW_TOOL_NOT_ASSIGNED'
  && error.details?.issues?.[0]?.agentId === agentId);
const mutationClient = {
  async query(sql) {
    if (sql.includes('FROM agent_knowledge_bases assignment')) return {
      rowCount: 1, rows: [{ knowledge_base_id: knowledgeBaseId }],
    };
    if (sql.includes('FROM workflow_rules')) return { rowCount: 1, rows: [workflow] };
    if (sql.includes('FROM agent_tools')) return { rowCount: 1, rows: [{ ...tool, agent_id: agentId }] };
    throw new Error(`Unexpected query: ${sql}`);
  },
};
assert.deepEqual(await assertAgentWorkflowToolsRemainAssigned(mutationClient, {
  tenantId, agentId,
}), { validatedKnowledgeBases: 1 });

const provenance = (recordId, recordType, documentSuffix) => ({
  tenantId, agentId, knowledgeBaseId, publicationRevision: 2,
  recordId, recordType,
  documentId: `73000000-0000-4000-8100-0000000000${documentSuffix}`,
  documentVersionId: `73000000-0000-4000-8200-0000000000${documentSuffix}`,
  hydrationValidated: true, publicationValidated: true,
  documentStatus: 'ready', documentVersionStatus: 'ready', documentVersionIsCurrent: true,
});
const internalWorkflow = {
  ...provenance(workflowRecordId, 'WORKFLOW_RULE', '06'),
  id: `published:workflow_rule:${workflowRecordId}`,
  callerFacing: false,
  authoritativeData: {
    name: workflow.name,
    conditions: { intentClass: 'ACTION_TOOL_REQUEST' },
    actionType: 'configured_tool', actionConfig: workflow.action_config,
  },
};
const faqRecordId = '73000000-0000-4000-8000-000000000007';
const callerFaq = {
  ...provenance(faqRecordId, 'FAQ', '08'),
  id: `published:faq:${faqRecordId}`,
  callerFacing: true,
  authoritativeData: { question: 'Can this request be submitted?', answer: 'Yes.' },
};
const llmInput = buildGroundedLlmInput({
  input: {
    tenantId, agentId, callId: '73000000-0000-4000-8000-000000000009',
    latestQuestion: 'Please submit the request.',
    queryUnderstanding: {
      currentRouteSignal: { recordId: workflowRecordId, recordType: 'WORKFLOW_RULE' },
      actionIntent: { detected: true, authorizationRecordId: workflowRecordId },
    },
    memory: {},
  },
  classification: { intentClass: 'ACTION_TOOL_REQUEST' },
  resolution: {},
  authoritative: {
    tenantId, agentId, callId: '73000000-0000-4000-8000-000000000009',
    reservations: [{
      tenantId, knowledgeBaseId, publicationRevision: 2,
      recordId: workflowRecordId, recordType: 'WORKFLOW_RULE',
      reason: 'authorized_workflow',
    }],
    evidence: [callerFaq, internalWorkflow],
  },
  runtimeProfile: { tools: [tool], agent: { settings: {} } },
});
assert.equal(llmInput.hydratedRecords.length, 1);
assert.equal(llmInput.sourceMap.length, 0,
  'Internal Workflow authorization must remain separate from caller-facing evidence');
assert.equal(llmInput.workflowAuthorization.length, 1);
assert.equal(llmInput.workflowAuthorization[0].workflowRecordId, workflowRecordId);
assert.equal(llmInput.workflowAuthorization[0].toolId, toolId);
assert.equal(llmInput.toolSchemas[0].name, tool.name);
assert.deepEqual(llmInput.toolSchemas[0].inputSchema.required, ['contact_name']);

const compact = JSON.parse(compactGroundedDecisionInput(llmInput, 8_000, 4_000));
assert.deepEqual(compact.verifiedRecords.map((record) => record.recordType), []);
assert.equal(compact.applicableWorkflow[0].workflowRecordId, workflowRecordId);
assert.equal(compact.assignedToolSchemas[0].name, tool.name);

const finalized = finalizeConfiguredToolResults({
  input: {
    tenantId, agentId, callId: '73000000-0000-4000-8000-000000000009',
    utterance: 'Yes, submit it.', memory: {},
  },
  results: [{
    toolId, name: tool.name, verified: true, success: true,
    output: { success: true, callerMessage: 'The request was submitted.' },
  }],
  runtimeProfile: { tools: [tool] },
});
assert.equal(finalized.decision.reason, 'verified_tool_success');
assert.equal(finalized.evidence[0].recordType, 'TOOL_RESULT');
assert.equal(finalized.evidence[0].authoritativeData.verified, true);

console.log(JSON.stringify({
  task: 'workflow-tool-authorization',
  passed: true,
  publicationAssignmentValidation: true,
  assignedSchemaValidation: true,
  ambiguousIdentifierRejection: true,
  internalEvidenceSeparated: true,
  authorizedSchemaDelivered: true,
  verifiedToolResult: true,
}, null, 2));
