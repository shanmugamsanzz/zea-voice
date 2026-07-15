export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE credit_entry_type AS ENUM (
      'platform_purchase', 'company_allocation', 'manual_adjustment',
      'promotional_credit', 'usage_debit', 'refund'
    );
    CREATE TYPE credit_direction AS ENUM ('credit', 'debit');
    CREATE TYPE voice_rate_direction AS ENUM ('inbound', 'outbound');

    CREATE TABLE platform_credit_wallets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(160) NOT NULL DEFAULT 'Primary Platform Wallet',
      currency char(3) NOT NULL DEFAULT 'INR',
      balance numeric(18, 4) NOT NULL DEFAULT 0,
      reserved_balance numeric(18, 4) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_credit_wallets_currency_unique UNIQUE (currency),
      CONSTRAINT platform_credit_wallets_balance_nonnegative CHECK (balance >= 0),
      CONSTRAINT platform_credit_wallets_reserved_valid CHECK (
        reserved_balance >= 0 AND reserved_balance <= balance
      )
    );

    CREATE TABLE company_credit_wallets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      currency char(3) NOT NULL DEFAULT 'INR',
      balance numeric(18, 4) NOT NULL DEFAULT 0,
      reserved_balance numeric(18, 4) NOT NULL DEFAULT 0,
      low_balance_threshold numeric(18, 4) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT company_credit_wallets_tenant_unique UNIQUE (tenant_id),
      CONSTRAINT company_credit_wallets_balance_nonnegative CHECK (balance >= 0),
      CONSTRAINT company_credit_wallets_reserved_valid CHECK (
        reserved_balance >= 0 AND reserved_balance <= balance
      ),
      CONSTRAINT company_credit_wallets_threshold_nonnegative CHECK (low_balance_threshold >= 0)
    );

    CREATE TABLE platform_pricing_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      direction voice_rate_direction NOT NULL,
      rate_per_minute numeric(14, 4) NOT NULL,
      currency char(3) NOT NULL DEFAULT 'INR',
      effective_from timestamptz NOT NULL DEFAULT now(),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_pricing_rates_direction_unique UNIQUE (direction),
      CONSTRAINT platform_pricing_rates_nonnegative CHECK (rate_per_minute >= 0)
    );

    CREATE TABLE credit_ledger_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
      platform_wallet_id uuid REFERENCES platform_credit_wallets(id) ON DELETE RESTRICT,
      company_wallet_id uuid REFERENCES company_credit_wallets(id) ON DELETE RESTRICT,
      tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      entry_type credit_entry_type NOT NULL,
      direction credit_direction NOT NULL,
      amount numeric(18, 4) NOT NULL,
      balance_after numeric(18, 4) NOT NULL,
      reference varchar(240),
      description varchar(500),
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT credit_ledger_entries_amount_positive CHECK (amount > 0),
      CONSTRAINT credit_ledger_entries_balance_nonnegative CHECK (balance_after >= 0),
      CONSTRAINT credit_ledger_entries_one_wallet CHECK (
        (platform_wallet_id IS NOT NULL AND company_wallet_id IS NULL AND tenant_id IS NULL)
        OR (platform_wallet_id IS NULL AND company_wallet_id IS NOT NULL AND tenant_id IS NOT NULL)
      )
    );

    CREATE INDEX credit_ledger_entries_tenant_created_idx
      ON credit_ledger_entries (tenant_id, created_at DESC);
    CREATE INDEX credit_ledger_entries_group_idx
      ON credit_ledger_entries (transaction_group_id);

    CREATE TRIGGER platform_credit_wallets_set_updated_at BEFORE UPDATE ON platform_credit_wallets
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER company_credit_wallets_set_updated_at BEFORE UPDATE ON company_credit_wallets
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER platform_pricing_rates_set_updated_at BEFORE UPDATE ON platform_pricing_rates
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    INSERT INTO platform_credit_wallets (currency) VALUES ('INR');
    INSERT INTO platform_pricing_rates (direction, rate_per_minute, currency)
      VALUES ('inbound', 6.40, 'INR'), ('outbound', 12.00, 'INR');
    INSERT INTO company_credit_wallets (tenant_id, currency)
      SELECT id, 'INR' FROM tenants WHERE deleted_at IS NULL
      ON CONFLICT (tenant_id) DO NOTHING;

    ALTER TABLE platform_credit_wallets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_credit_wallets FORCE ROW LEVEL SECURITY;
    ALTER TABLE company_credit_wallets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE company_credit_wallets FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_pricing_rates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_pricing_rates FORCE ROW LEVEL SECURITY;
    ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE credit_ledger_entries FORCE ROW LEVEL SECURITY;

    CREATE POLICY platform_credit_wallets_admin_policy ON platform_credit_wallets
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY company_credit_wallets_select_policy ON company_credit_wallets
      FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY company_credit_wallets_admin_write_policy ON company_credit_wallets
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY platform_pricing_rates_select_policy ON platform_pricing_rates
      FOR SELECT TO zea_voice_runtime USING (true);
    CREATE POLICY platform_pricing_rates_admin_write_policy ON platform_pricing_rates
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY credit_ledger_entries_select_policy ON credit_ledger_entries
      FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY credit_ledger_entries_admin_insert_policy ON credit_ledger_entries
      FOR INSERT TO zea_voice_runtime WITH CHECK (zea_is_platform_admin());

    GRANT USAGE ON TYPE credit_entry_type, credit_direction, voice_rate_direction TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE ON platform_credit_wallets, company_credit_wallets,
      platform_pricing_rates TO zea_voice_runtime;
    GRANT SELECT, INSERT ON credit_ledger_entries TO zea_voice_runtime;

    COMMENT ON TABLE credit_ledger_entries IS 'Append-only financial history for platform purchases, company allocations and usage.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS credit_ledger_entries;
    DROP TABLE IF EXISTS platform_pricing_rates;
    DROP TABLE IF EXISTS company_credit_wallets;
    DROP TABLE IF EXISTS platform_credit_wallets;
    DROP TYPE IF EXISTS voice_rate_direction;
    DROP TYPE IF EXISTS credit_direction;
    DROP TYPE IF EXISTS credit_entry_type;
  `);
}
