import { withTenantContext } from '../infrastructure/database-context.js';

const number = (value) => Number(value ?? 0);
const rounded = (value) => Math.round(number(value) * 100) / 100;

function numericMetric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function average(values) {
  const valid = values.filter((value) => value !== null);
  return valid.length ? rounded(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

function latencyMetrics(metadata) {
  const latency = metadata?.voiceRuntime?.metrics?.latency ?? {};
  const firstResponses = Array.isArray(latency.firstResponseAudioMs)
    ? latency.firstResponseAudioMs.map(numericMetric).filter((value) => value !== null)
    : [];
  return {
    welcomeAudioStartMs: numericMetric(latency.welcomeAudioStartMs),
    averageFirstResponseAudioMs: average(firstResponses),
    firstResponseSamples: firstResponses.length,
    welcomeCacheHit: latency.welcomeCacheHit === true,
  };
}

function usageByKind(rows) {
  return Object.fromEntries((rows ?? []).map((usage) => [usage.providerKind, {
    providerName: usage.providerName,
    modelKey: usage.modelKey,
    requests: number(usage.requests),
    audioInputMs: number(usage.audioInputMs),
    audioOutputMs: number(usage.audioOutputMs),
    durationMs: number(usage.durationMs),
  }]));
}

export function getTenantVqaReport(auth, input) {
  return withTenantContext(auth, async (client) => {
    const summaryResult = await client.query(`SELECT
        count(*)::int AS total_calls,
        count(*) FILTER (WHERE status='completed')::int AS completed_calls,
        count(*) FILTER (WHERE status='failed')::int AS failed_calls,
        count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered_calls,
        COALESCE(avg(duration_seconds),0)::numeric AS average_duration_seconds,
        COALESCE(sum(duration_seconds),0)::bigint AS total_duration_seconds,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM call_transcript_entries t WHERE t.call_session_id=c.id
        ))::int AS calls_with_transcript
      FROM call_sessions c
      WHERE c.tenant_id=$1 AND c.started_at >= now() - ($2::int * interval '1 day')`,
    [auth.tenantId, input.days]);

    const recordsResult = await client.query(`SELECT c.id,c.provider_call_id,c.agent_id,c.agent_name,
        c.direction,c.status,c.started_at,c.answered_at,c.ended_at,c.duration_seconds,
        c.from_number,c.to_number,c.provider_metadata,
        (SELECT count(*)::int FROM call_transcript_entries t WHERE t.call_session_id=c.id) transcript_entries,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'providerKind',u.provider_kind,'providerName',u.provider_name,'modelKey',u.model_key,
          'requests',u.request_count,'audioInputMs',u.audio_input_ms,'audioOutputMs',u.audio_output_ms,
          'durationMs',u.duration_ms
        ) ORDER BY u.provider_kind) FROM call_provider_usage u WHERE u.call_session_id=c.id),'[]'::jsonb) provider_usage
      FROM call_sessions c
      WHERE c.tenant_id=$1 AND c.started_at >= now() - ($2::int * interval '1 day')
      ORDER BY c.started_at DESC LIMIT $3`, [auth.tenantId, input.days, input.limit]);

    const records = recordsResult.rows.map((row) => {
      const latency = latencyMetrics(row.provider_metadata);
      return {
        id: row.id,
        providerCallId: row.provider_call_id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        direction: row.direction,
        status: row.status,
        startedAt: row.started_at,
        answeredAt: row.answered_at,
        endedAt: row.ended_at,
        durationSeconds: number(row.duration_seconds),
        fromNumber: row.from_number,
        toNumber: row.to_number,
        transcriptEntries: number(row.transcript_entries),
        failureReason: row.provider_metadata?.voiceRuntime?.reason ?? null,
        latency,
        providers: usageByKind(row.provider_usage),
      };
    });
    const summary = summaryResult.rows[0];
    const welcomeSamples = records.map((record) => record.latency.welcomeAudioStartMs).filter((value) => value !== null);
    const responseSamples = records.map((record) => record.latency.averageFirstResponseAudioMs).filter((value) => value !== null);
    const totalCalls = number(summary.total_calls);
    const completedCalls = number(summary.completed_calls);
    return {
      periodDays: input.days,
      generatedAt: new Date().toISOString(),
      summary: {
        totalCalls,
        completedCalls,
        failedCalls: number(summary.failed_calls),
        answeredCalls: number(summary.answered_calls),
        completionRate: totalCalls ? rounded((completedCalls / totalCalls) * 100) : 0,
        averageDurationSeconds: rounded(summary.average_duration_seconds),
        totalDurationSeconds: number(summary.total_duration_seconds),
        callsWithTranscript: number(summary.calls_with_transcript),
        averageWelcomeAudioStartMs: average(welcomeSamples),
        averageFirstResponseAudioMs: average(responseSamples),
        measuredWelcomeCalls: welcomeSamples.length,
        measuredResponseCalls: responseSamples.length,
      },
      records,
    };
  });
}
