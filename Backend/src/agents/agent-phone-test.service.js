import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { makePlivoCall } from '../telephony/plivo.client.js';
import { normalizePhone } from '../campaigns/csv.js';
import { assertTenantCallCreditAdmission } from '../credits/call-credit.service.js';
import { validateAgentRuntimeModels } from './agent.service.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger.js';
import { voiceCallOwnership } from '../voice/call-ownership.service.js';
import { capacityCallbackUrl, outboundReservationTtlSeconds, outboundRingTimeoutSeconds } from '../voice/call-capacity.service.js';

export async function startAgentPhoneTest(auth, agentId, input, dependencies = {}) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(400, 'Enter a valid phone number with country code.', 'PHONE_TEST_INVALID_NUMBER');
  const context = dependencies.contextRunner ?? withPlatformAdminContext;
  const account = await context(auth.userId, async (client) => {
    const result = await client.query(`SELECT a.*,pn.e164,ta.auth_id,ta.auth_token_encrypted,
        ta.answer_url,ta.hangup_url,ta.status account_status,tl.max_total_concurrency
      FROM voice_agents a
      LEFT JOIN phone_numbers pn ON pn.id=a.phone_number_id AND pn.status='active' AND pn.deleted_at IS NULL
      LEFT JOIN phone_number_assignments pa ON pa.phone_number_id=pn.id
        AND pa.tenant_id=a.tenant_id AND pa.released_at IS NULL
      LEFT JOIN telephony_accounts ta ON ta.id=pn.telephony_account_id AND ta.deleted_at IS NULL
      LEFT JOIN tenant_limits tl ON tl.tenant_id=a.tenant_id
      WHERE a.id=$1 AND a.tenant_id=$2 AND a.workspace_id=$3 AND a.deleted_at IS NULL
        AND (pn.id IS NULL OR pa.id IS NOT NULL)`, [agentId, auth.tenantId, auth.workspaceId]);
    if (!result.rowCount) throw new AppError(404, 'Agent or assigned phone number was not found.', 'PHONE_TEST_AGENT_NOT_FOUND');
    const row = result.rows[0];
    if (row.status !== 'active') throw new AppError(409, 'Activate this agent before calling.', 'PHONE_TEST_AGENT_INACTIVE');
    if (!['outbound', 'both'].includes(row.usage_direction)) throw new AppError(409,
      'Enable outbound calls for this agent before calling.', 'PHONE_TEST_DIRECTION_UNAVAILABLE');
    if (!row.e164 || row.account_status !== 'connected' || !row.answer_url || !row.hangup_url) {
      throw new AppError(409, 'Assign a connected phone number with Answer and Hangup URLs to this agent.', 'PHONE_TEST_NUMBER_REQUIRED');
    }
    await (dependencies.validateModels ?? validateAgentRuntimeModels)(client, {
      sttModelId: row.stt_model_id, llmModelId: row.llm_model_id, ttsModelId: row.tts_model_id, settings: row.settings,
    });
    await (dependencies.checkCredits ?? assertTenantCallCreditAdmission)(client, auth.tenantId, 'outbound');
    if (!Number.isInteger(Number(row.max_total_concurrency)) || Number(row.max_total_concurrency) < 1) {
      throw new AppError(409, 'Company live-call concurrency is not configured.', 'COMPANY_CONCURRENCY_NOT_CONFIGURED');
    }
    return row;
  });
  const ownership = dependencies.ownership ?? voiceCallOwnership;
  const reservationId = randomUUID();
  await ownership.acquire({ tenantId: auth.tenantId, providerCallId: reservationId,
    limit: account.max_total_concurrency, ttlSeconds: outboundReservationTtlSeconds,
    metadata: { phone, agentId, agentName: account.name, direction: 'outbound', source: 'phone_test' } });
  try {
    const result = await (dependencies.makeCall ?? makePlivoCall)(account.auth_id,
      (dependencies.decrypt ?? decryptCredential)(account.auth_token_encrypted), {
        from: account.e164, to: phone,
        answerUrl: capacityCallbackUrl(account.answer_url, reservationId),
        hangupUrl: capacityCallbackUrl(account.hangup_url, reservationId),
        ringTimeoutSeconds: outboundRingTimeoutSeconds,
      });
    return { requestId: result.requestUuid, phone, agentId, status: 'initiated' };
  } catch (error) {
    await ownership.releaseReservation({ tenantId: auth.tenantId, reservationId }).catch((releaseError) =>
      logger.warn({ err: releaseError, stage: 'call.capacity_release_failed', reservationId }, 'Call capacity will recover on lease expiry'));
    throw error;
  }
}
