export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS company_credit_price_history;
    ALTER TABLE organizations
      DROP CONSTRAINT IF EXISTS organizations_active_price_positive,
      DROP CONSTRAINT IF EXISTS organizations_per_minute_price_nonnegative,
      DROP COLUMN IF EXISTS per_minute_price;

    COMMENT ON COLUMN company_credit_payments.price_per_credit_inr IS
      'Historical credit-value snapshot. New allocations use the fixed value: one credit equals one INR.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS per_minute_price numeric(12, 4) NOT NULL DEFAULT 0,
      ADD CONSTRAINT organizations_per_minute_price_nonnegative CHECK (per_minute_price >= 0);
  `);
}
