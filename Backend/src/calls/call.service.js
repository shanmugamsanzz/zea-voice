import { AppError } from '../middleware/errors.js';
import { withAuthServiceContext, withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { hangupPlivoCall } from '../telephony/plivo.client.js';

const activeStatuses = ['queued', 'ringing', 'connected'];
const number = (value) => Number(value);

function mapCall(row, includeTranscript = false) {
  const call = {
    id: row.id, companyId: row.tenant_id, workspaceId: row.workspace_id,
    companyName: row.company_name, providerCallId: row.provider_call_id,
    agentId: row.agent_id, agentName: row.agent_name,
    campaignId: row.campaign_id, campaignName: row.campaign_name,
    phoneNumberId: row.phone_number_id, fromNumber: row.from_number, toNumber: row.to_number,
    direction: row.direction, status: row.status, sentiment: row.sentiment,
    startedAt: row.started_at, ringingAt: row.ringing_at, answeredAt: row.answered_at,
    endedAt: row.ended_at, durationSeconds: row.live_duration_seconds === undefined
      ? row.duration_seconds : number(row.live_duration_seconds),
    cost: number(row.cost), currency: row.currency,
    recordingAvailable: Boolean(row.recording_object_key),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (includeTranscript) call.transcript = row.transcript ?? [];
  return call;
}

const callSelect = `SELECT c.*, o.name AS company_name,
  CASE WHEN c.status IN ('queued', 'ringing', 'connected')
    THEN GREATEST(c.duration_seconds, floor(extract(epoch FROM (now() - c.started_at)))::int)
    ELSE c.duration_seconds END AS live_duration_seconds
  FROM call_sessions c JOIN organizations o ON o.tenant_id = c.tenant_id AND o.deleted_at IS NULL`;

function contextFor(auth, operation) {
  return auth.role === 'SUPER_ADMIN'
    ? withPlatformAdminContext(auth.userId, operation)
    : withTenantContext(auth, operation);
}

export function listCalls(auth, filters) {
  return contextFor(auth, async (client) => {
    const companyId = auth.role === 'SUPER_ADMIN' ? filters.companyId ?? null : auth.tenantId;
    const values = [companyId, filters.status ?? null, filters.direction ?? null,
      filters.search ?? null, filters.activeOnly];
    const where = `WHERE ($1::uuid IS NULL OR c.tenant_id = $1)
      AND ($2::call_status IS NULL OR c.status = $2)
      AND ($3::call_direction IS NULL OR c.direction = $3)
      AND ($4::text IS NULL OR c.from_number ILIKE '%' || $4 || '%'
        OR c.to_number ILIKE '%' || $4 || '%' OR c.agent_name ILIKE '%' || $4 || '%')
      AND (NOT $5::boolean OR c.status IN ('queued', 'ringing', 'connected'))`;
    const offset = (filters.page - 1) * filters.pageSize;
    const result = await client.query(`SELECT listed.*, count(*) OVER()::int AS full_count
      FROM (${callSelect} ${where}) listed
      ORDER BY listed.started_at DESC LIMIT $6 OFFSET $7`, [...values, filters.pageSize, offset]);
    const total = result.rows[0]?.full_count ?? 0;
    return { items: result.rows.map((row) => mapCall(row)), pagination: {
      page: filters.page, pageSize: filters.pageSize, total,
      totalPages: Math.ceil(total / filters.pageSize),
    } };
  });
}

export function getCall(auth, callId) {
  return contextFor(auth, async (client) => {
    const companyId = auth.role === 'SUPER_ADMIN' ? null : auth.tenantId;
    const result = await client.query(`${callSelect} WHERE c.id = $1
      AND ($2::uuid IS NULL OR c.tenant_id = $2)`, [callId, companyId]);
    if (!result.rowCount) throw new AppError(404, 'Call was not found', 'CALL_NOT_FOUND');
    const transcript = await client.query(`SELECT id, sequence_number AS "sequenceNumber", speaker,
      text, offset_ms AS "offsetMs", is_final AS "isFinal", created_at AS "createdAt"
      FROM call_transcript_entries WHERE call_session_id = $1 ORDER BY sequence_number`, [callId]);
    return mapCall({ ...result.rows[0], transcript: transcript.rows }, true);
  });
}

export function forceHangup(actorUserId, callId, reason, fetchImpl = fetch) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(`${callSelect}
      JOIN telephony_accounts a ON a.id = c.telephony_account_id
      WHERE c.id = $1 FOR UPDATE OF c`, [callId]);
    if (!result.rowCount) throw new AppError(404, 'Call was not found', 'CALL_NOT_FOUND');
    const call = result.rows[0];
    if (!activeStatuses.includes(call.status)) {
      throw new AppError(409, 'Only an active call can be hung up', 'CALL_NOT_ACTIVE');
    }
    if (!call.provider_call_id) throw new AppError(409, 'Call has no provider call identifier', 'PROVIDER_CALL_ID_MISSING');
    const provider = await client.query('SELECT * FROM telephony_accounts WHERE id = $1', [call.telephony_account_id]);
    const account = provider.rows[0];
    if (account.provider !== 'plivo') throw new AppError(400, 'Unsupported telephony provider', 'UNSUPPORTED_TELEPHONY_PROVIDER');
    const providerResponse = await hangupPlivoCall(account.auth_id,
      decryptCredential(account.auth_token_encrypted), call.provider_call_id, fetchImpl, account.base_url);
    const updated = (await client.query(`UPDATE call_sessions SET status = 'canceled', ended_at = now(),
      duration_seconds = GREATEST(duration_seconds, floor(extract(epoch FROM (now() - started_at)))::int)
      WHERE id = $1 RETURNING *`, [callId])).rows[0];
    await client.query(`INSERT INTO call_control_events
      (call_session_id, tenant_id, action, reason, actor_user_id, provider_response)
      VALUES ($1, $2, 'force_hangup', $3, $4, $5::jsonb)`,
    [callId, call.tenant_id, reason, actorUserId, JSON.stringify(providerResponse)]);
    await client.query(`INSERT INTO audit_logs
      (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
      VALUES ($1, $2, $3, 'user', 'CALL_FORCE_HANGUP', 'call_session', $4, $5::jsonb)`,
    [call.tenant_id, call.workspace_id, actorUserId, callId, JSON.stringify({ reason, providerResponse })]);
    return mapCall({ ...updated, company_name: call.company_name, live_duration_seconds: updated.duration_seconds });
  });
}

export function createCallSession(input) {
  return withAuthServiceContext(async (client) => {
    const result = await client.query(`INSERT INTO call_sessions
      (tenant_id, workspace_id, telephony_account_id, phone_number_id, provider_call_id,
       agent_id, agent_name, campaign_id, campaign_name, from_number, to_number, direction,
       status, ringing_at, answered_at, provider_metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING *`, [
      input.tenantId, input.workspaceId, input.telephonyAccountId ?? null, input.phoneNumberId ?? null,
      input.providerCallId ?? null, input.agentId ?? null, input.agentName ?? null,
      input.campaignId ?? null, input.campaignName ?? null, input.fromNumber, input.toNumber,
      input.direction, input.status ?? 'queued', input.ringingAt ?? null, input.answeredAt ?? null,
      JSON.stringify(input.providerMetadata ?? {}),
    ]);
    return mapCall(result.rows[0]);
  });
}

export function appendTranscriptEntry(input) {
  return withAuthServiceContext(async (client) => {
    const call = await client.query('SELECT tenant_id FROM call_sessions WHERE id = $1', [input.callId]);
    if (!call.rowCount) throw new AppError(404, 'Call was not found', 'CALL_NOT_FOUND');
    const result = await client.query(`INSERT INTO call_transcript_entries
      (call_session_id, tenant_id, sequence_number, speaker, text, offset_ms, is_final)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [input.callId, call.rows[0].tenant_id,
      input.sequenceNumber, input.speaker, input.text, input.offsetMs ?? 0, input.isFinal ?? true]);
    return result.rows[0];
  });
}
