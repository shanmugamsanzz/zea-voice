import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { activeCallSessions } from './call-session-store.js';
import { reportPostCall } from './integrations/postcall.service.js';

const terminalStatuses = new Set(['completed', 'failed', 'canceled']);

function terminalStatus(outcome) {
  return terminalStatuses.has(outcome) ? outcome : 'failed';
}

async function closeAdapters(adapters = {}) {
  const results = await Promise.allSettled(Object.entries(adapters).map(async ([kind, adapter]) => {
    if (typeof adapter?.close === 'function') await adapter.close();
    return kind;
  }));
  return results.map((result, index) => ({
    kind: Object.keys(adapters)[index],
    closed: result.status === 'fulfilled',
    error: result.status === 'rejected' ? result.reason?.message ?? String(result.reason) : null,
  }));
}

async function persistCompletion(input, dependencies) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const selected = await client.query('SELECT * FROM call_sessions WHERE id=$1 FOR UPDATE', [input.callId]);
    if (!selected.rowCount) throw new Error(`Call session was not found: ${input.callId}`);
    const call = selected.rows[0];
    const existingRuntime = call.provider_metadata?.voiceRuntime;
    if (call.ended_at && existingRuntime?.finalized) {
      return { call, idempotent: true, usage: existingRuntime.usage };
    }
    const endedAt = input.endedAt;
    const startedAt = call.answered_at ?? call.started_at;
    const durationSeconds = Math.max(0, Math.ceil((endedAt.getTime() - new Date(startedAt).getTime()) / 1000));
    for (const usage of input.usage.providers) {
      await client.query(`INSERT INTO call_provider_usage
        (call_session_id,tenant_id,provider_kind,provider_id,provider_name,model_id,model_key,
         request_count,input_tokens,output_tokens,total_tokens,audio_input_ms,audio_output_ms,
         character_count,duration_ms,cost,currency,raw_usage)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        ON CONFLICT (call_session_id,provider_kind,provider_id,model_id) DO UPDATE SET
          request_count=EXCLUDED.request_count,input_tokens=EXCLUDED.input_tokens,
          output_tokens=EXCLUDED.output_tokens,total_tokens=EXCLUDED.total_tokens,
          audio_input_ms=EXCLUDED.audio_input_ms,audio_output_ms=EXCLUDED.audio_output_ms,
          character_count=EXCLUDED.character_count,duration_ms=EXCLUDED.duration_ms,
          cost=EXCLUDED.cost,currency=EXCLUDED.currency,raw_usage=EXCLUDED.raw_usage`, [
        input.callId, call.tenant_id, usage.kind, usage.providerId, usage.providerName,
        usage.modelId, usage.model, usage.requests, usage.inputTokens, usage.outputTokens,
        usage.totalTokens, usage.audioInputMs, usage.audioOutputMs, usage.characters,
        usage.durationMs, usage.cost, usage.currency, JSON.stringify(usage.events),
      ]);
    }
    const voiceRuntime = {
      finalized: true,
      reason: input.reason,
      usage: input.usage,
      adapterCleanup: input.adapterCleanup,
      finalizedAt: endedAt.toISOString(),
    };
    const updated = await client.query(`UPDATE call_sessions SET status=$2::call_status,ended_at=$3,
      duration_seconds=$4,provider_metadata=provider_metadata||$5::jsonb WHERE id=$1 RETURNING *`, [
      input.callId, input.status, endedAt, durationSeconds, JSON.stringify({ voiceRuntime }),
    ]);
    return { call: updated.rows[0], idempotent: false, usage: input.usage };
  });
}

export async function completeVoiceCall(input, dependencies = {}) {
  if (!input?.controller?.callSession?.id || !input.runtimeProfile || !input.usageTracker) {
    throw new TypeError('Controller, runtime profile, and usage tracker are required');
  }
  const status = terminalStatus(input.outcome ?? 'completed');
  const reason = input.reason ?? status;
  const endedAt = input.endedAt ?? new Date();
  if (!(endedAt instanceof Date) || Number.isNaN(endedAt.getTime())) throw new TypeError('endedAt must be a valid Date');

  if (!input.controller.terminal) {
    if (status === 'completed') await input.controller.complete(reason, endedAt.getTime());
    else await input.controller.fail(reason, endedAt.getTime());
  }
  const adapterCleanup = await closeAdapters(input.adapters);
  const usage = input.usageTracker.report();
  const persisted = await persistCompletion({
    callId: input.controller.callSession.id, status, reason, endedAt, usage, adapterCleanup,
  }, dependencies);
  activeCallSessions.delete(input.controller.callSession.id);

  let postCall = { attempted: false, delivered: false, reason: 'already_finalized' };
  if (!persisted.idempotent) {
    postCall = await reportPostCall(input.runtimeProfile, {
      event: 'call.completed',
      call: {
        id: input.controller.callSession.id,
        providerCallId: input.controller.callSession.providerCallId,
        tenantId: input.runtimeProfile.agent.tenantId,
        workspaceId: input.runtimeProfile.agent.workspaceId,
        agentId: input.runtimeProfile.agent.id,
        direction: input.controller.callSession.direction,
        status,
        reason,
        startedAt: persisted.call.started_at,
        answeredAt: persisted.call.answered_at,
        endedAt: persisted.call.ended_at,
        durationSeconds: Number(persisted.call.duration_seconds),
      },
      transcript: input.controller.history,
      providerUsage: usage,
    }, dependencies);
  }
  return { call: persisted.call, usage: persisted.usage, adapterCleanup, postCall, idempotent: persisted.idempotent };
}
