export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
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
  `);
}
