export const shorthands = undefined;

// Restores the migration already applied to the shared database. Company wallet
// balances are call credits; the currency column remains only for legacy API
// compatibility and private INR accounting is added by a later migration.
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE company_credit_wallets
      ADD COLUMN IF NOT EXISTS unit varchar(24) NOT NULL DEFAULT 'credit';

    DO $$ BEGIN
      ALTER TABLE company_credit_wallets
        ADD CONSTRAINT company_credit_wallets_unit_valid CHECK (unit = 'credit');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE company_credit_wallets DROP CONSTRAINT IF EXISTS company_credit_wallets_unit_valid;
    ALTER TABLE company_credit_wallets DROP COLUMN IF EXISTS unit;
  `);
}

