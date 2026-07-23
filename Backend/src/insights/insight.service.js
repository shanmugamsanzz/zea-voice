import { withTenantContext } from '../infrastructure/database-context.js';

const number = (value) => Number(value ?? 0);
const percentage = (value, total) => total ? Number(((number(value) / total) * 100).toFixed(2)) : 0;

function title(value) {
  return String(value ?? '').split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

function buildRecommendations(summary) {
  const recommendations = [];
  if (!summary.totalCalls) return [{
    code: 'INSUFFICIENT_CALL_DATA', severity: 'info', title: 'More call data is required',
    description: 'No calls were stored during this period, so conversation trends cannot be evaluated.',
    evidence: '0 calls in the selected period',
  }];
  if (summary.transcriptCoverage < 80) recommendations.push({
    code: 'TRANSCRIPT_COVERAGE_LOW', severity: 'warning', title: 'Improve transcript coverage',
    description: 'Review STT connectivity and final-transcript persistence for calls without transcript entries.',
    evidence: `${summary.transcriptCoverage}% of calls contain transcripts`,
  });
  if (summary.sentimentCoverage < 80) recommendations.push({
    code: 'SENTIMENT_COVERAGE_LOW', severity: 'info', title: 'Complete sentiment analysis',
    description: 'Persist sentiment only after a caller conversation has enough evidence for classification.',
    evidence: `${summary.sentimentCoverage}% of calls have analyzed sentiment`,
  });
  if (summary.completionRate < 70) recommendations.push({
    code: 'COMPLETION_RATE_LOW', severity: 'critical', title: 'Investigate incomplete calls',
    description: 'Review the flagged calls and provider failures before changing agent prompts or campaigns.',
    evidence: `${summary.completionRate}% call completion rate`,
  });
  if (summary.negativeRate > 20) recommendations.push({
    code: 'NEGATIVE_SENTIMENT_HIGH', severity: 'warning', title: 'Review negative conversations',
    description: 'Inspect transcripts from negative calls and update the relevant agent workflow only when a recurring cause is confirmed.',
    evidence: `${summary.negativeRate}% negative sentiment among all calls`,
  });
  if (!recommendations.length) recommendations.push({
    code: 'NO_THRESHOLD_ALERTS', severity: 'success', title: 'No operational threshold alerts',
    description: 'Current completion, transcript, and sentiment measurements do not cross configured alert thresholds.',
    evidence: `${summary.totalCalls} calls evaluated`,
  });
  return recommendations;
}

export function getTenantInsights(auth, input) {
  return withTenantContext(auth, async (client) => {
    const parameters = [auth.tenantId, input.days];
    const periodFilter = `c.tenant_id=$1 AND c.started_at >= now() - ($2::int * interval '1 day')`;
    const [summaryResult, sentimentResult, outcomeResult, agentResult, flaggedResult] = await Promise.all([
      client.query(`SELECT count(*)::int total_calls,
          count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int answered_calls,
          count(*) FILTER (WHERE c.status='completed')::int completed_calls,
          count(*) FILTER (WHERE c.status IN ('failed','busy','no_answer','canceled'))::int unsuccessful_calls,
          count(*) FILTER (WHERE c.sentiment <> 'unknown')::int sentiment_calls,
          count(*) FILTER (WHERE c.sentiment='positive')::int positive_calls,
          count(*) FILTER (WHERE c.sentiment='negative')::int negative_calls,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM call_transcript_entries t
            WHERE t.call_session_id=c.id AND t.is_final=true))::int transcript_calls,
          COALESCE(avg(c.duration_seconds),0)::numeric average_duration_seconds
        FROM call_sessions c WHERE ${periodFilter}`, parameters),
      client.query(`SELECT c.sentiment::text name,count(*)::int value
        FROM call_sessions c WHERE ${periodFilter} GROUP BY c.sentiment ORDER BY value DESC`, parameters),
      client.query(`SELECT c.status::text name,count(*)::int value
        FROM call_sessions c WHERE ${periodFilter} GROUP BY c.status ORDER BY value DESC`, parameters),
      client.query(`SELECT c.agent_id,c.agent_name,count(*)::int total_calls,
          count(*) FILTER (WHERE c.status='completed')::int completed_calls,
          count(*) FILTER (WHERE c.sentiment='negative')::int negative_calls,
          COALESCE(avg(c.duration_seconds),0)::numeric average_duration_seconds
        FROM call_sessions c WHERE ${periodFilter} AND c.agent_id IS NOT NULL
        GROUP BY c.agent_id,c.agent_name ORDER BY total_calls DESC,c.agent_name LIMIT 20`, parameters),
      client.query(`SELECT c.id,c.provider_call_id,c.agent_id,c.agent_name,c.direction,c.status,c.sentiment,
          c.started_at,c.duration_seconds,c.from_number,c.to_number,
          c.provider_metadata #>> '{voiceRuntime,reason}' failure_reason,
          transcript.text customer_excerpt
        FROM call_sessions c
        LEFT JOIN LATERAL (SELECT t.text FROM call_transcript_entries t
          WHERE t.call_session_id=c.id AND t.speaker='user' AND t.is_final=true
          ORDER BY t.sequence_number DESC LIMIT 1) transcript ON true
        WHERE ${periodFilter} AND (c.sentiment='negative' OR c.status IN ('failed','busy','no_answer','canceled'))
        ORDER BY c.started_at DESC LIMIT 20`, parameters),
    ]);

    const raw = summaryResult.rows[0];
    const totalCalls = number(raw.total_calls);
    const summary = {
      totalCalls,
      answeredCalls: number(raw.answered_calls),
      completedCalls: number(raw.completed_calls),
      unsuccessfulCalls: number(raw.unsuccessful_calls),
      transcriptCalls: number(raw.transcript_calls),
      sentimentCalls: number(raw.sentiment_calls),
      averageDurationSeconds: Number(number(raw.average_duration_seconds).toFixed(2)),
      completionRate: percentage(raw.completed_calls, totalCalls),
      transcriptCoverage: percentage(raw.transcript_calls, totalCalls),
      sentimentCoverage: percentage(raw.sentiment_calls, totalCalls),
      positiveRate: percentage(raw.positive_calls, totalCalls),
      negativeRate: percentage(raw.negative_calls, totalCalls),
    };

    return {
      periodDays: input.days,
      generatedAt: new Date().toISOString(),
      summary,
      sentiments: sentimentResult.rows.map((row) => ({
        name: row.name, label: title(row.name), value: number(row.value), percentage: percentage(row.value, totalCalls),
      })),
      outcomes: outcomeResult.rows.map((row) => ({
        name: row.name, label: title(row.name), value: number(row.value), percentage: percentage(row.value, totalCalls),
      })),
      agents: agentResult.rows.map((row) => ({
        agentId: row.agent_id, agentName: row.agent_name, totalCalls: number(row.total_calls),
        completedCalls: number(row.completed_calls), negativeCalls: number(row.negative_calls),
        completionRate: percentage(row.completed_calls, number(row.total_calls)),
        averageDurationSeconds: Number(number(row.average_duration_seconds).toFixed(2)),
      })),
      flaggedCalls: flaggedResult.rows.map((row) => ({
        id: row.id, providerCallId: row.provider_call_id, agentId: row.agent_id, agentName: row.agent_name,
        direction: row.direction, status: row.status, sentiment: row.sentiment, startedAt: row.started_at,
        durationSeconds: number(row.duration_seconds), fromNumber: row.from_number, toNumber: row.to_number,
        failureReason: row.failure_reason, customerExcerpt: row.customer_excerpt,
      })),
      recommendations: buildRecommendations(summary),
    };
  });
}
