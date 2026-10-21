import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

export const queueOutcomes = Object.freeze({
  caller_left: 'Caller left waiting queue',
  expired: 'Waiting time expired',
  full: 'Waiting queue full',
});

// Called only after provider signature validation and company/agent resolution.
export function recordInboundQueue({ call, agent, admission }, dependencies = {}) {
  const run = dependencies.contextRunner ?? (operation => withPlatformAdminContext(null, operation));
  return run(async client => {
    if (call.direction !== 'inbound' || call.capacityTenantId !== agent.tenantId) {
      throw new AppError(409, 'Inbound queue scope mismatch', 'INBOUND_QUEUE_SCOPE_MISMATCH');
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      [call.telephonyAccountId, call.providerCallId]);
    const found = await client.query(`SELECT * FROM call_sessions
      WHERE telephony_account_id=$1 AND provider_call_id=$2 FOR UPDATE`, [call.telephonyAccountId, call.providerCallId]);
    let row = found.rows[0];
    if (row && (row.tenant_id !== agent.tenantId || row.workspace_id !== agent.workspaceId
      || row.agent_id !== agent.agentId || row.from_number !== call.from || row.to_number !== call.to)) {
      throw new AppError(409, 'Inbound queue call identity conflict', 'INBOUND_QUEUE_SCOPE_MISMATCH');
    }
    if (!row) {
      row = (await client.query(`INSERT INTO call_sessions
        (tenant_id,workspace_id,telephony_account_id,phone_number_id,provider_call_id,
         agent_id,agent_name,from_number,to_number,direction,status,ringing_at,provider_metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'inbound','queued',now(),
          jsonb_build_object('source','plivo-answer','inboundQueue',
            jsonb_build_object('state','waiting','arrivedAt',now(),'waitSeconds',0))) RETURNING *`,
      [agent.tenantId, agent.workspaceId, call.telephonyAccountId, call.phoneNumberId,
        call.providerCallId, agent.agentId, agent.agentName, call.from, call.to])).rows[0];
    }
    if (admission.status === 'ended' || admission.status === 'full') {
      row = await finishInboundQueueRow(client, row, admission.status === 'full' ? 'full' : 'expired');
    }
    return { id: row.id, tenantId: row.tenant_id, status: row.status };
  });
}

// Locking caller must supply the persisted row, never client-provided tenant IDs.
export async function finishInboundQueueRow(client, row, reason) {
  if (!queueOutcomes[reason]) throw new TypeError('Invalid queue outcome');
  if (row.ended_at || row.status !== 'queued' || row.answered_at
    || row.provider_metadata?.inboundQueue?.state !== 'waiting') return row;
  const result = await client.query(`UPDATE call_sessions SET status=$3::call_status,
    ended_at=now(),duration_seconds=0,
    provider_metadata=jsonb_set(provider_metadata,'{inboundQueue}',
      (provider_metadata->'inboundQueue') || jsonb_build_object(
        'state',$4::text,'outcome',$5::text,'endedAt',now(),
        'waitSeconds',GREATEST(0,floor(extract(epoch FROM (now()-started_at)))::int)),true)
    WHERE id=$1 AND tenant_id=$2 AND status='queued' AND ended_at IS NULL
      AND answered_at IS NULL RETURNING *`,
  [row.id, row.tenant_id, reason === 'caller_left' ? 'canceled' : 'no_answer', reason, queueOutcomes[reason]]);
  return result.rows[0] ?? row;
}
