import { AppError } from '../middleware/errors.js';
import { normalizeConfiguredToolIdentifier } from './knowledge-record-validation.js';

export const WORKFLOW_TOOL_AUTHORIZATION_VERSION = 2;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function identity(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

export function assignedToolIdentifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return Object.freeze(new Set([
    tool.id,
    tool.name,
    configuration.identifier,
    configuration.toolIdentifier,
    configuration.actionKey,
    configuration.key,
    ...(Array.isArray(tool.identifiers) ? tool.identifiers : []),
  ].map(identity).filter(Boolean)));
}

export function assignedToolInputSchema(tool = {}) {
  const configuration = object(tool.configuration);
  return object(tool.inputSchema ?? configuration.inputSchema ?? configuration.input_schema);
}

function toolSchemaIssue(tool = {}) {
  const schema = assignedToolInputSchema(tool);
  if (schema.type !== 'object') return 'tool_schema_root_must_be_object';
  if (!schema.properties || typeof schema.properties !== 'object'
    || Array.isArray(schema.properties)) return 'tool_schema_properties_invalid';
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((key) => (
    typeof key !== 'string' || !Object.hasOwn(schema.properties, key)
  ))) return 'tool_schema_required_invalid';
  if (Object.entries(schema.properties).some(([key, property]) => (
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
    || !property || typeof property !== 'object' || Array.isArray(property)
  ))) return 'tool_schema_property_invalid';
  return null;
}

export function configuredWorkflowToolIdentifier(workflow = {}) {
  const actionConfig = object(workflow.actionConfig ?? workflow.action_config
    ?? workflow.authoritativeData?.actionConfig);
  return normalizeConfiguredToolIdentifier(
    actionConfig.toolIdentifier ?? actionConfig.actionKey,
  );
}

export function validateWorkflowToolAssignments({ workflows = [], agents = [] } = {}) {
  const configuredWorkflows = workflows.flatMap((workflow) => {
    const actionType = identity(workflow.actionType ?? workflow.action_type
      ?? workflow.authoritativeData?.actionType);
    if (actionType !== 'configured_tool') return [];
    const toolIdentifier = configuredWorkflowToolIdentifier(workflow);
    return [{
      workflowRecordId: String(workflow.id ?? workflow.recordId ?? ''),
      workflowName: String(workflow.name ?? workflow.authoritativeData?.name ?? ''),
      toolIdentifier,
    }];
  });
  const issues = [];
  for (const agent of agents) {
    for (const workflow of configuredWorkflows) {
      const matches = workflow.toolIdentifier ? (agent.tools ?? []).filter((tool) => (
        assignedToolIdentifiers(tool).has(identity(workflow.toolIdentifier))
      )) : [];
      const schemaReason = matches.length === 1 ? toolSchemaIssue(matches[0]) : null;
      if (matches.length === 1 && !schemaReason) continue;
      issues.push(Object.freeze({
        agentId: String(agent.agentId ?? agent.id ?? ''),
        workflowRecordId: workflow.workflowRecordId,
        workflowName: workflow.workflowName || null,
        toolIdentifier: workflow.toolIdentifier ?? null,
        reason: !workflow.toolIdentifier ? 'tool_identifier_invalid'
          : (matches.length === 0 ? 'tool_not_assigned'
            : (matches.length > 1 ? 'tool_identifier_ambiguous' : schemaReason)),
      }));
    }
  }
  return Object.freeze(issues);
}

async function assignedAgentIds(client, tenantId, knowledgeBaseId, requestedAgentIds) {
  if (Array.isArray(requestedAgentIds)) {
    return Object.freeze([...new Set(requestedAgentIds.map(String).filter(Boolean))]);
  }
  const result = await client.query(
    `SELECT agent_id
       FROM agent_knowledge_bases
      WHERE tenant_id=$1 AND knowledge_base_id=$2
      ORDER BY agent_id`,
    [tenantId, knowledgeBaseId],
  );
  return Object.freeze(result.rows.map((row) => String(row.agent_id)));
}

export async function assertKnowledgeBaseWorkflowToolsAssigned(client, {
  tenantId, knowledgeBaseId, agentIds = null, documentVersionIds = null,
} = {}) {
  const selectedAgentIds = await assignedAgentIds(
    client, tenantId, knowledgeBaseId, agentIds,
  );
  if (!selectedAgentIds.length) return Object.freeze({ validatedAgents: 0, workflows: 0 });

  const workflowResult = await client.query(
    `SELECT workflow.id, workflow.name, workflow.action_type, workflow.action_config
       FROM workflow_rules workflow
       JOIN knowledge_document_versions version
         ON version.tenant_id=workflow.tenant_id
        AND version.knowledge_base_id=workflow.knowledge_base_id
        AND version.document_id=workflow.document_id
        AND version.id=workflow.document_version_id
       JOIN knowledge_documents document
         ON document.tenant_id=workflow.tenant_id
        AND document.knowledge_base_id=workflow.knowledge_base_id
        AND document.id=workflow.document_id
      WHERE workflow.tenant_id=$1 AND workflow.knowledge_base_id=$2
        AND workflow.status='approved' AND lower(workflow.action_type)='configured_tool'
        AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
        AND document.status='ready' AND document.deleted_at IS NULL
        AND ($3::uuid[] IS NULL OR workflow.document_version_id=ANY($3::uuid[]))
      ORDER BY workflow.id`,
    [tenantId, knowledgeBaseId,
      Array.isArray(documentVersionIds) ? documentVersionIds : null],
  );
  if (!workflowResult.rowCount) {
    return Object.freeze({ validatedAgents: selectedAgentIds.length, workflows: 0 });
  }
  const toolResult = await client.query(
    `SELECT agent_id, id, name, configuration
       FROM agent_tools
      WHERE tenant_id=$1 AND agent_id=ANY($2::uuid[])
        AND status='active' AND deleted_at IS NULL
      ORDER BY agent_id, id`,
    [tenantId, selectedAgentIds],
  );
  const toolsByAgent = new Map(selectedAgentIds.map((agentId) => [agentId, []]));
  for (const tool of toolResult.rows) {
    toolsByAgent.get(String(tool.agent_id))?.push(tool);
  }
  const issues = validateWorkflowToolAssignments({
    workflows: workflowResult.rows,
    agents: selectedAgentIds.map((agentId) => ({
      agentId,
      tools: toolsByAgent.get(agentId) ?? [],
    })),
  });
  if (issues.length) {
    throw new AppError(
      409,
      'A published Workflow must reference one active assigned tool with a valid input schema',
      'KNOWLEDGE_WORKFLOW_TOOL_NOT_ASSIGNED',
      { knowledgeBaseId, issues },
    );
  }
  return Object.freeze({
    validatedAgents: selectedAgentIds.length,
    workflows: workflowResult.rowCount,
  });
}

export async function assertAgentWorkflowToolsRemainAssigned(client, {
  tenantId, agentId,
} = {}) {
  const assignments = await client.query(
    `SELECT assignment.knowledge_base_id
       FROM agent_knowledge_bases assignment
       JOIN knowledge_bases knowledge_base
         ON knowledge_base.tenant_id=assignment.tenant_id
        AND knowledge_base.id=assignment.knowledge_base_id
      WHERE assignment.tenant_id=$1 AND assignment.agent_id=$2
        AND knowledge_base.status='published'
        AND knowledge_base.deleted_at IS NULL
      ORDER BY assignment.knowledge_base_id`,
    [tenantId, agentId],
  );
  for (const assignment of assignments.rows) {
    await assertKnowledgeBaseWorkflowToolsAssigned(client, {
      tenantId,
      knowledgeBaseId: assignment.knowledge_base_id,
      agentIds: [agentId],
    });
  }
  return Object.freeze({ validatedKnowledgeBases: assignments.rowCount });
}
