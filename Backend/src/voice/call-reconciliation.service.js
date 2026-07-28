import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { getPlivoCallDetails } from '../telephony/plivo.client.js';
import { voiceCallOwnership } from './call-ownership.service.js';
import { queuePostCallSummary } from './postcall-summary/postcall-summary.queue.js';

function asDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function terminalStatus(call) {
  const cause = String(call?.hangup_cause_name ?? '').toLowerCase().replace(/[ -]+/g, '_');
  if (cause.includes('busy')) return 'busy';
  if (cause.includes('no_answer') || cause.includes('noanswer')) return 'no_answer';
  if (cause.includes('cancel')) return 'canceled';
  if (cause.includes('reject') || cause.includes('decline') || cause.includes('error') || cause.includes('invalid')) {
    return 'failed';
  }
  // These rows exist only after Plivo successfully invoked the Answer URL, so
  // an ended CDR without an explicit failure is a completed connected call.
  return 'completed';
}

function safeProviderMetadata(call) {
  return {
    callUuid: call.call_uuid ?? null,
    endTime: call.end_time ?? null,
    billDuration: Number(call.bill_duration ?? 0),
    callDuration: Number(call.call_duration ?? 0),
    hangupCauseName: call.hangup_cause_name ?? null,
    hangupCauseCode: call.hangup_cause_code ?? null,
    hangupSource: call.hangup_source ?? null,
  };
}

async function listCandidates(dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const result = await client.query(`SELECT c.id,c.tenant_id,c.provider_call_id,c.started_at,c.answered_at,
        a.auth_id,a.auth_token_encrypted,a.base_url
      FROM call_sessions c
      JOIN telephony_accounts a ON a.id=c.telephony_account_id AND a.deleted_at IS NULL
      WHERE c.status='connected' AND c.ended_at IS NULL
        AND c.started_at <= now()-($1::int * interval '1 second')
      ORDER BY c.started_at
      LIMIT $2`, [env.VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS, env.VOICE_CALL_RECONCILIATION_BATCH_SIZE]);
    return result.rows;
  });
}

async function persistResolution(candidate, resolution, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const result = await client.query(`UPDATE call_sessions
      SET status=$2::call_status,ended_at=$3,duration_seconds=$4,
          provider_metadata=provider_metadata||$5::jsonb
      WHERE id=$1 AND status='connected' AND ended_at IS NULL
      RETURNING id,tenant_id,provider_call_id,status,ended_at,duration_seconds`, [
      candidate.id, resolution.status, resolution.endedAt, resolution.durationSeconds,
      JSON.stringify({ callReconciliation: resolution.metadata }),
    ]);
    return result.rows[0] ?? null;
  });
}

function providerResolution(call, now) {
  const endedAt = asDate(call?.end_time);
  if (!endedAt || endedAt > now) return null;
  const durationSeconds = Math.max(0, Math.round(Number(call.bill_duration ?? call.call_duration ?? 0) || 0));
  return {
    status: terminalStatus(call), endedAt, durationSeconds,
    metadata: {
      source: 'plivo_cdr', reason: 'missed_completion_signal', reconciledAt: now.toISOString(),
      provider: safeProviderMetadata(call),
    },
  };
}

function fallbackResolution(candidate, now) {
  const startedAt = asDate(candidate.answered_at ?? candidate.started_at) ?? now;
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  if (ageSeconds < env.VOICE_CALL_RECONCILIATION_FALLBACK_SECONDS) return null;
  return {
    status: 'failed', endedAt: now, durationSeconds: 0,
    metadata: {
      source: 'stale_call_watchdog', reason: 'completion_signal_unavailable',
      reconciledAt: now.toISOString(), observedAgeSeconds: ageSeconds,
    },
  };
}

export async function reconcileStaleVoiceCalls(dependencies = {}) {
  const candidates = await (dependencies.listCandidates ?? listCandidates)(dependencies);
  const ownership = dependencies.ownership ?? voiceCallOwnership;
  const getCall = dependencies.getCallDetails ?? getPlivoCallDetails;
  const decrypt = dependencies.decryptCredential ?? decryptCredential;
  const persist = dependencies.persistResolution ?? persistResolution;
  const queueSummary = dependencies.queueSummary ?? queuePostCallSummary;
  const now = dependencies.now?.() ?? new Date();
  const result = { inspected: candidates.length, active: 0, reconciled: 0, deferred: 0, failed: 0 };

  for (const candidate of candidates) {
    try {
      const ownershipIdentity = {
        tenantId: candidate.tenant_id,
        providerCallId: candidate.provider_call_id,
      };
      if (await ownership.isOwned(ownershipIdentity)) {
        result.active += 1;
        continue;
      }
      let resolution = null;
      try {
        const providerCall = await getCall(
          candidate.auth_id, decrypt(candidate.auth_token_encrypted),
          candidate.provider_call_id, dependencies.fetchImpl, candidate.base_url ?? env.PLIVO_API_BASE_URL,
        );
        resolution = providerResolution(providerCall, now);
      } catch (error) {
        logger.warn({
          stage: 'call.reconciliation_provider_deferred', callId: candidate.id,
          providerCallId: candidate.provider_call_id, errorCode: error?.code,
        }, 'Stale call could not yet be verified with Plivo');
      }
      resolution ??= fallbackResolution(candidate, now);
      if (!resolution) {
        result.deferred += 1;
        continue;
      }
      const updated = await persist(candidate, resolution, dependencies);
      if (!updated) continue;
      result.reconciled += 1;
      await ownership.releaseValidated(ownershipIdentity).catch(() => {});
      if (updated.status === 'completed') {
        await queueSummary(updated.id, dependencies).catch((error) => logger.warn({
          stage: 'call.reconciliation_summary_deferred', callId: updated.id, errorCode: error?.code,
        }, 'Reconciled call summary could not be queued'));
      }
      logger.warn({
        stage: 'call.reconciled', callId: updated.id, providerCallId: updated.provider_call_id,
        status: updated.status, durationSeconds: updated.duration_seconds,
        source: resolution.metadata.source,
      }, 'Abandoned connected call was reconciled to a terminal state');
    } catch (error) {
      result.failed += 1;
      logger.error({ err: error, stage: 'call.reconciliation_failed', callId: candidate.id },
        'Stale call reconciliation failed');
    }
  }
  return result;
}

let timer;
let initialTimer;
let running;

export function startCallReconciliation() {
  if (!env.VOICE_CALL_RECONCILIATION_ENABLED || timer) return;
  const run = () => {
    if (running) return;
    running = reconcileStaleVoiceCalls().then((result) => {
      if (result.reconciled || result.failed) logger.info({ stage: 'call.reconciliation_cycle', ...result },
        'Call reconciliation cycle completed');
    }).catch((error) => logger.error({ err: error, stage: 'call.reconciliation_cycle_failed' },
      'Call reconciliation cycle failed')).finally(() => { running = null; });
  };
  timer = setInterval(run, env.VOICE_CALL_RECONCILIATION_INTERVAL_MS);
  timer.unref?.();
  initialTimer = setTimeout(run, Math.min(5_000, env.VOICE_CALL_RECONCILIATION_INTERVAL_MS));
  initialTimer.unref?.();
  logger.info({
    stage: 'call.reconciliation_ready', intervalMs: env.VOICE_CALL_RECONCILIATION_INTERVAL_MS,
    minimumAgeSeconds: env.VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS,
  }, 'Call reconciliation watchdog started');
}

export async function closeCallReconciliation() {
  clearInterval(timer);
  clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
  await running;
}

export const callReconciliationInternals = { providerResolution, fallbackResolution, terminalStatus };
