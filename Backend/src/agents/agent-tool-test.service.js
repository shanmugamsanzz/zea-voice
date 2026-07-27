import crypto from 'node:crypto';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { executeAgentTool } from '../voice/tools/tool-executor.service.js';

function secretConfiguration(row) {
  if (!row.secret_configuration_encrypted) return null;
  try { return JSON.parse(decryptCredential(row.secret_configuration_encrypted)); } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'Stored tool credentials are invalid', 'VOICE_TOOL_SECRET_INVALID');
  }
}

export async function testAgentTool(auth, agentId, toolId, input, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  const tool = await contextRunner(auth, async (client) => {
    const result = await client.query(`
      SELECT t.*
        FROM agent_tools t
        JOIN voice_agents a ON a.id=t.agent_id AND a.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND t.agent_id=$3 AND t.id=$4
         AND t.status='active' AND t.deleted_at IS NULL AND a.deleted_at IS NULL
    `, [auth.tenantId, auth.workspaceId, agentId, toolId]);
    if (!result.rowCount) throw new AppError(404, 'Active agent tool was not found', 'AGENT_TOOL_NOT_FOUND');
    const row = result.rows[0];
    return {
      id: row.id, name: row.name, type: row.type, description: row.description,
      configuration: row.configuration ?? {}, secretConfiguration: secretConfiguration(row),
    };
  });
  return executeAgentTool({
    agent: { id: agentId, tenantId: auth.tenantId, workspaceId: auth.workspaceId },
    tools: [tool],
  }, {
    id: `tool-test-${crypto.randomUUID()}`, providerCallId: null, direction: 'test',
  }, {
    id: `test-${crypto.randomUUID()}`, name: tool.name, arguments: input.arguments,
  }, dependencies);
}
