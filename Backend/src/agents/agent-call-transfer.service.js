import { withTenantContext, withPlatformAdminContext } from '../infrastructure/database-context.js';
import { encryptCredential } from '../security/credential-crypto.js';
import { AppError } from '../middleware/errors.js';
import { callTransferSettingsSchema } from './agent-call-transfer.schemas.js';
import { isCallTransferEnabledForAgent } from '../voice/call-transfer-feature.js';

function publicSettings(row) {
  if (!row) return null;
  return { enabled: row.enabled, credentialSource: row.credential_source,
    telephonyAccountId: row.credential_source === 'saved_account' ? row.telephony_account_id : null,
    authId: row.auth_id ?? '', hasAuthToken: Boolean(row.auth_token_encrypted),
    destinationNumber: row.destination_number, mode: row.transfer_mode,
    ringTimeoutSeconds: row.ring_timeout_seconds, callbackToolId: row.callback_tool_id ?? null, updatedAt: row.updated_at };
}

async function callbackTools(client, auth, agentId) {
  const result = await client.query(`SELECT id,name FROM agent_tools
    WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND deleted_at IS NULL
      AND status='active' AND type='webhook_api' ORDER BY name`, [auth.tenantId, auth.workspaceId, agentId]);
  return result.rows;
}

async function assertAgent(client, auth, agentId, lock = false) {
  const result = await client.query(`SELECT id FROM voice_agents
    WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
    ${lock ? 'FOR UPDATE' : ''}`, [auth.tenantId, auth.workspaceId, agentId]);
  if (!result.rowCount) throw new AppError(404, 'Agent was not found in this workspace', 'AGENT_NOT_FOUND');
}

// Telephony accounts have admin-only RLS. Explicit tenant scoping is mandatory
// inside this narrow privileged query; no tokens are selected or returned.
async function companyAccounts(auth, dependencies) {
  const context = dependencies.accountContextRunner ?? withPlatformAdminContext;
  return context(auth.userId, async (client) => {
    const result = await client.query(`SELECT id,name,auth_id FROM telephony_accounts
      WHERE tenant_id=$1 AND provider='plivo' AND account_type='subaccount'
        AND status='connected' AND deleted_at IS NULL ORDER BY name`, [auth.tenantId]);
    return result.rows;
  });
}

async function readRow(client, auth, agentId) {
  const result = await client.query(`SELECT * FROM agent_call_transfer_settings
    WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3`, [auth.tenantId, auth.workspaceId, agentId]);
  return result.rows[0] ?? null;
}

export function getCallTransferSettings(auth, agentId, dependencies = {}) {
  return (dependencies.contextRunner ?? withTenantContext)(auth, async (client) => {
    await assertAgent(client, auth, agentId);
    const accounts = await companyAccounts(auth, dependencies);
    return { settings: publicSettings(await readRow(client, auth, agentId)),
      accounts: accounts.map((row) => ({ id: row.id, name: row.name, authId: row.auth_id })),
      callbackTools: await callbackTools(client, auth, agentId),
      runtimeAvailable: isCallTransferEnabledForAgent(agentId) };
  });
}

export function saveCallTransferSettings(auth, agentId, input, dependencies = {}) {
  const parsed = callTransferSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'Invalid call transfer settings', 'VALIDATION_ERROR',
    parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  const value = parsed.data;
  return (dependencies.contextRunner ?? withTenantContext)(auth, async (client) => {
    await assertAgent(client, auth, agentId, true);
    const accounts = await companyAccounts(auth, dependencies);
    const account = accounts.find((row) => value.credentialSource === 'saved_account'
      ? row.id === value.telephonyAccountId : row.auth_id === value.authId);
    if (!account) throw new AppError(400, 'Select a Plivo subaccount registered to this company', 'TRANSFER_ACCOUNT_NOT_ALLOWED');
    const prior = await readRow(client, auth, agentId);
    const callbackToolId = value.callbackToolId === undefined ? prior?.callback_tool_id ?? null : value.callbackToolId;
    if (callbackToolId && !(await callbackTools(client, auth, agentId)).some(tool => tool.id === callbackToolId)) {
      throw new AppError(400, 'Select an active callback webhook assigned to this agent and workspace', 'TRANSFER_CALLBACK_TOOL_NOT_ALLOWED');
    }
    let encryptedToken = null;
    if (value.credentialSource === 'manual') {
      encryptedToken = value.authToken
        ? (dependencies.encryptCredential ?? encryptCredential)(value.authToken)
        : prior?.credential_source === 'manual' && prior.auth_id === value.authId
          ? prior.auth_token_encrypted : null;
      if (!encryptedToken) throw new AppError(400, 'Enter the Auth Token for this subaccount', 'TRANSFER_TOKEN_REQUIRED');
    }
    const result = await client.query(`INSERT INTO agent_call_transfer_settings
      (agent_id,tenant_id,workspace_id,enabled,credential_source,telephony_account_id,
       auth_id,auth_token_encrypted,destination_number,transfer_mode,ring_timeout_seconds,updated_by,callback_tool_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(agent_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        credential_source=EXCLUDED.credential_source,telephony_account_id=EXCLUDED.telephony_account_id,
        auth_id=EXCLUDED.auth_id,auth_token_encrypted=EXCLUDED.auth_token_encrypted,
        destination_number=EXCLUDED.destination_number,transfer_mode=EXCLUDED.transfer_mode,
        ring_timeout_seconds=EXCLUDED.ring_timeout_seconds,callback_tool_id=EXCLUDED.callback_tool_id,
        updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE agent_call_transfer_settings.tenant_id=EXCLUDED.tenant_id
        AND agent_call_transfer_settings.workspace_id=EXCLUDED.workspace_id RETURNING *`,
    [agentId, auth.tenantId, auth.workspaceId, value.enabled, value.credentialSource, account.id,
      value.credentialSource === 'manual' ? value.authId : null, encryptedToken,
      value.destinationNumber, value.mode, value.ringTimeoutSeconds, auth.userId ?? null, callbackToolId]);
    if (!result.rowCount) throw new AppError(409, 'Agent ownership changed; reload settings', 'TRANSFER_SETTINGS_CONFLICT');
    return { settings: publicSettings(result.rows[0]), runtimeAvailable: isCallTransferEnabledForAgent(agentId) };
  });
}

export function deleteCallTransferSettings(auth, agentId, dependencies = {}) {
  return (dependencies.contextRunner ?? withTenantContext)(auth, async (client) => {
    await assertAgent(client, auth, agentId, true);
    await client.query(`DELETE FROM agent_call_transfer_settings
      WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3`, [auth.tenantId, auth.workspaceId, agentId]);
    return { settings: null, runtimeAvailable: isCallTransferEnabledForAgent(agentId) };
  });
}
