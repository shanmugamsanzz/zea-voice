export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE platform_credit_settings (
      singleton_key smallint PRIMARY KEY DEFAULT 1,
      low_credit_threshold bigint NOT NULL DEFAULT 50,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_credit_settings_singleton CHECK (singleton_key = 1),
      CONSTRAINT platform_credit_settings_threshold_valid CHECK (
        low_credit_threshold >= 0 AND low_credit_threshold <= 9007199254740991
      )
    );
    INSERT INTO platform_credit_settings (singleton_key, low_credit_threshold) VALUES (1, 50);
    CREATE TRIGGER platform_credit_settings_set_updated_at BEFORE UPDATE ON platform_credit_settings
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE call_sessions
      ADD COLUMN reserved_credits integer NOT NULL DEFAULT 0,
      ADD COLUMN credits_charged integer NOT NULL DEFAULT 0,
      ADD COLUMN credit_price_snapshot_inr numeric(12, 4),
      ADD COLUMN credit_billing_finalized boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT call_sessions_reserved_credits_nonnegative CHECK (reserved_credits >= 0),
      ADD CONSTRAINT call_sessions_reserved_credits_single CHECK (reserved_credits <= 1),
      ADD CONSTRAINT call_sessions_credits_charged_nonnegative CHECK (credits_charged >= 0),
      ADD CONSTRAINT call_sessions_finalized_reservation_released CHECK (
        NOT credit_billing_finalized OR reserved_credits = 0
      ),
      ADD CONSTRAINT call_sessions_credit_price_positive CHECK (
        credit_price_snapshot_inr IS NULL OR credit_price_snapshot_inr > 0
      );
    CREATE INDEX call_sessions_pending_credit_billing_idx
      ON call_sessions (tenant_id,started_at)
      WHERE reserved_credits > 0 AND credit_billing_finalized = false;

    -- A prepaid call admitted with its final credit may run longer than one minute.
    -- The call is allowed to finish and creates a negative balance; all later calls
    -- remain blocked until a Super Admin payment clears the overrun.
    ALTER TABLE company_credit_wallets
      DROP CONSTRAINT IF EXISTS company_credit_wallets_reserved_valid,
      DROP CONSTRAINT IF EXISTS company_credit_wallets_balance_nonnegative;
    ALTER TABLE company_credit_wallets
      ADD CONSTRAINT company_credit_wallets_reserved_valid CHECK (
        reserved_balance >= 0 AND (balance < 0 OR reserved_balance <= balance)
      );
    ALTER TABLE credit_ledger_entries
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_balance_nonnegative;

    ALTER TABLE platform_credit_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_credit_settings FORCE ROW LEVEL SECURITY;
    CREATE POLICY platform_credit_settings_select_policy ON platform_credit_settings
      FOR SELECT TO zea_voice_runtime USING (true);
    CREATE POLICY platform_credit_settings_admin_write_policy ON platform_credit_settings
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    CREATE POLICY company_credit_wallets_auth_service_update_policy ON company_credit_wallets
      FOR UPDATE TO zea_voice_runtime
      USING (zea_is_auth_service()) WITH CHECK (zea_is_auth_service());
    CREATE POLICY company_credit_wallets_auth_service_select_policy ON company_credit_wallets
      FOR SELECT TO zea_voice_runtime USING (zea_is_auth_service());
    CREATE POLICY organizations_auth_service_credit_select_policy ON organizations
      FOR SELECT TO zea_voice_runtime USING (zea_is_auth_service());
    CREATE POLICY credit_ledger_entries_auth_service_select_policy ON credit_ledger_entries
      FOR SELECT TO zea_voice_runtime USING (zea_is_auth_service());
    CREATE POLICY credit_ledger_entries_auth_service_usage_policy ON credit_ledger_entries
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (zea_is_auth_service() AND entry_type = 'usage_debit');

    GRANT SELECT, INSERT, UPDATE ON platform_credit_settings TO zea_voice_runtime;
    GRANT UPDATE ON company_credit_wallets TO zea_voice_runtime;

    COMMENT ON COLUMN call_sessions.reserved_credits IS 'Minimum credits atomically reserved when this call was admitted.';
    COMMENT ON COLUMN call_sessions.credits_charged IS 'Final rounded connected-minute credits charged exactly once.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP POLICY IF EXISTS credit_ledger_entries_auth_service_usage_policy ON credit_ledger_entries;
    DROP POLICY IF EXISTS credit_ledger_entries_auth_service_select_policy ON credit_ledger_entries;
    DROP POLICY IF EXISTS organizations_auth_service_credit_select_policy ON organizations;
    DROP POLICY IF EXISTS company_credit_wallets_auth_service_select_policy ON company_credit_wallets;
    DROP POLICY IF EXISTS company_credit_wallets_auth_service_update_policy ON company_credit_wallets;
    DROP TABLE IF EXISTS platform_credit_settings;

    ALTER TABLE call_sessions
      DROP CONSTRAINT IF EXISTS call_sessions_finalized_reservation_released,
      DROP CONSTRAINT IF EXISTS call_sessions_credit_price_positive,
      DROP CONSTRAINT IF EXISTS call_sessions_credits_charged_nonnegative,
      DROP CONSTRAINT IF EXISTS call_sessions_reserved_credits_single,
      DROP CONSTRAINT IF EXISTS call_sessions_reserved_credits_nonnegative,
      DROP COLUMN IF EXISTS credit_billing_finalized,
      DROP COLUMN IF EXISTS credit_price_snapshot_inr,
      DROP COLUMN IF EXISTS credits_charged,
      DROP COLUMN IF EXISTS reserved_credits;
    DROP INDEX IF EXISTS call_sessions_pending_credit_billing_idx;

    ALTER TABLE company_credit_wallets DROP CONSTRAINT IF EXISTS company_credit_wallets_reserved_valid;
    ALTER TABLE company_credit_wallets
      ADD CONSTRAINT company_credit_wallets_balance_nonnegative CHECK (balance >= 0) NOT VALID,
      ADD CONSTRAINT company_credit_wallets_reserved_valid CHECK (
        reserved_balance >= 0 AND reserved_balance <= balance
      ) NOT VALID;
    ALTER TABLE credit_ledger_entries
      ADD CONSTRAINT credit_ledger_entries_balance_nonnegative CHECK (balance_after >= 0) NOT VALID;
  `);
}
