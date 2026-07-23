import { withTenantContext } from '../infrastructure/database-context.js';
import { invalidateTenantKnowledgeCache } from '../knowledge-bases/knowledge-runtime.service.js';
import { AppError } from '../middleware/errors.js';
/* test */
function mapAssignment(row) {
  return {
    agentId: row.agent_id,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeBaseName: row.knowledge_base_name,
    knowledgeBaseDescription: row.knowledge_base_description,
    knowledgeBaseStatus: row.knowledge_base_status,
    publicationRevision: row.publication_revision,
    publishedAt: row.published_at,
    usageDirection: row.usage_direction,
    knowledgeBaseUsageDirection: row.knowledge_base_usage_direction,
    priority: row.priority,
    assignedBy: row.assigned_by,
    assignedAt: row.created_at,
  };
}

function supports(configured, requested) {
  return configured === 'both' || configured === requested;
}

function effectiveDirection(agentDirection, knowledgeBaseDirection) {
  if (agentDirection === knowledgeBaseDirection) return agentDirection;
  if (agentDirection === 'both') return knowledgeBaseDirection;
  if (knowledgeBaseDirection === 'both') return agentDirection;
  return null;
}

async function getAgent(client, auth, agentId, lock = false) {
  const result = await client.query(
    `SELECT id, usage_direction
       FROM voice_agents
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND deleted_at IS NULL AND status<>'archived'
      ${lock ? 'FOR UPDATE' : ''}`,
    [auth.tenantId, auth.workspaceId, agentId],
  );
  if (!result.rowCount) throw new AppError(404, 'Voice agent was not found', 'AGENT_NOT_FOUND');
  return result.rows[0];
}

async function getPublishedKnowledgeBase(client, auth, knowledgeBaseId, lock = false) {
  const result = await client.query(
    `SELECT id, usage_direction, status
       FROM knowledge_bases
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND deleted_at IS NULL AND status<>'deleted'
      ${lock ? 'FOR UPDATE' : ''}`,
    [auth.tenantId, auth.workspaceId, knowledgeBaseId],
  );
  if (!result.rowCount) {
    throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
  }
  if (result.rows[0].status !== 'published') {
    throw new AppError(
      409,
      'Only a published company Knowledge Base can be assigned to an agent',
      'AGENT_KNOWLEDGE_BASE_NOT_PUBLISHED',
    );
  }
  return result.rows[0];
}

async function getAssignment(client, auth, agentId, knowledgeBaseId) {
  const result = await client.query(
    `SELECT akb.agent_id, akb.knowledge_base_id, akb.usage_direction, akb.priority,
            akb.assigned_by, akb.created_at,
            kb.name AS knowledge_base_name,
            kb.description AS knowledge_base_description,
            kb.status AS knowledge_base_status,
            kb.usage_direction AS knowledge_base_usage_direction,
            kb.publication_revision, kb.published_at
       FROM agent_knowledge_bases akb
       JOIN knowledge_bases kb
         ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
      WHERE akb.tenant_id=$1 AND akb.agent_id=$2 AND akb.knowledge_base_id=$3`,
    [auth.tenantId, agentId, knowledgeBaseId],
  );
  return result.rowCount ? mapAssignment(result.rows[0]) : null;
}

async function writeAudit(client, auth, action, agentId, knowledgeBaseId, before, after) {
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, workspace_id, actor_user_id, actor_type, action,
       entity_type, entity_id, before_data, after_data
     ) VALUES ($1,$2,$3,$4,$5,'agent_knowledge_base',$6,$7::jsonb,$8::jsonb)`,
    [
      auth.tenantId,
      auth.workspaceId,
      auth.userId ?? null,
      auth.authType === 'api_key' ? 'api' : 'user',
      action,
      knowledgeBaseId,
      before ? JSON.stringify({ ...before, agentId }) : null,
      after ? JSON.stringify({ ...after, agentId }) : null,
    ],
  );
}

export function listAgentKnowledgeBases(auth, agentId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await getAgent(client, auth, agentId);
    const result = await client.query(
      `SELECT akb.agent_id, akb.knowledge_base_id, akb.usage_direction, akb.priority,
              akb.assigned_by, akb.created_at,
              kb.name AS knowledge_base_name,
              kb.description AS knowledge_base_description,
              kb.status AS knowledge_base_status,
              kb.usage_direction AS knowledge_base_usage_direction,
              kb.publication_revision, kb.published_at
         FROM agent_knowledge_bases akb
         JOIN knowledge_bases kb
           ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
        WHERE akb.tenant_id=$1 AND akb.agent_id=$2
          AND kb.deleted_at IS NULL AND kb.status<>'deleted'
        ORDER BY akb.priority, akb.created_at, akb.knowledge_base_id`,
      [auth.tenantId, agentId],
    );
    return result.rows.map(mapAssignment);
  });
}

export async function assignKnowledgeBaseToAgent(
  auth,
  agentId,
  knowledgeBaseId,
  input,
  contextRunner = withTenantContext,
  invalidateCache = invalidateTenantKnowledgeCache,
) {
  const assignment = await contextRunner(auth, async (client) => {
    const agent = await getAgent(client, auth, agentId, true);
    const knowledgeBase = await getPublishedKnowledgeBase(client, auth, knowledgeBaseId, true);
    const derivedDirection = effectiveDirection(agent.usage_direction, knowledgeBase.usage_direction);
    if (!derivedDirection) {
      throw new AppError(
        409,
        'Agent and Knowledge Base usage directions are incompatible',
        'AGENT_KNOWLEDGE_BASE_DIRECTION_MISMATCH',
      );
    }
    const usageDirection = input.usageDirection ?? derivedDirection;
    if (!supports(agent.usage_direction, usageDirection)
      || !supports(knowledgeBase.usage_direction, usageDirection)) {
      throw new AppError(
        409,
        'Assignment usage direction is not supported by both the agent and Knowledge Base',
        'AGENT_KNOWLEDGE_BASE_DIRECTION_MISMATCH',
      );
    }

    const inserted = await client.query(
      `INSERT INTO agent_knowledge_bases (
         tenant_id, agent_id, knowledge_base_id, usage_direction, priority, assigned_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, agent_id, knowledge_base_id) DO NOTHING
       RETURNING knowledge_base_id`,
      [auth.tenantId, agentId, knowledgeBaseId, usageDirection, input.priority, auth.userId ?? null],
    );
    const result = await getAssignment(client, auth, agentId, knowledgeBaseId);
    if (inserted.rowCount) {
      await writeAudit(client, auth, 'AGENT_KNOWLEDGE_BASE_ASSIGNED', agentId, knowledgeBaseId, null, result);
    }
    return { ...result, created: inserted.rowCount > 0 };
  });
  if (assignment.created) await invalidateCache(auth.tenantId);
  return assignment;
}

export async function unassignKnowledgeBaseFromAgent(
  auth,
  agentId,
  knowledgeBaseId,
  contextRunner = withTenantContext,
  invalidateCache = invalidateTenantKnowledgeCache,
) {
  const removed = await contextRunner(auth, async (client) => {
    await getAgent(client, auth, agentId, true);
    const before = await getAssignment(client, auth, agentId, knowledgeBaseId);
    if (!before) {
      throw new AppError(404, 'Knowledge Base assignment was not found', 'AGENT_KNOWLEDGE_BASE_ASSIGNMENT_NOT_FOUND');
    }
    await client.query(
      `DELETE FROM agent_knowledge_bases
        WHERE tenant_id=$1 AND agent_id=$2 AND knowledge_base_id=$3`,
      [auth.tenantId, agentId, knowledgeBaseId],
    );
    await writeAudit(client, auth, 'AGENT_KNOWLEDGE_BASE_UNASSIGNED', agentId, knowledgeBaseId, before, null);
    return { agentId, knowledgeBaseId, deleted: true };
  });
  await invalidateCache(auth.tenantId);
  return removed;
}
