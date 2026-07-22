import { env } from '../../config/env.js';
import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
import { AppError } from '../../middleware/errors.js';
import { decryptCredential } from '../../security/credential-crypto.js';
import { makePlivoCall } from '../../telephony/plivo.client.js';

function answerUrl(callSessionId) {
  const separator = env.PLIVO_ANSWER_URL.includes('?') ? '&' : '?';
  return `${env.PLIVO_ANSWER_URL}${separator}call_session_id=${encodeURIComponent(callSessionId)}`;
}

async function createCallSession(input, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(`
      SELECT o.tenant_id, t.status AS tenant_status, o.status AS organization_status,
        w.status AS workspace_status,
        a.id AS agent_id, a.name AS agent_name, a.status AS agent_status,
        a.usage_direction,
        c.id AS campaign_id, c.name AS campaign_name, c.status AS campaign_status,
        pn.id AS phone_number_id, pn.e164 AS from_number, pn.status AS phone_status,
        pn.assigned_tenant_id, pa.tenant_id AS assignment_tenant_id,
        ta.id AS telephony_account_id, ta.provider, ta.status AS account_status,
        ta.auth_id, ta.auth_token_encrypted, ta.base_url
      FROM organizations o
      JOIN tenants t ON t.id=o.tenant_id AND t.deleted_at IS NULL
      JOIN workspaces w ON w.id=$2 AND w.organization_id=o.id AND w.tenant_id=o.tenant_id
        AND w.deleted_at IS NULL
      JOIN voice_agents a ON a.id=$3 AND a.tenant_id=o.tenant_id AND a.workspace_id=w.id
        AND a.deleted_at IS NULL
      JOIN campaigns c ON c.id=$4 AND c.tenant_id=o.tenant_id AND c.workspace_id=w.id
        AND c.agent_id=a.id AND c.deleted_at IS NULL
      JOIN phone_numbers pn ON pn.id=c.phone_number_id AND pn.deleted_at IS NULL
      LEFT JOIN phone_number_assignments pa ON pa.phone_number_id=pn.id
        AND pa.tenant_id=o.tenant_id AND pa.released_at IS NULL
      JOIN telephony_accounts ta ON ta.id=pn.telephony_account_id AND ta.deleted_at IS NULL
      WHERE o.id=$1 AND o.deleted_at IS NULL`,
    [input.organization_id, input.workspace_id, input.agent_id, input.campaign_id]);

    if (!result.rowCount) {
      throw new AppError(404, 'Organization, workspace, agent, or campaign was not found',
        'N8N_CALL_RESOURCES_NOT_FOUND');
    }
    const selected = result.rows[0];
    if (selected.tenant_status !== 'active' || selected.organization_status !== 'active'
      || selected.workspace_status !== 'active') {
      throw new AppError(409, 'Organization or workspace is not active', 'N8N_COMPANY_NOT_ACTIVE');
    }
    if (selected.agent_status !== 'active'
      || !['outbound', 'both'].includes(selected.usage_direction)) {
      throw new AppError(409, 'Agent is not active for outbound calls', 'N8N_AGENT_NOT_CALLABLE');
    }
    if (selected.campaign_status !== 'running') {
      throw new AppError(409, 'Campaign must be running', 'N8N_CAMPAIGN_NOT_RUNNING');
    }
    if (selected.phone_status !== 'active'
      || selected.assigned_tenant_id !== selected.tenant_id
      || selected.assignment_tenant_id !== selected.tenant_id) {
      throw new AppError(409, 'Campaign phone number is not actively assigned to this company',
        'N8N_PHONE_NOT_ASSIGNED');
    }
    if (selected.provider !== 'plivo' || selected.account_status !== 'connected') {
      throw new AppError(409, 'Campaign telephony account is unavailable', 'N8N_TELEPHONY_UNAVAILABLE');
    }

    const call = (await client.query(`INSERT INTO call_sessions
      (tenant_id,workspace_id,telephony_account_id,phone_number_id,agent_id,agent_name,
       campaign_id,campaign_name,from_number,to_number,direction,status,provider_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'outbound','queued',$11::jsonb)
      RETURNING id,status`, [
      selected.tenant_id, input.workspace_id, selected.telephony_account_id,
      selected.phone_number_id, selected.agent_id, selected.agent_name,
      selected.campaign_id, selected.campaign_name, selected.from_number,
      input.customer_number, JSON.stringify({ source: 'n8n' }),
    ])).rows[0];
    return { ...selected, callSessionId: call.id, status: call.status };
  });
}

async function updateCallSession(callSessionId, providerResponse, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(`UPDATE call_sessions
      SET provider_call_id=$2,status='ringing',ringing_at=now(),
        provider_metadata=provider_metadata||$3::jsonb
      WHERE id=$1 RETURNING status`,
    [callSessionId, providerResponse.requestUuid, JSON.stringify(providerResponse)]);
    return result.rows[0].status;
  });
}

async function failCallSession(callSessionId, error, contextRunner) {
  await contextRunner(null, (client) => client.query(`UPDATE call_sessions
    SET status='failed',ended_at=now(),provider_metadata=provider_metadata||$2::jsonb
    WHERE id=$1`, [callSessionId, JSON.stringify({ error: error.message })]));
}

export async function triggerN8nCall(input, dependencies = {}) {
  if (!env.PUBLIC_BASE_URL || !env.PLIVO_ANSWER_URL) {
    throw new AppError(503, 'Outbound calling is not configured', 'N8N_CALLING_NOT_CONFIGURED');
  }
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  const makeCall = dependencies.makeCall ?? makePlivoCall;
  const selected = await createCallSession(input, contextRunner);
  try {
    const providerResponse = await makeCall(selected.auth_id,
      decryptCredential(selected.auth_token_encrypted), {
        from: selected.from_number,
        to: input.customer_number,
        answerUrl: answerUrl(selected.callSessionId),
      }, dependencies.fetchImpl ?? fetch, selected.base_url);
    const status = await updateCallSession(selected.callSessionId, providerResponse, contextRunner);
    return { call_session_id: selected.callSessionId, status };
  } catch (error) {
    await failCallSession(selected.callSessionId, error, contextRunner);
    throw error;
  }
}
