import { withTenantContext } from '../infrastructure/database-context.js';

const numberOrNull = (value) => value === null || value === undefined ? null : Number(value);
const round = (value, digits = 0) => value === null ? null : Number(value.toFixed(digits));
const confidenceKeys = new Set(['confidence', 'confidenceScore', 'sttConfidence']);

function collectConfidenceValues(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectConfidenceValues(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value)) {
    if (confidenceKeys.has(key)) {
      const numeric = Number(nested);
      if (Number.isFinite(numeric)) {
        const percentage = numeric <= 1 ? numeric * 100 : numeric;
        if (percentage >= 0 && percentage <= 100) result.push(percentage);
      }
    } else if (nested && typeof nested === 'object') {
      collectConfidenceValues(nested, result);
    }
  }
  return result;
}

function average(values) {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function latency(row, kind) {
  const duration = numberOrNull(row[`${kind}_duration_ms`]);
  const requests = numberOrNull(row[`${kind}_request_count`]);
  return duration === null || !requests ? null : round(duration / requests);
}

function auditStatus(responseDelayMs, sttConfidence) {
  if (responseDelayMs <= 750 && (sttConfidence === null || sttConfidence >= 90)) return 'optimal';
  if (responseDelayMs <= 1500 && (sttConfidence === null || sttConfidence >= 80)) return 'normal';
  return 'degraded';
}

function healthLabel(score) {
  if (score === null) return 'no_data';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 50) return 'fair';
  return 'needs_attention';
}

export function getVoiceQualityAssessment(auth, filters) {
  return withTenantContext(auth, async (client) => {
    const trend = await client.query(`WITH dates AS (
        SELECT generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date AS day
      ), daily AS (
        SELECT cs.started_at::date AS day,
          count(DISTINCT cs.id)::int AS sample_count,
          round(sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'stt')::numeric /
            NULLIF(sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'stt'), 0))::int AS stt_ms,
          round(sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'llm')::numeric /
            NULLIF(sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'llm'), 0))::int AS llm_ms,
          round(sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'tts')::numeric /
            NULLIF(sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'tts'), 0))::int AS tts_ms
        FROM call_sessions cs
        JOIN call_provider_usage cpu ON cpu.call_session_id = cs.id AND cpu.tenant_id = cs.tenant_id
        WHERE cs.tenant_id = $1 AND cs.started_at >= current_date - ($2::int - 1)
        GROUP BY cs.started_at::date
      )
      SELECT d.day, COALESCE(q.sample_count, 0)::int AS sample_count,
        q.stt_ms, q.llm_ms, q.tts_ms
      FROM dates d LEFT JOIN daily q USING (day) ORDER BY d.day`, [auth.tenantId, filters.days]);

    const recent = await client.query(`SELECT cs.id, cs.started_at,
        sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'stt')::bigint AS stt_duration_ms,
        sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'stt')::bigint AS stt_request_count,
        sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'llm')::bigint AS llm_duration_ms,
        sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'llm')::bigint AS llm_request_count,
        sum(cpu.duration_ms) FILTER (WHERE cpu.provider_kind = 'tts')::bigint AS tts_duration_ms,
        sum(cpu.request_count) FILTER (WHERE cpu.provider_kind = 'tts')::bigint AS tts_request_count,
        COALESCE(jsonb_agg(cpu.raw_usage) FILTER (WHERE cpu.provider_kind = 'stt'), '[]'::jsonb) AS stt_events
      FROM call_sessions cs
      JOIN call_provider_usage cpu ON cpu.call_session_id = cs.id AND cpu.tenant_id = cs.tenant_id
      WHERE cs.tenant_id = $1 AND cs.started_at >= current_date - ($2::int - 1)
      GROUP BY cs.id, cs.started_at
      HAVING sum(cpu.request_count) > 0
      ORDER BY cs.started_at DESC LIMIT $3`, [auth.tenantId, filters.days, filters.auditLimit]);

    const audits = recent.rows.map((row) => {
      const sttLatencyMs = latency(row, 'stt');
      const llmLatencyMs = latency(row, 'llm');
      const ttsLatencyMs = latency(row, 'tts');
      const responseDelayMs = [sttLatencyMs, llmLatencyMs, ttsLatencyMs]
        .filter((value) => value !== null).reduce((total, value) => total + value, 0);
      const sttConfidence = round(average(collectConfidenceValues(row.stt_events)), 2);
      return {
        callId: row.id,
        auditedAt: row.started_at,
        responseDelayMs,
        sttConfidence,
        status: auditStatus(responseDelayMs, sttConfidence),
        latency: { sttMs: sttLatencyMs, llmMs: llmLatencyMs, ttsMs: ttsLatencyMs },
      };
    });
    const healthyCalls = audits.filter((audit) => audit.status !== 'degraded').length;
    const healthScore = audits.length === 0 ? null : round((healthyCalls / audits.length) * 100, 2);

    return {
      periodDays: filters.days,
      health: {
        score: healthScore,
        label: healthLabel(healthScore),
        auditedCalls: audits.length,
        healthyCalls,
      },
      latencyTrend: trend.rows.map((row) => ({
        date: row.day,
        sampleCount: Number(row.sample_count),
        sttMs: numberOrNull(row.stt_ms),
        llmMs: numberOrNull(row.llm_ms),
        ttsMs: numberOrNull(row.tts_ms),
      })),
      audits,
    };
  });
}
