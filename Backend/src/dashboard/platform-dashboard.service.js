import { withParallelPlatformAdminContext } from '../infrastructure/database-context.js';
import { listQueueMetrics } from '../queues/queue.registry.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const outcomeColors = {
  completed: '#10B981',
  busy: '#F59E0B',
  no_answer: '#6366F1',
  failed: '#EF4444',
  canceled: '#94A3B8',
};

function trafficSeries(rows) {
  const indexed = new Map(rows.map((row) => [new Date(row.hour).toISOString(), row]));
  const points = [];
  const current = new Date();
  current.setMinutes(0, 0, 0);
  for (let offset = 11; offset >= 0; offset -= 1) {
    const hour = new Date(current.getTime() - offset * 3_600_000);
    const row = indexed.get(hour.toISOString());
    points.push({
      name: hour.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: 'UTC' }),
      hour: hour.toISOString(),
      inbound: Number(row?.inbound ?? 0),
      outbound: Number(row?.outbound ?? 0),
    });
  }
  return points;
}

async function dashboardQueueMetrics() {
  let timeout;
  try {
    return await Promise.race([
      listQueueMetrics(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Dashboard queue metrics timed out')), env.DASHBOARD_QUEUE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn({ err: error }, 'Dashboard continuing without queue metrics');
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPlatformDashboard(actorUserId) {
  const [databaseData, queues] = await Promise.all([
    withParallelPlatformAdminContext(actorUserId, [
      (client) => client.query(`SELECT
          count(*) FILTER (WHERE status='active')::int AS active_companies,
          count(*) FILTER (WHERE status='pending')::int AS pending_companies,
          (SELECT count(*)::int FROM call_sessions WHERE status IN ('queued','ringing','connected')) AS in_flight_calls,
          (SELECT count(*)::int FROM call_sessions WHERE started_at>=date_trunc('day',now())) AS calls_today,
          (SELECT COALESCE(sum(amount),0) FROM payment_transactions
             WHERE status='succeeded' AND type='subscription'
             AND settled_at>=date_trunc('month',now())) AS monthly_revenue
          FROM tenants WHERE deleted_at IS NULL`),
      (client) => client.query(`SELECT date_trunc('hour',started_at) AS hour,
          count(*) FILTER (WHERE direction='inbound')::int AS inbound,
          count(*) FILTER (WHERE direction='outbound')::int AS outbound
          FROM call_sessions WHERE started_at>=date_trunc('hour',now())-interval '11 hours'
          GROUP BY 1 ORDER BY 1`),
      (client) => client.query(`SELECT status::text AS name,count(*)::int AS value FROM call_sessions
          WHERE status IN ('completed','busy','no_answer','failed','canceled') GROUP BY status ORDER BY value DESC`),
      (client) => client.query(`SELECT t.id,o.name,o.billing_tier,
          COALESCE(sum(c.cost) FILTER (WHERE c.started_at>=date_trunc('month',now())),0) AS monthly_spend,
          w.balance-w.reserved_balance AS credits_balance
          FROM tenants t JOIN organizations o ON o.tenant_id=t.id AND o.deleted_at IS NULL
          JOIN company_credit_wallets w ON w.tenant_id=t.id
          LEFT JOIN call_sessions c ON c.tenant_id=t.id
          WHERE t.deleted_at IS NULL GROUP BY t.id,o.name,o.billing_tier,w.balance,w.reserved_balance
          ORDER BY monthly_spend DESC,o.name LIMIT 4`),
      (client) => client.query(`SELECT c.id,o.name AS company_name,COALESCE(c.agent_name,'Unassigned') AS agent_name,
          c.status::text,c.duration_seconds,c.to_number,c.started_at,
          transcript.text AS latest_transcript
          FROM call_sessions c JOIN organizations o ON o.tenant_id=c.tenant_id AND o.deleted_at IS NULL
          LEFT JOIN LATERAL (SELECT text FROM call_transcript_entries
            WHERE call_session_id=c.id ORDER BY sequence_number DESC LIMIT 1) transcript ON true
          WHERE c.status IN ('queued','ringing','connected') ORDER BY c.started_at DESC LIMIT 2`),
    ]).then(([overview, traffic, outcomes, companies, liveCalls]) => {
      return {
        overview: overview.rows[0],
        traffic: traffic.rows,
        outcomes: outcomes.rows,
        companies: companies.rows,
        liveCalls: liveCalls.rows,
      };
    }),
    dashboardQueueMetrics(),
  ]);

  return {
    overview: {
      activeCompanies: databaseData.overview.active_companies,
      pendingCompanies: databaseData.overview.pending_companies,
      inFlightCalls: databaseData.overview.in_flight_calls,
      waitingCalls: queues.reduce((sum, queue) => sum + queue.waitingCalls, 0),
      callsToday: databaseData.overview.calls_today,
      monthlyRevenue: Number(databaseData.overview.monthly_revenue),
      currency: 'INR',
    },
    callTraffic: trafficSeries(databaseData.traffic),
    outcomes: databaseData.outcomes.map((row) => ({
      name: row.name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      value: row.value,
      color: outcomeColors[row.name] ?? '#64748B',
    })),
    topCompanies: databaseData.companies.map((row) => ({
      id: row.id,
      name: row.name,
      billingTier: row.billing_tier,
      monthlySpend: Number(row.monthly_spend),
      creditsBalance: Number(row.credits_balance),
    })),
    liveCalls: databaseData.liveCalls.map((row) => ({
      id: row.id,
      companyName: row.company_name,
      agentName: row.agent_name,
      status: row.status,
      duration: row.duration_seconds,
      phone: row.to_number,
      startedAt: row.started_at,
      latestTranscript: row.latest_transcript,
    })),
  };
}
