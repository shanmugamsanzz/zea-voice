import { withTenantContext } from '../infrastructure/database-context.js';

const number = (value) => Number(value ?? 0);
function change(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

export function getCompanyDashboard(auth, days) {
  return withTenantContext(auth, async (client) => {
    const tenantId = auth.tenantId;
    // A transaction owns one PostgreSQL client. Run its queries sequentially;
    // concurrent client.query() calls are deprecated by node-postgres.
    const identity = await client.query(`SELECT t.id AS tenant_id, t.name, t.timezone, s.default_workspace_id
        FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
    const calls = await client.query(`SELECT
        count(*)::int AS total_calls,
        count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
        count(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls,
        count(*) FILTER (WHERE status IN ('queued','ringing','connected'))::int AS active_calls,
        COALESCE(sum(duration_seconds),0)::bigint AS total_seconds,
        COALESCE(avg(duration_seconds),0) AS average_seconds,
        count(*) FILTER (WHERE started_at >= date_trunc('month', now()))::int AS current_month_calls,
        count(*) FILTER (WHERE started_at >= date_trunc('month', now()) - interval '1 month'
          AND started_at < date_trunc('month', now()))::int AS previous_month_calls,
        count(*) FILTER (WHERE direction = 'inbound' AND started_at >= date_trunc('month', now()))::int AS current_inbound,
        count(*) FILTER (WHERE direction = 'inbound' AND started_at >= date_trunc('month', now()) - interval '1 month'
          AND started_at < date_trunc('month', now()))::int AS previous_inbound,
        count(*) FILTER (WHERE direction = 'outbound' AND started_at >= date_trunc('month', now()))::int AS current_outbound,
        count(*) FILTER (WHERE direction = 'outbound' AND started_at >= date_trunc('month', now()) - interval '1 month'
          AND started_at < date_trunc('month', now()))::int AS previous_outbound
        FROM call_sessions WHERE tenant_id = $1`, [tenantId]);
    const volume = await client.query(`WITH dates AS (
          SELECT generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date AS day
        ), totals AS (
          SELECT started_at::date AS day,
            count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE direction = 'outbound')::int AS outbound
          FROM call_sessions WHERE tenant_id = $1 AND started_at >= current_date - ($2::int - 1)
          GROUP BY started_at::date
        ) SELECT d.day, COALESCE(t.inbound,0)::int AS inbound, COALESCE(t.outbound,0)::int AS outbound
        FROM dates d LEFT JOIN totals t USING (day) ORDER BY d.day`, [tenantId, days]);
    const recent = await client.query(`SELECT id, agent_name, campaign_name, direction, status, from_number, to_number,
        started_at, duration_seconds FROM call_sessions WHERE tenant_id = $1
        ORDER BY started_at DESC LIMIT 8`, [tenantId]);
    const wallet = await client.query(`SELECT balance, reserved_balance, balance - reserved_balance AS available_balance,
        currency FROM company_credit_wallets WHERE tenant_id = $1`, [tenantId]);
    const phones = await client.query(`SELECT count(*)::int AS count FROM phone_number_assignments
        WHERE tenant_id = $1 AND released_at IS NULL`, [tenantId]);
    const team = await client.query(`SELECT count(*)::int AS count FROM tenant_memberships
        WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL`, [tenantId]);
    const agents = await client.query(`SELECT a.id, a.name, a.status, a.prompt, a.voice_id,
        a.temperature, a.interruption_sensitivity, a.silence_timeout_ms,
        a.created_at, a.updated_at, p.name AS llm_provider, m.display_name AS llm_model,
        count(cs.id)::int AS total_calls,
        COALESCE(avg(cs.duration_seconds), 0) AS average_duration_seconds,
        CASE WHEN count(cs.id) = 0 THEN 0 ELSE
          round((count(cs.id) FILTER (WHERE cs.status = 'completed')::numeric / count(cs.id)) * 100, 2)
        END AS success_rate,
        count(*) OVER()::int AS total_agents,
        count(*) FILTER (WHERE a.status = 'active') OVER()::int AS active_agents
        FROM voice_agents a
        JOIN provider_models m ON m.id = a.llm_model_id
        JOIN ai_providers p ON p.id = m.provider_id
        LEFT JOIN call_sessions cs ON cs.agent_id = a.id
        WHERE a.tenant_id = $1 AND a.deleted_at IS NULL
        GROUP BY a.id, p.name, m.display_name
        ORDER BY a.updated_at DESC LIMIT 12`, [tenantId]);
    const campaigns = await client.query(`SELECT count(*) FILTER (WHERE status IN ('running','scheduled'))::int AS active
        FROM campaigns WHERE tenant_id=$1 AND deleted_at IS NULL`, [tenantId]);
    const stats = calls.rows[0];
    const company = identity.rows[0];
    const credit = wallet.rows[0];
    return {
      company: { tenantId: company.tenant_id, workspaceId: company.default_workspace_id,
        name: company.name, timezone: company.timezone },
      metrics: {
        inboundCalls: number(stats.inbound_calls), outboundCalls: number(stats.outbound_calls),
        totalCalls: number(stats.total_calls), activeCalls: number(stats.active_calls),
        totalMinutesUsed: Number((number(stats.total_seconds) / 60).toFixed(2)),
        averageCallDurationSeconds: Number(number(stats.average_seconds).toFixed(2)),
        currentMonthCalls: number(stats.current_month_calls),
        changes: {
          totalCallsPercent: change(number(stats.current_month_calls), number(stats.previous_month_calls)),
          inboundCallsPercent: change(number(stats.current_inbound), number(stats.previous_inbound)),
          outboundCallsPercent: change(number(stats.current_outbound), number(stats.previous_outbound)),
        },
        totalAgents: agents.rows[0]?.total_agents ?? 0,
        activeAgents: agents.rows[0]?.active_agents ?? 0,
        activeCampaigns: campaigns.rows[0].active,
      },
      resources: {
        credits: credit ? { balance: number(credit.balance), reservedBalance: number(credit.reserved_balance),
          availableBalance: number(credit.available_balance), currency: credit.currency } : null,
        assignedPhoneNumbers: phones.rows[0].count,
        activeTeamMembers: team.rows[0].count,
      },
      callVolume: volume.rows.map((row) => ({ date: row.day, inbound: row.inbound, outbound: row.outbound })),
      agents: agents.rows.map((row) => ({
        id: row.id, name: row.name, status: row.status, prompt: row.prompt,
        voiceId: row.voice_id, temperature: number(row.temperature),
        interruptionSensitivity: number(row.interruption_sensitivity),
        silenceTimeoutMs: row.silence_timeout_ms, llmProvider: row.llm_provider,
        llmModel: row.llm_model, totalCalls: row.total_calls,
        averageDurationSeconds: Number(number(row.average_duration_seconds).toFixed(2)),
        successRate: number(row.success_rate), createdAt: row.created_at, updatedAt: row.updated_at,
      })),
      recentActivity: recent.rows.map((row) => ({
        id: row.id, agentName: row.agent_name, campaignName: row.campaign_name,
        direction: row.direction, status: row.status,
        phoneNumber: row.direction === 'outbound' ? row.to_number : row.from_number,
        startedAt: row.started_at, durationSeconds: row.duration_seconds,
      })),
    };
  });
}

export function getCompanyAnalytics(auth, days) {
  return withTenantContext(auth, async (client) => {
    const result = await client.query(`WITH filtered AS MATERIALIZED (
          SELECT status, direction, sentiment, duration_seconds, started_at
          FROM call_sessions
          WHERE tenant_id = $1 AND started_at >= current_date - ($2::int - 1)
        ), summary AS (
          SELECT count(*)::int AS total_calls,
            count(*) FILTER (WHERE status = 'completed')::int AS completed_calls,
            count(*) FILTER (WHERE status IN ('ringing','connected','completed'))::int AS connected_calls,
            COALESCE(avg(duration_seconds), 0) AS average_duration_seconds,
            COALESCE(sum(duration_seconds), 0)::bigint AS total_duration_seconds
          FROM filtered
        ), dates AS (
          SELECT generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date AS day
        ), traffic AS (
          SELECT d.day, count(f.*) FILTER (WHERE f.direction = 'inbound')::int AS inbound,
            count(f.*) FILTER (WHERE f.direction = 'outbound')::int AS outbound
          FROM dates d LEFT JOIN filtered f ON f.started_at::date = d.day GROUP BY d.day ORDER BY d.day
        ), durations AS (
          SELECT CASE WHEN duration_seconds <= 30 THEN '0-30s' WHEN duration_seconds <= 60 THEN '31-60s'
              WHEN duration_seconds <= 120 THEN '1-2m' WHEN duration_seconds <= 300 THEN '2-5m' ELSE '5m+' END AS range,
            CASE WHEN duration_seconds <= 30 THEN 1 WHEN duration_seconds <= 60 THEN 2
              WHEN duration_seconds <= 120 THEN 3 WHEN duration_seconds <= 300 THEN 4 ELSE 5 END AS sort_order,
            count(*)::int AS count
          FROM filtered GROUP BY range, sort_order ORDER BY sort_order
        ), outcomes AS (
          SELECT status::text AS name, count(*)::int AS value FROM filtered GROUP BY status ORDER BY count(*) DESC
        ), sentiments AS (
          SELECT sentiment::text AS name, count(*)::int AS value FROM filtered GROUP BY sentiment
        )
        SELECT row_to_json(summary) AS summary,
          COALESCE((SELECT json_agg(traffic) FROM traffic), '[]'::json) AS traffic,
          COALESCE((SELECT json_agg(durations) FROM durations), '[]'::json) AS durations,
          COALESCE((SELECT json_agg(outcomes) FROM outcomes), '[]'::json) AS outcomes,
          COALESCE((SELECT json_agg(sentiments) FROM sentiments), '[]'::json) AS sentiments
        FROM summary`, [auth.tenantId, days]);
    const data = result.rows[0];
    const summary = data.summary;
    const total = number(summary.total_calls);
    const sentimentCounts = Object.fromEntries(data.sentiments.map((item) => [item.name, number(item.value)]));
    return {
      periodDays: days,
      summary: {
        totalCalls: total, completedCalls: number(summary.completed_calls),
        connectedCalls: number(summary.connected_calls),
        connectionRate: total === 0 ? 0 : Number(((number(summary.connected_calls) / total) * 100).toFixed(2)),
        averageDurationSeconds: Number(number(summary.average_duration_seconds).toFixed(2)),
        totalMinutes: Number((number(summary.total_duration_seconds) / 60).toFixed(2)),
      },
      traffic: data.traffic.map((item) => ({ date: item.day, inbound: number(item.inbound), outbound: number(item.outbound) })),
      durationDistribution: data.durations.map((item) => ({ range: item.range, count: number(item.count) })),
      outcomes: data.outcomes.map((item) => ({ name: item.name, value: number(item.value) })),
      sentiments: ['positive', 'neutral', 'negative', 'unknown'].map((name) => ({
        name, value: sentimentCounts[name] ?? 0,
        percentage: total === 0 ? 0 : Number((((sentimentCounts[name] ?? 0) / total) * 100).toFixed(2)),
      })),
    };
  });
}
