export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    -- These browser-test RLS policies refer to credits_charged. PostgreSQL
    -- requires dependent policies to be removed before its type can change.
    DROP POLICY IF EXISTS call_sessions_browser_test_update_policy ON call_sessions;
    DROP POLICY IF EXISTS call_sessions_browser_test_insert_policy ON call_sessions;

    ALTER TABLE call_sessions
      ALTER COLUMN credits_charged TYPE numeric(24, 8) USING credits_charged::numeric;
    ALTER TABLE call_sessions
      DROP CONSTRAINT IF EXISTS call_sessions_credits_charged_nonnegative,
      ADD CONSTRAINT call_sessions_credits_charged_nonnegative CHECK (credits_charged >= 0);
    COMMENT ON COLUMN call_sessions.credits_charged IS
      'Exact INR-equivalent credits debited from metered provider and telephony usage; one credit equals one INR.';
    COMMENT ON COLUMN call_sessions.credit_price_snapshot_inr IS
      'Legacy field retained only for historical call records. Metered calls use call_metered_usage_costs price snapshots.';

    CREATE POLICY call_sessions_browser_test_insert_policy
      ON call_sessions FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
        AND reserved_credits = 0
        AND credits_charged = 0
        AND credit_billing_finalized = true
      );

    CREATE POLICY call_sessions_browser_test_update_policy
      ON call_sessions FOR UPDATE TO zea_voice_runtime
      USING (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
      )
      WITH CHECK (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
        AND reserved_credits = 0
        AND credits_charged = 0
        AND credit_billing_finalized = true
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP POLICY IF EXISTS call_sessions_browser_test_update_policy ON call_sessions;
    DROP POLICY IF EXISTS call_sessions_browser_test_insert_policy ON call_sessions;

    ALTER TABLE call_sessions
      ALTER COLUMN credits_charged TYPE integer USING trunc(credits_charged)::integer;

    CREATE POLICY call_sessions_browser_test_insert_policy
      ON call_sessions FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
        AND reserved_credits = 0
        AND credits_charged = 0
        AND credit_billing_finalized = true
      );

    CREATE POLICY call_sessions_browser_test_update_policy
      ON call_sessions FOR UPDATE TO zea_voice_runtime
      USING (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
      )
      WITH CHECK (
        tenant_id = zea_current_tenant_id()
        AND provider_metadata->>'source' = 'browser_test'
        AND provider_metadata->'browserTest'->>'userId' = zea_current_user_id()::text
        AND reserved_credits = 0
        AND credits_charged = 0
        AND credit_billing_finalized = true
      );
  `);
}
