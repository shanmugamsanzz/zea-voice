import { randomUUID } from 'node:crypto';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { logger } from '../config/logger.js';
import { voiceCallOwnership } from '../voice/call-ownership.service.js';
import { outboundReservationTtlSeconds } from '../voice/call-capacity.service.js';
import { assertOutboundQueueSpace } from '../queues/outbound-queue-capacity.service.js';
import { loadPhoneTestAccount, dialPhoneTest } from './agent-phone-test.service.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { requireCompanyCallQueueEnabled } from '../queues/company-queue-feature.js';

const runFor = deps => deps.contextRunner ?? withPlatformAdminContext;
const ownershipFor = deps => deps.ownership ?? voiceCallOwnership;
function response(row) {
  return { id: row.id, requestId: row.provider_request_id ?? null, phone: row.phone,
    agentId: row.agent_id, status: row.status, reason: row.queue_reason, error: row.last_error ?? null };
}
async function reserve(auth, agentId, phone, id, account, deps) {
  await ownershipFor(deps).acquire({ tenantId: auth.tenantId, providerCallId: id,
    limit: account.max_total_concurrency, ttlSeconds: outboundReservationTtlSeconds,
    metadata: { phone, agentId, agentName: account.name, direction: 'outbound', source: 'phone_test' } });
}
const waitable = error => ['VOICE_COMPANY_CONCURRENCY_LIMIT','VOICE_COORDINATION_UNAVAILABLE'].includes(error.code);

async function dispatch(row, account, deps) {
  const run = runFor(deps);
  const auth = { userId: row.created_by, tenantId: row.tenant_id, workspaceId: row.workspace_id };
  let result;
  try {
    result = await dialPhoneTest(auth, row.agent_id, row.phone, account, row.id, deps);
  } catch (error) {
    await run(auth.userId, client => client.query(`UPDATE agent_phone_test_requests SET status='failed',last_error=$3,updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='dispatching'`, [row.id, auth.tenantId, error.code ?? 'PHONE_TEST_DISPATCH_FAILED']));
    logger.warn({ stage: 'phone_test.dispatch_failed', requestId: row.id, errorCode: error.code }, 'Queued phone test dispatch failed');
    return response({ ...row, status: 'failed', last_error: error.code ?? 'PHONE_TEST_DISPATCH_FAILED' });
  }
  // If this save fails after provider acceptance, leave dispatching intact.
  // Recovery never redials an ambiguous request, preventing duplicate calls.
  await run(auth.userId, client => client.query(`UPDATE agent_phone_test_requests SET status='initiated',provider_request_id=$3,updated_at=now()
    WHERE id=$1 AND tenant_id=$2 AND status='dispatching'`, [row.id, auth.tenantId, result.requestId]));
  return response({ ...row, status: 'initiated', provider_request_id: result.requestId });
}

export async function submitQueuedPhoneTest(auth, agentId, input, deps = {}) {
  const run = runFor(deps);
  let acquired = false;
  const id = randomUUID();
  const key = input.requestId ?? randomUUID();
  let saved;
  try {
    saved = await run(auth.userId, async client => {
      // Serialize submissions/dispatch with the shared company queue limit.
      await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [auth.tenantId]);
      if (input.shareLinkId) {
        const { validatePhoneTestShareLink } = await import('./phone-test-share-link.service.js');
        await validatePhoneTestShareLink(client, input.shareLinkId, { ...auth, agentId });
      }
      const existing = await client.query(`SELECT * FROM agent_phone_test_requests
        WHERE tenant_id=$1 AND workspace_id=$2 AND request_key=$3`, [auth.tenantId, auth.workspaceId, key]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.agent_id !== agentId || row.phone !== input.phone || row.created_by !== auth.userId || (row.share_link_id ?? null) !== (input.shareLinkId ?? null)) {
          throw new AppError(409, 'This request ID already belongs to another call.', 'PHONE_TEST_REQUEST_CONFLICT');
        }
        return { row };
      }
      const account = await loadPhoneTestAccount(client, auth, agentId, deps);
      const older = await client.query("SELECT id FROM agent_phone_test_requests WHERE tenant_id=$1 AND status='queued' LIMIT 1", [auth.tenantId]);
      let reason = 'company_capacity';
      if (!older.rowCount) {
        try { await reserve(auth, agentId, input.phone, id, account, deps); acquired = true; }
        catch (error) {
          if (!waitable(error)) throw error;
          if (error.code === 'VOICE_COORDINATION_UNAVAILABLE') reason = 'coordination_unavailable';
        }
      }
      if (!acquired) await assertOutboundQueueSpace(client, auth.tenantId, 1);
      const inserted = await client.query(`INSERT INTO agent_phone_test_requests
        (id,tenant_id,workspace_id,agent_id,created_by,request_key,phone,status,queue_reason,share_link_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, auth.tenantId, auth.workspaceId, agentId, auth.userId, key, input.phone, acquired ? 'dispatching' : 'queued', reason, input.shareLinkId ?? null]);
      return { row: inserted.rows[0], account };
    });
  } catch (error) {
    if (acquired) await ownershipFor(deps).releaseReservation({ tenantId: auth.tenantId, reservationId: id }).catch(() => {});
    throw error;
  }
  if (acquired) return dispatch(saved.row, saved.account, deps);
  return response(saved.row);
}

export async function processQueuedPhoneTest(id, deps = {}) {
  const run = runFor(deps);
  let acquired = false, tenantId;
  let claim;
  try {
    claim = await run(null, async client => {
      const lookup = await client.query('SELECT tenant_id FROM agent_phone_test_requests WHERE id=$1', [id]);
      if (!lookup.rowCount) return null;
      tenantId = lookup.rows[0].tenant_id;
      await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      const result = await client.query("SELECT * FROM agent_phone_test_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, tenantId]);
      const row = result.rows[0];
      if (!row || row.status !== 'queued') return null;
      const head = await client.query("SELECT id FROM agent_phone_test_requests WHERE tenant_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1", [tenantId]);
      if (head.rows[0]?.id !== id) return null;
      const auth = { userId: row.created_by, tenantId, workspaceId: row.workspace_id };
      let account;
      try {
        if (row.share_link_id) {
          const { validatePhoneTestShareLink } = await import('./phone-test-share-link.service.js');
          await validatePhoneTestShareLink(client, row.share_link_id, { ...auth, agentId: row.agent_id });
        }
        account = await loadPhoneTestAccount(client, auth, row.agent_id, deps);
      }
      catch (error) {
        if (['CALL_CREDIT_INSUFFICIENT','CALL_CREDIT_LOW_BALANCE','CALL_CREDIT_RATE_UNAVAILABLE'].includes(error.code) || /CREDIT/.test(error.code ?? '')) {
          await client.query("UPDATE agent_phone_test_requests SET queue_reason='waiting_credits',updated_at=now() WHERE id=$1", [id]);
          return null;
        }
        if (error.statusCode && error.statusCode < 500) {
          await client.query("UPDATE agent_phone_test_requests SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [id, error.code]);
          return null;
        }
        throw error;
      }
      try { await reserve(auth, row.agent_id, row.phone, id, account, deps); acquired = true; }
      catch (error) {
        if (!waitable(error)) throw error;
        await client.query('UPDATE agent_phone_test_requests SET queue_reason=$2,updated_at=now() WHERE id=$1',
          [id, error.code === 'VOICE_COORDINATION_UNAVAILABLE' ? 'coordination_unavailable' : 'company_capacity']);
        return null;
      }
      await client.query("UPDATE agent_phone_test_requests SET status='dispatching',updated_at=now() WHERE id=$1", [id]);
      return { row, account };
    });
  } catch (error) {
    if (acquired) await ownershipFor(deps).releaseReservation({ tenantId, reservationId: id }).catch(() => {});
    throw error;
  }
  return claim ? dispatch(claim.row, claim.account, deps) : null;
}

export async function getPhoneTestRequest(auth, id, agentId) {
  return withPlatformAdminContext(auth.userId, async client => {
    const result = await client.query('SELECT * FROM agent_phone_test_requests WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND agent_id=$4', [id, auth.tenantId, auth.workspaceId, agentId]);
    if (!result.rowCount) throw new AppError(404, 'Call request was not found.', 'PHONE_TEST_REQUEST_NOT_FOUND');
    return response(result.rows[0]);
  });
}

export async function cancelCompanyPhoneTest(auth, id, deps = {}) {
  if (!['SUPER_ADMIN','COMPANY_DEVELOPER'].includes(auth.role)) throw new AppError(403, 'Only Developers can cancel waiting calls.', 'FORBIDDEN');
  if (!auth.tenantId) throw new AppError(403, 'A company context is required.', 'TENANT_CONTEXT_REQUIRED');
  requireCompanyCallQueueEnabled(auth.tenantId);
  const run = deps.tenantContextRunner ?? (operation => withTenantContext(auth, operation));
  return run(async client => {
    const result = await client.query(`UPDATE agent_phone_test_requests SET status='canceled',updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='queued' RETURNING id`, [id, auth.tenantId]);
    if (!result.rowCount) throw new AppError(409, 'Waiting call was not found or has already started.', 'QUEUE_TASK_NOT_CANCELABLE');
    await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES($1,$2,$3,'user','QUEUED_PHONE_TEST_CANCELED','phone_test_request',$4,$5::jsonb)`,
    [auth.tenantId, auth.workspaceId, auth.userId, id, JSON.stringify({ status: 'canceled' })]);
    return { id, status: 'canceled' };
  });
}
