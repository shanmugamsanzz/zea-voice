import { randomUUID } from 'node:crypto';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

export function createTransferRepository(context = withPlatformAdminContext) {
  const run = operation => context(null, operation);
  async function settings(client, call) {
    const result = await client.query(`SELECT s.*,a.auth_id AS account_auth_id,
      a.auth_token_encrypted AS account_token,COALESCE(p.auth_token_encrypted,a.auth_token_encrypted) AS main_token,
      CASE WHEN c.direction='outbound' THEN c.from_number ELSE c.to_number END AS caller_id,
      cb.id AS resolved_callback_tool_id
      FROM call_sessions c JOIN agent_call_transfer_settings s ON s.agent_id=c.agent_id
        AND s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id
      JOIN telephony_accounts a ON a.id=s.telephony_account_id AND a.id=c.telephony_account_id
        AND a.tenant_id=c.tenant_id AND a.provider='plivo' AND a.account_type='subaccount'
        AND a.status='connected' AND a.deleted_at IS NULL
      LEFT JOIN telephony_accounts p ON p.id=a.parent_account_id AND p.deleted_at IS NULL
      LEFT JOIN agent_tools cb ON cb.id=s.callback_tool_id AND cb.agent_id=c.agent_id
        AND cb.tenant_id=c.tenant_id AND cb.workspace_id=c.workspace_id AND cb.status='active'
        AND cb.type='webhook_api' AND cb.deleted_at IS NULL
      WHERE c.id=$1 AND c.tenant_id=$2 AND c.workspace_id=$3 AND c.agent_id=$4
        AND c.provider_call_id=$5 AND c.ended_at IS NULL AND c.status='connected' AND s.enabled=true`,
    [call.id, call.tenantId, call.workspaceId, call.agentId, call.providerCallId]);
    return result.rows[0] ?? null;
  }
  return {
    enabled: call => run(async client => Boolean(await settings(client, call))),
    reserve: call => run(async client => {
      // Serialize concurrent requests before issuing any Plivo request.
      const locked = await client.query(`SELECT id FROM call_sessions WHERE id=$1 AND tenant_id=$2
        AND workspace_id=$3 AND agent_id=$4 AND provider_call_id=$5 AND ended_at IS NULL FOR UPDATE`,
      [call.id, call.tenantId, call.workspaceId, call.agentId, call.providerCallId]);
      if (!locked.rowCount) throw new AppError(409, 'Call is no longer active', 'TRANSFER_CALL_ENDED');
      const active = await client.query(`SELECT * FROM call_transfer_attempts WHERE call_id=$1
        AND state IN ('requested','ringing','bridged','resuming')`, [call.id]);
      if (active.rowCount) return { attempt: active.rows[0], duplicate: true };
      const value = await settings(client, call);
      if (!value || (value.credential_source === 'manual' && value.auth_id !== value.account_auth_id)) {
        throw new AppError(403, 'Transfer account must own this active call', 'TRANSFER_ACCOUNT_NOT_ALLOWED');
      }
      const created = await client.query(`INSERT INTO call_transfer_attempts
        (id,call_id,tenant_id,workspace_id,provider_call_id,state,mode,destination_number,caller_id,
         ring_timeout_seconds,auth_id,auth_token_encrypted,main_auth_token_encrypted,callback_tool_id)
        VALUES($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [randomUUID(), call.id, call.tenantId, call.workspaceId, call.providerCallId, value.transfer_mode,
        value.destination_number, value.caller_id, value.ring_timeout_seconds, value.account_auth_id,
        value.credential_source === 'manual' ? value.auth_token_encrypted : value.account_token, value.main_token,
        value.resolved_callback_tool_id ?? null]);
      return { attempt: created.rows[0], duplicate: false };
    }),
    get: id => run(async client => {
      const result = await client.query(`SELECT t.*,c.ended_at AS call_ended_at FROM call_transfer_attempts t
        JOIN call_sessions c ON c.id=t.call_id WHERE t.id=$1`, [id]);
      return result.rows[0] ?? null;
    }),
    saveResumeXml: (id, response) => run(async client => {
      const result = await client.query(`UPDATE call_transfer_attempts SET resume_xml=COALESCE(resume_xml,$2)
        WHERE id=$1 AND state IN ('resuming','returned') RETURNING resume_xml`, [id, response]);
      return result.rows[0]?.resume_xml ?? null;
    }),
    transition: (id, states, next, { staffCallId = null, result = null } = {}) => run(async client => {
      const updated = await client.query(`UPDATE call_transfer_attempts SET state=$3,
        staff_call_id=COALESCE(staff_call_id,$4),result=COALESCE($5,result),updated_at=now()
        WHERE id=$1 AND state=ANY($2::text[]) RETURNING *`, [id, states, next, staffCallId, result]);
      return updated.rows[0] ?? null;
    }),
    cancelCall: providerCallId => run(async client => {
      const rows = await client.query(`UPDATE call_transfer_attempts SET state='canceled',updated_at=now()
        WHERE provider_call_id=$1 AND state IN ('requested','ringing','bridged','resuming') RETURNING *`, [providerCallId]);
      return rows.rows;
    }),
  };
}
