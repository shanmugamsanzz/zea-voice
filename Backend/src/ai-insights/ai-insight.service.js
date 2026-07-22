import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

const failedStatuses = new Set(['failed', 'busy', 'no_answer', 'canceled']);
const round = (value, digits = 1) => Number(Number(value || 0).toFixed(digits));
const percent = (value, total) => total ? round((value / total) * 100) : 0;

function title(value) {
  return String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function distribution(map, total) {
  return [...map.entries()]
    .map(([name, value]) => ({ name, value, percentage: percent(value, total) }))
    .sort((left, right) => right.value - left.value);
}

function callSummary(call) {
  const agent = call.agent_name || 'Unassigned agent';
  const campaign = call.campaign_name ? ' in ' + call.campaign_name : '';
  return title(call.direction) + ' call handled by ' + agent + campaign + '; '
    + title(call.status) + ', ' + title(call.sentiment) + ' sentiment, '
    + Number(call.transcript_turns) + ' transcript turns.';
}

function queueItem(call, signalType = null) {
  const reasons = [];
  if (failedStatuses.has(call.status)) reasons.push(title(call.failure_reason || call.status));
  if (call.sentiment === 'negative') reasons.push('Negative sentiment');
  if (Number(call.transcript_turns) === 0) reasons.push('Missing transcript');
  else if (!call.transcript_final || Number(call.transcript_turns) < 2) reasons.push('Incomplete transcript');
  if (signalType === 'callback') reasons.push('Callback language detected');
  if (signalType === 'transfer') reasons.push('Human transfer language detected');
  return {
    callId: call.id,
    startedAt: call.started_at,
    agentId: call.agent_id,
    agentName: call.agent_name,
    campaignId: call.campaign_id,
    campaignName: call.campaign_name,
    direction: call.direction,
    status: call.status,
    sentiment: call.sentiment,
    transcriptTurns: Number(call.transcript_turns),
    summary: callSummary(call),
    reasons,
    evidence: signalType === 'callback' ? call.callback_excerpt
      : signalType === 'transfer' ? call.transfer_excerpt : null,
    reviewedAt: call.reviewed_at,
  };
}

function performance(rows, idKey, nameKey) {
  const groups = new Map();
  for (const row of rows) {
    const id = row[idKey] || 'unassigned';
    const current = groups.get(id) || {
      id: row[idKey],
      name: row[nameKey] || 'Unassigned',
      totalCalls: 0,
      completedCalls: 0,
      failedCalls: 0,
      positiveCalls: 0,
      durationTotal: 0,
    };
    current.totalCalls += 1;
    current.completedCalls += row.status === 'completed' ? 1 : 0;
    current.failedCalls += failedStatuses.has(row.status) ? 1 : 0;
    current.positiveCalls += row.sentiment === 'positive' ? 1 : 0;
    current.durationTotal += Number(row.duration_seconds);
    groups.set(id, current);
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    totalCalls: group.totalCalls,
    completedCalls: group.completedCalls,
    failedCalls: group.failedCalls,
    completionRate: percent(group.completedCalls, group.totalCalls),
    positiveRate: percent(group.positiveCalls, group.totalCalls),
    averageDurationSeconds: group.totalCalls ? round(group.durationTotal / group.totalCalls, 0) : 0,
  })).sort((left, right) => right.totalCalls - left.totalCalls);
}

function recommendations(summary, callbackCount, transferCount, providerImpact) {
  const items = [];
  if (summary.failedCalls > 0) {
    items.push({
      type: 'failed_calls',
      message: 'Review failed-call reasons and retry rules.',
      evidence: summary.failedCalls + ' of ' + summary.totalCalls + ' calls failed.',
    });
  }
  if (summary.transcriptCoverage < 95) {
    items.push({
      type: 'transcript_quality',
      message: 'Investigate calls without complete transcripts.',
      evidence: summary.transcriptCoverage + '% transcript coverage.',
    });
  }
  if (summary.negativeCalls > 0) {
    items.push({
      type: 'sentiment',
      message: 'Review negative calls for prompt or knowledge gaps.',
      evidence: summary.negativeCalls + ' negative calls detected.',
    });
  }
  if (callbackCount > 0) {
    items.push({
      type: 'callback',
      message: 'Resolve transcript-detected callback requests.',
      evidence: callbackCount + ' callback requests are in the queue.',
    });
  }
  if (transferCount > 0) {
    items.push({
      type: 'transfer',
      message: 'Review human-transfer requests and escalation coverage.',
      evidence: transferCount + ' transfer requests are in the queue.',
    });
  }
  const slow = providerImpact.filter((item) => item.averageLatencyMs > 1500);
  if (slow.length > 0) {
    items.push({
      type: 'provider_quality',
      message: 'Review high-latency provider/model paths.',
      evidence: slow.length + ' persisted provider paths average above 1500 ms.',
    });
  }
  return items;
}

function accessFor(role) {
  const developer = role === 'COMPANY_DEVELOPER' || role === 'SUPER_ADMIN';
  return {
    mode: developer ? 'developer' : 'user',
    readOnly: !developer,
    canExport: developer,
    canReview: developer,
    providerImpactVisible: developer,
    assignmentScope: 'tenant',
  };
}

export function getAiInsights(auth, filters) {
  return withTenantContext(auth, async (client) => {
    const values = [
      auth.tenantId,
      filters.days,
      filters.agentId || null,
      filters.campaignId || null,
      filters.direction || null,
      filters.status || null,
    ];
    const calls = await client.query(
      "SELECT cs.id, cs.agent_id, cs.agent_name, cs.campaign_id, cs.campaign_name, cs.direction, "
      + "cs.status, cs.sentiment, cs.duration_seconds, cs.started_at, "
      + "COALESCE(t.turns, 0)::int AS transcript_turns, COALESCE(t.all_final, false) AS transcript_final, "
      + "t.callback_excerpt, t.transfer_excerpt, failure.reason AS failure_reason, review.reviewed_at "
      + "FROM call_sessions cs "
      + "LEFT JOIN LATERAL (SELECT count(*)::int AS turns, bool_and(e.is_final) AS all_final, "
      + "(array_agg(left(e.text, 180) ORDER BY e.sequence_number) FILTER (WHERE e.speaker = 'user' "
      + "AND lower(e.text) ~ '(call[ -]?back|call me back|follow[ -]?up|contact me later)'))[1] AS callback_excerpt, "
      + "(array_agg(left(e.text, 180) ORDER BY e.sequence_number) FILTER (WHERE e.speaker = 'user' "
      + "AND lower(e.text) ~ '(transfer me|human agent|live agent|representative|speak to (a |an )?(human|person|agent))'))[1] AS transfer_excerpt "
      + "FROM call_transcript_entries e WHERE e.tenant_id = cs.tenant_id AND e.call_session_id = cs.id) t ON true "
      + "LEFT JOIN LATERAL (SELECT COALESCE(a.error_message, task.last_error, a.outcome) AS reason "
      + "FROM campaign_task_attempts a LEFT JOIN campaign_tasks task ON task.id = a.task_id AND task.tenant_id = a.tenant_id "
      + "WHERE a.tenant_id = cs.tenant_id AND a.call_session_id = cs.id "
      + "ORDER BY a.attempt_number DESC LIMIT 1) failure ON true "
      + "LEFT JOIN LATERAL (SELECT log.created_at AS reviewed_at FROM audit_logs log "
      + "WHERE log.tenant_id = cs.tenant_id AND log.entity_type = 'call_session' "
      + "AND log.entity_id = cs.id::text AND log.action = 'CALL_INSIGHT_REVIEWED' "
      + "ORDER BY log.created_at DESC LIMIT 1) review ON true "
      + "WHERE cs.tenant_id = $1 AND cs.started_at >= now() - make_interval(days => $2::int) "
      + "AND ($3::uuid IS NULL OR cs.agent_id = $3) AND ($4::uuid IS NULL OR cs.campaign_id = $4) "
      + "AND ($5::text IS NULL OR cs.direction::text = $5) AND ($6::text IS NULL OR cs.status::text = $6) "
      + "ORDER BY cs.started_at DESC",
      values,
    );
    const rows = calls.rows;
    const total = rows.length;
    const sentimentCounts = new Map();
    const outcomeCounts = new Map();
    const dates = new Map();
    const transcriptQuality = { good: 0, incomplete: 0, missing: 0, averageTurns: 0 };
    let completedCalls = 0;
    let failedCalls = 0;
    let positiveCalls = 0;
    let negativeCalls = 0;
    let transcriptTurns = 0;

    for (let offset = filters.days - 1; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - offset);
      dates.set(date.toISOString().slice(0, 10), {
        date: date.toISOString().slice(0, 10),
        positive: 0,
        negative: 0,
        completed: 0,
        failed: 0,
      });
    }
    for (const row of rows) {
      increment(sentimentCounts, row.sentiment);
      increment(outcomeCounts, row.status);
      completedCalls += row.status === 'completed' ? 1 : 0;
      failedCalls += failedStatuses.has(row.status) ? 1 : 0;
      positiveCalls += row.sentiment === 'positive' ? 1 : 0;
      negativeCalls += row.sentiment === 'negative' ? 1 : 0;
      const turns = Number(row.transcript_turns);
      transcriptTurns += turns;
      if (turns === 0) transcriptQuality.missing += 1;
      else if (turns >= 2 && row.transcript_final) transcriptQuality.good += 1;
      else transcriptQuality.incomplete += 1;
      const date = new Date(row.started_at).toISOString().slice(0, 10);
      const point = dates.get(date);
      if (point) {
        point.positive += row.sentiment === 'positive' ? 1 : 0;
        point.negative += row.sentiment === 'negative' ? 1 : 0;
        point.completed += row.status === 'completed' ? 1 : 0;
        point.failed += failedStatuses.has(row.status) ? 1 : 0;
      }
    }
    transcriptQuality.averageTurns = total ? round(transcriptTurns / total) : 0;
    const summary = {
      totalCalls: total,
      completedCalls,
      failedCalls,
      completionRate: percent(completedCalls, total),
      positiveCalls,
      negativeCalls,
      transcriptCoverage: percent(total - transcriptQuality.missing, total),
      averageTranscriptTurns: transcriptQuality.averageTurns,
    };
    const reviewQueue = rows
      .filter((row) => !row.reviewed_at && (
        failedStatuses.has(row.status) || row.sentiment === 'negative'
        || Number(row.transcript_turns) === 0 || !row.transcript_final
      ))
      .slice(0, filters.queueLimit)
      .map((row) => queueItem(row));
    const callbackQueue = rows.filter((row) => row.callback_excerpt)
      .slice(0, filters.queueLimit).map((row) => queueItem(row, 'callback'));
    const transferQueue = rows.filter((row) => row.transfer_excerpt)
      .slice(0, filters.queueLimit).map((row) => queueItem(row, 'transfer'));
    const failureCounts = new Map();
    for (const row of rows.filter((item) => failedStatuses.has(item.status))) {
      increment(failureCounts, title(row.failure_reason || row.status));
    }

    const developer = accessFor(auth.role).mode === 'developer';
    let providerImpact = [];
    if (developer) {
      const providers = await client.query(
        "SELECT usage.provider_kind, COALESCE(usage.provider_name, 'Unreported') AS provider_name, "
        + "COALESCE(usage.model_key, 'Unreported') AS model_key, count(DISTINCT usage.call_session_id)::int AS call_count, "
        + "sum(usage.request_count)::int AS request_count, "
        + "round(sum(usage.duration_ms)::numeric / NULLIF(sum(usage.request_count), 0))::int AS average_latency_ms "
        + "FROM call_provider_usage usage JOIN call_sessions cs ON cs.id = usage.call_session_id AND cs.tenant_id = usage.tenant_id "
        + "WHERE cs.tenant_id = $1 AND cs.started_at >= now() - make_interval(days => $2::int) "
        + "AND ($3::uuid IS NULL OR cs.agent_id = $3) AND ($4::uuid IS NULL OR cs.campaign_id = $4) "
        + "AND ($5::text IS NULL OR cs.direction::text = $5) AND ($6::text IS NULL OR cs.status::text = $6) "
        + "GROUP BY usage.provider_kind, usage.provider_name, usage.model_key ORDER BY call_count DESC",
        values,
      );
      providerImpact = providers.rows.map((row) => ({
        kind: row.provider_kind,
        providerName: row.provider_name,
        modelKey: row.model_key,
        callCount: Number(row.call_count),
        requestCount: Number(row.request_count),
        averageLatencyMs: Number(row.average_latency_ms || 0),
        quality: Number(row.average_latency_ms || 0) <= 800 ? 'good'
          : Number(row.average_latency_ms || 0) <= 1500 ? 'fair' : 'slow',
      }));
    }

    const reviewed = rows.filter((row) => row.reviewed_at).slice(0, filters.queueLimit)
      .map((row) => queueItem(row));
    const options = await client.query(
      "SELECT 'agent' AS type, agent_id AS id, max(agent_name) AS name FROM call_sessions "
      + "WHERE tenant_id = $1 AND agent_id IS NOT NULL GROUP BY agent_id "
      + "UNION ALL SELECT 'campaign' AS type, campaign_id AS id, max(campaign_name) AS name FROM call_sessions "
      + "WHERE tenant_id = $1 AND campaign_id IS NOT NULL GROUP BY campaign_id ORDER BY type, name",
      [auth.tenantId],
    );
    return {
      periodDays: filters.days,
      access: accessFor(auth.role),
      appliedFilters: {
        agentId: filters.agentId || null,
        campaignId: filters.campaignId || null,
        direction: filters.direction || null,
        status: filters.status || null,
      },
      filterOptions: {
        agents: options.rows.filter((item) => item.type === 'agent').map((item) => ({ id: item.id, name: item.name || 'Unnamed agent' })),
        campaigns: options.rows.filter((item) => item.type === 'campaign').map((item) => ({ id: item.id, name: item.name || 'Unnamed campaign' })),
      },
      summary,
      sentimentTrend: [...dates.values()].map(({ date, positive, negative }) => ({ date, positive, negative })),
      outcomeTrend: [...dates.values()].map(({ date, completed, failed }) => ({ date, completed, failed })),
      sentiments: distribution(sentimentCounts, total),
      outcomes: distribution(outcomeCounts, total),
      transcriptQuality,
      agentAnalytics: performance(rows, 'agent_id', 'agent_name'),
      campaignAnalytics: performance(rows, 'campaign_id', 'campaign_name'),
      failedReasons: distribution(failureCounts, failedCalls),
      reviewQueue,
      callbackQueue,
      transferQueue,
      providerImpact,
      recentReviewed: reviewed,
      recommendations: developer
        ? recommendations(summary, callbackQueue.length, transferQueue.length, providerImpact)
        : [],
    };
  });
}

export function reviewInsightCall(auth, callId, input) {
  return withTenantContext(auth, async (client) => {
    const call = await client.query(
      'SELECT id FROM call_sessions WHERE tenant_id = $1 AND id = $2',
      [auth.tenantId, callId],
    );
    if (!call.rowCount) throw new AppError(404, 'Call was not found', 'CALL_NOT_FOUND');
    const result = await client.query(
      "INSERT INTO audit_logs (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data) "
      + "VALUES ($1, $2, $3, 'user', 'CALL_INSIGHT_REVIEWED', 'call_session', $4, $5::jsonb) "
      + "RETURNING id, created_at",
      [auth.tenantId, auth.workspaceId, auth.userId, callId, JSON.stringify({ note: input.note || null })],
    );
    return {
      id: result.rows[0].id,
      callId,
      reviewedAt: result.rows[0].created_at,
      note: input.note || null,
    };
  });
}
