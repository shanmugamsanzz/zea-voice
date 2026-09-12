import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { encryptCredential } from '../security/credential-crypto.js';
import { validateToolHeaders, validateWebhookEndpoint } from '../voice/tools/tool-security.js';

function tool(row) {
  return {
    id: row.id, agentId: row.agent_id, name: row.name, type: row.type,
    description: row.description, status: row.status, configuration: row.configuration,
    hasSecretConfiguration: Boolean(row.secret_configuration_encrypted),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function ensureToolAgent(client, auth, agentId) {
  const result = await client.query(
    'SELECT id FROM voice_agents WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL',
    [auth.tenantId, auth.workspaceId, agentId],
  );
  if (!result.rowCount) throw new AppError(404, 'Voice agent was not found', 'AGENT_NOT_FOUND');
}

async function validateToolInput(input) {
  if (input.type !== 'webhook_api') return;
  input.configuration.url = await validateWebhookEndpoint(input.configuration.url, { resolveDns: false });
  validateToolHeaders(input.configuration.headers);
  const secretHeaders = input.secretConfiguration?.headers ?? input.secretConfiguration ?? {};
  validateToolHeaders(secretHeaders, { secret: true });
}

export function listTools(auth, agentId) {
  return withTenantContext(auth, async (client) => {
    await ensureToolAgent(client, auth, agentId);
    const result = await client.query(
      'SELECT * FROM agent_tools WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND deleted_at IS NULL ORDER BY created_at',
      [auth.tenantId, auth.workspaceId, agentId],
    );
    return result.rows.map(tool);
  });
}

export function createTool(auth, agentId, input) {
  return withTenantContext(auth, async (client) => {
    await ensureToolAgent(client, auth, agentId);
    await validateToolInput(input);
    try {
      const result = await client.query(
        `INSERT INTO agent_tools(tenant_id,workspace_id,agent_id,name,type,description,status,configuration,secret_configuration_encrypted,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
        [auth.tenantId, auth.workspaceId, agentId, input.name, input.type, input.description ?? null,
          input.status, JSON.stringify(input.configuration), input.secretConfiguration
            ? encryptCredential(JSON.stringify(input.secretConfiguration)) : null, auth.userId],
      );
      return tool(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Tool name already exists for this agent', 'AGENT_TOOL_EXISTS');
      throw error;
    }
  });
}

export function updateTool(auth, agentId, id, input) {
  return withTenantContext(auth, async (client) => {
    await ensureToolAgent(client, auth, agentId);
    await validateToolInput(input);
    try {
      const encryptedSecret = input.secretConfiguration
        ? encryptCredential(JSON.stringify(input.secretConfiguration)) : null;
      const result = await client.query(
        `UPDATE agent_tools SET name=$5,type=$6,description=$7,status=$8,configuration=$9::jsonb,
           secret_configuration_encrypted=CASE WHEN $10::text IS NULL THEN secret_configuration_encrypted ELSE $10 END
         WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND id=$4 AND deleted_at IS NULL RETURNING *`,
        [auth.tenantId, auth.workspaceId, agentId, id, input.name, input.type, input.description ?? null,
          input.status, JSON.stringify(input.configuration), encryptedSecret],
      );
      if (!result.rowCount) throw new AppError(404, 'Agent tool was not found', 'AGENT_TOOL_NOT_FOUND');
      return tool(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Tool name already exists for this agent', 'AGENT_TOOL_EXISTS');
      throw error;
    }
  });
}

export function updateToolStatus(auth, agentId, id, status) {
  return withTenantContext(auth, async (client) => {
    await ensureToolAgent(client, auth, agentId);
    const result = await client.query(
      'UPDATE agent_tools SET status=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND id=$4 AND deleted_at IS NULL RETURNING *',
      [auth.tenantId, auth.workspaceId, agentId, id, status],
    );
    if (!result.rowCount) throw new AppError(404, 'Agent tool was not found', 'AGENT_TOOL_NOT_FOUND');
    return tool(result.rows[0]);
  });
}

export function deleteTool(auth, agentId, id) {
  return withTenantContext(auth, async (client) => {
    await ensureToolAgent(client, auth, agentId);
    const result = await client.query(
      "UPDATE agent_tools SET deleted_at=now(),status='inactive' WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND id=$4 AND deleted_at IS NULL RETURNING id",
      [auth.tenantId, auth.workspaceId, agentId, id],
    );
    if (!result.rowCount) throw new AppError(404, 'Agent tool was not found', 'AGENT_TOOL_NOT_FOUND');
    return { id, deleted: true };
  });
}
