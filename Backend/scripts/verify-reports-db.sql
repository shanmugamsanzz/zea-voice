-- Read-only verification for the Reports tab database source.
-- This file does not create or modify any database objects or rows.

-- 1. Required Reports tables must exist.
SELECT
  to_regclass('public.call_sessions') AS call_sessions,
  to_regclass('public.call_transcript_entries') AS call_transcript_entries;

-- 2. The original calls migration must already be applied.
SELECT id, name, run_on
FROM public.pgmigrations
WHERE name LIKE '%tasks-10-11-calls-payments%'
ORDER BY id;

-- 3. Verify tenant row-level security is enabled and forced.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('call_sessions', 'call_transcript_entries')
ORDER BY c.relname;

-- 4. Verify the tenant-isolation policies used by Reports.
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('call_sessions', 'call_transcript_entries')
ORDER BY tablename, policyname;

-- 5. Verify the Reports query indexes.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('call_sessions', 'call_transcript_entries')
ORDER BY tablename, indexname;

-- 6. Totals expected by the Reports summary cards.
SELECT
  count(*)::int AS total_calls,
  count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
  count(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls
FROM public.call_sessions;

-- 7. Totals per tenant for isolation checking.
SELECT
  tenant_id,
  count(*)::int AS total_calls,
  count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
  count(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls
FROM public.call_sessions
GROUP BY tenant_id
ORDER BY tenant_id;

-- 8. Latest real records displayed in Reports.
SELECT
  id,
  tenant_id,
  agent_name,
  campaign_name,
  from_number,
  to_number,
  direction,
  status,
  duration_seconds,
  cost,
  currency,
  started_at,
  ended_at
FROM public.call_sessions
ORDER BY started_at DESC
LIMIT 20;

-- 9. Verify transcript rows linked to calls.
SELECT
  cs.id AS call_id,
  cs.tenant_id,
  count(cte.id)::int AS transcript_entries
FROM public.call_sessions cs
LEFT JOIN public.call_transcript_entries cte
  ON cte.call_session_id = cs.id
GROUP BY cs.id, cs.tenant_id
ORDER BY max(cs.started_at) DESC
LIMIT 20;
