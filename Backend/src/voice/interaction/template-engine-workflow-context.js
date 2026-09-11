import { withTenantContext } from '../../infrastructure/database-context.js';

function directionAllowed(configured, requested) {
  const value = String(configured ?? 'both').toLowerCase();
  const current = String(requested ?? 'both').toLowerCase();
  return value === 'both' || current === 'both' || value === current;
}

function workflowRecord(row, agentId) {
  return Object.freeze({
    id: String(row.id),
    recordId: String(row.id),
    recordType: 'WORKFLOW_RULE',
    tenantId: String(row.tenant_id),
    agentId: String(agentId),
    knowledgeBaseId: String(row.knowledge_base_id),
    publicationRevision: Number(row.publication_revision),
    name: row.name,
    intent: row.intent,
    priority: Number(row.priority),
    usageDirection: row.usage_direction,
    conditions: row.conditions ?? {},
    actionType: row.action_type,
    actionConfig: row.action_config ?? {},
    responseTemplate: row.response_template ?? null,
    authoritativeData: Object.freeze({
      name: row.name,
      intent: row.intent,
      priority: Number(row.priority),
      conditions: row.conditions ?? {},
      actionType: row.action_type,
      actionConfig: row.action_config ?? {},
      responseTemplate: row.response_template ?? null,
    }),
    published: true,
    status: 'published',
  });
}

/**
 * Loads only executable workflow configuration. It deliberately does not load
 * document text, chunks, publication bundles, catalog records, or embeddings.
 */
export async function loadTemplateEngineWorkflowContext({
  auth, scope, usageDirection,
} = {}, dependencies = {}) {
  const query = dependencies.query ?? (async (values) => withTenantContext(auth, async (client) => {
    const result = await client.query(
      `SELECT workflow.id, workflow.tenant_id, workflow.knowledge_base_id,
              workflow.name, workflow.intent, workflow.priority,
              workflow.usage_direction, workflow.conditions,
              workflow.action_type, workflow.action_config,
              workflow.response_template, knowledge_base.publication_revision
         FROM agent_knowledge_bases assignment
         JOIN knowledge_bases knowledge_base
           ON knowledge_base.tenant_id=assignment.tenant_id
          AND knowledge_base.id=assignment.knowledge_base_id
         JOIN workflow_rules workflow
           ON workflow.tenant_id=assignment.tenant_id
          AND workflow.knowledge_base_id=assignment.knowledge_base_id
        WHERE assignment.tenant_id=$1 AND assignment.agent_id=$2
          AND knowledge_base.status='published'
          AND knowledge_base.deleted_at IS NULL
          AND workflow.status='approved'
        ORDER BY workflow.priority, workflow.id`,
      values,
    );
    return result.rows;
  }));
  const rows = await query([scope.tenantId, scope.agentId]);
  const publishedWorkflows = rows
    .filter((row) => directionAllowed(row.usage_direction, usageDirection))
    .map((row) => workflowRecord(row, scope.agentId));
  const publications = [...new Map(publishedWorkflows.map((workflow) => [
    `${workflow.knowledgeBaseId}:${workflow.publicationRevision}`,
    Object.freeze({
      tenantId: workflow.tenantId,
      knowledgeBaseId: workflow.knowledgeBaseId,
      publicationRevision: workflow.publicationRevision,
    }),
  ])).values()];
  return Object.freeze({
    scope: Object.freeze({ ...scope, publications: Object.freeze(publications) }),
    publishedWorkflows: Object.freeze(publishedWorkflows),
    publishedConversationGuidance: Object.freeze([]),
  });
}
