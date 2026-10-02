export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TYPE ai_provider_type ADD VALUE IF NOT EXISTS 'telephony';

    ALTER TABLE company_credit_wallets
      DROP CONSTRAINT IF EXISTS company_credit_wallets_balance_whole,
      DROP CONSTRAINT IF EXISTS company_credit_wallets_reserved_whole;
    ALTER TABLE company_credit_wallets
      ALTER COLUMN balance TYPE numeric(24, 8),
      ALTER COLUMN reserved_balance TYPE numeric(24, 8),
      ALTER COLUMN inr_remainder TYPE numeric(24, 8);

    ALTER TABLE company_credit_payments
      ALTER COLUMN payment_amount_inr TYPE numeric(24, 8),
      ALTER COLUMN price_per_credit_inr TYPE numeric(24, 8),
      ALTER COLUMN remainder_before_inr TYPE numeric(24, 8),
      ALTER COLUMN credits_issued TYPE numeric(24, 8),
      ALTER COLUMN remainder_after_inr TYPE numeric(24, 8);
    ALTER TABLE credit_ledger_entries
      ALTER COLUMN amount TYPE numeric(24, 8),
      ALTER COLUMN credit_amount TYPE numeric(24, 8),
      ALTER COLUMN payment_amount_inr TYPE numeric(24, 8),
      ALTER COLUMN price_per_credit_inr TYPE numeric(24, 8),
      ALTER COLUMN remainder_before_inr TYPE numeric(24, 8),
      ALTER COLUMN remainder_after_inr TYPE numeric(24, 8);

    COMMENT ON COLUMN company_credit_wallets.balance IS
      'INR-denominated credit balance. One credit equals one INR; fractional credits support metered provider usage.';
    COMMENT ON COLUMN credit_ledger_entries.credit_amount IS
      'Exact credit movement in INR-equivalent credits; fractional amounts are allowed for metered usage.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE credit_ledger_entries ALTER COLUMN credit_amount TYPE bigint USING trunc(credit_amount)::bigint;
    ALTER TABLE company_credit_payments ALTER COLUMN credits_issued TYPE bigint USING trunc(credits_issued)::bigint;
    ALTER TABLE company_credit_wallets
      ALTER COLUMN balance TYPE numeric(18, 4),
      ALTER COLUMN reserved_balance TYPE numeric(18, 4),
      ALTER COLUMN inr_remainder TYPE numeric(18, 4);
  `);
}
