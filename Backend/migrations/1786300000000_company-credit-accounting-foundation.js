export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE company_credit_wallets
      ADD COLUMN inr_remainder numeric(18, 4) NOT NULL DEFAULT 0;

    ALTER TABLE company_credit_wallets
      ADD CONSTRAINT company_credit_wallets_balance_whole CHECK (balance = trunc(balance)),
      ADD CONSTRAINT company_credit_wallets_reserved_whole CHECK (reserved_balance = trunc(reserved_balance)),
      ADD CONSTRAINT company_credit_wallets_threshold_whole CHECK (low_balance_threshold = trunc(low_balance_threshold)),
      ADD CONSTRAINT company_credit_wallets_remainder_nonnegative CHECK (inr_remainder >= 0);

    ALTER TABLE organizations
      ADD CONSTRAINT organizations_active_price_positive
      CHECK (status <> 'active' OR per_minute_price > 0);

    CREATE TABLE company_credit_price_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      price_per_minute numeric(12, 4) NOT NULL,
      effective_from timestamptz NOT NULL DEFAULT now(),
      effective_to timestamptz,
      changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT company_credit_price_history_price_positive CHECK (price_per_minute > 0),
      CONSTRAINT company_credit_price_history_period_valid CHECK (
        effective_to IS NULL OR effective_to >= effective_from
      )
    );

    CREATE UNIQUE INDEX company_credit_price_history_current_unique
      ON company_credit_price_history (tenant_id) WHERE effective_to IS NULL;
    CREATE INDEX company_credit_price_history_tenant_time_idx
      ON company_credit_price_history (tenant_id, effective_from DESC);

    INSERT INTO company_credit_price_history
      (tenant_id, price_per_minute, effective_from, changed_by)
    SELECT tenant_id, per_minute_price, created_at, created_by
    FROM organizations
    WHERE per_minute_price > 0 AND deleted_at IS NULL
    ON CONFLICT (tenant_id) WHERE effective_to IS NULL DO NOTHING;

    CREATE TABLE company_credit_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      company_wallet_id uuid NOT NULL REFERENCES company_credit_wallets(id) ON DELETE RESTRICT,
      payment_amount_inr numeric(18, 4) NOT NULL,
      price_per_credit_inr numeric(12, 4) NOT NULL,
      remainder_before_inr numeric(18, 4) NOT NULL DEFAULT 0,
      credits_issued bigint NOT NULL DEFAULT 0,
      remainder_after_inr numeric(18, 4) NOT NULL DEFAULT 0,
      reference varchar(240),
      description varchar(500),
      idempotency_key varchar(160) NOT NULL,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT company_credit_payments_amount_positive CHECK (payment_amount_inr > 0),
      CONSTRAINT company_credit_payments_price_positive CHECK (price_per_credit_inr > 0),
      CONSTRAINT company_credit_payments_remainder_before_nonnegative CHECK (remainder_before_inr >= 0),
      CONSTRAINT company_credit_payments_credits_nonnegative CHECK (credits_issued >= 0),
      CONSTRAINT company_credit_payments_remainder_after_nonnegative CHECK (remainder_after_inr >= 0)
    );
    CREATE INDEX company_credit_payments_tenant_created_idx
      ON company_credit_payments (tenant_id, created_at DESC);
    CREATE UNIQUE INDEX company_credit_payments_tenant_idempotency_unique
      ON company_credit_payments (tenant_id, idempotency_key);

    ALTER TABLE credit_ledger_entries
      ADD COLUMN credit_amount bigint,
      ADD COLUMN payment_amount_inr numeric(18, 4),
      ADD COLUMN price_per_credit_inr numeric(12, 4),
      ADD COLUMN remainder_before_inr numeric(18, 4),
      ADD COLUMN remainder_after_inr numeric(18, 4),
      ADD COLUMN billed_duration_seconds integer;

    UPDATE credit_ledger_entries
    SET credit_amount = CASE
      WHEN entry_type = 'usage_debit' AND COALESCE(metadata->>'credits', '') ~ '^[0-9]+$'
        THEN (metadata->>'credits')::bigint
      WHEN company_wallet_id IS NOT NULL AND amount = trunc(amount)
        THEN amount::bigint
      ELSE NULL
    END,
    price_per_credit_inr = CASE
      WHEN COALESCE(metadata->>'creditRateInr', '') ~ '^[0-9]+(?:\\.[0-9]{1,4})?$'
        THEN (metadata->>'creditRateInr')::numeric(12, 4)
      ELSE NULL
    END,
    billed_duration_seconds = CASE
      WHEN COALESCE(metadata->>'durationSeconds', '') ~ '^[0-9]+$'
        THEN (metadata->>'durationSeconds')::integer
      ELSE NULL
    END
    WHERE company_wallet_id IS NOT NULL;

    ALTER TABLE credit_ledger_entries
      ADD CONSTRAINT credit_ledger_entries_credit_amount_positive
        CHECK (credit_amount IS NULL OR credit_amount > 0),
      ADD CONSTRAINT credit_ledger_entries_payment_nonnegative
        CHECK (payment_amount_inr IS NULL OR payment_amount_inr >= 0),
      ADD CONSTRAINT credit_ledger_entries_price_positive
        CHECK (price_per_credit_inr IS NULL OR price_per_credit_inr > 0),
      ADD CONSTRAINT credit_ledger_entries_remainder_before_nonnegative
        CHECK (remainder_before_inr IS NULL OR remainder_before_inr >= 0),
      ADD CONSTRAINT credit_ledger_entries_remainder_after_nonnegative
        CHECK (remainder_after_inr IS NULL OR remainder_after_inr >= 0),
      ADD CONSTRAINT credit_ledger_entries_duration_nonnegative
        CHECK (billed_duration_seconds IS NULL OR billed_duration_seconds >= 0);

    ALTER TABLE company_credit_price_history ENABLE ROW LEVEL SECURITY;
    ALTER TABLE company_credit_price_history FORCE ROW LEVEL SECURITY;
    ALTER TABLE company_credit_payments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE company_credit_payments FORCE ROW LEVEL SECURITY;
    CREATE POLICY company_credit_price_history_admin_policy ON company_credit_price_history
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY company_credit_payments_admin_policy ON company_credit_payments
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    GRANT SELECT, INSERT, UPDATE ON company_credit_price_history TO zea_voice_runtime;
    GRANT SELECT, INSERT ON company_credit_payments TO zea_voice_runtime;

    COMMENT ON COLUMN company_credit_wallets.balance IS 'Whole call-credit balance; never an INR amount.';
    COMMENT ON COLUMN company_credit_wallets.inr_remainder IS 'Private Super Admin INR remainder carried into the next payment allocation.';
    COMMENT ON COLUMN credit_ledger_entries.credit_amount IS 'Whole credit movement. Legacy amount remains for backward-compatible reads.';
    COMMENT ON COLUMN credit_ledger_entries.payment_amount_inr IS 'Super Admin payment amount; never exposed to company users.';
    COMMENT ON COLUMN credit_ledger_entries.price_per_credit_inr IS 'Immutable company per-minute price snapshot used for this entry.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE credit_ledger_entries
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_duration_nonnegative,
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_remainder_after_nonnegative,
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_remainder_before_nonnegative,
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_price_positive,
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_payment_nonnegative,
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_credit_amount_positive,
      DROP COLUMN IF EXISTS billed_duration_seconds,
      DROP COLUMN IF EXISTS remainder_after_inr,
      DROP COLUMN IF EXISTS remainder_before_inr,
      DROP COLUMN IF EXISTS price_per_credit_inr,
      DROP COLUMN IF EXISTS payment_amount_inr,
      DROP COLUMN IF EXISTS credit_amount;

    DROP TABLE IF EXISTS company_credit_payments;
    DROP TABLE IF EXISTS company_credit_price_history;
    ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_active_price_positive;
    ALTER TABLE company_credit_wallets
      DROP CONSTRAINT IF EXISTS company_credit_wallets_remainder_nonnegative,
      DROP CONSTRAINT IF EXISTS company_credit_wallets_threshold_whole,
      DROP CONSTRAINT IF EXISTS company_credit_wallets_reserved_whole,
      DROP CONSTRAINT IF EXISTS company_credit_wallets_balance_whole,
      DROP COLUMN IF EXISTS inr_remainder;
  `);
}
