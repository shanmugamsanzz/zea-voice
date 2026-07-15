export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE INDEX call_sessions_started_at_idx
      ON call_sessions (started_at DESC);

    CREATE INDEX payment_transactions_created_at_idx
      ON payment_transactions (created_at DESC);

    CREATE INDEX payment_transactions_subscription_settled_idx
      ON payment_transactions (settled_at DESC)
      WHERE status = 'succeeded' AND type = 'subscription';

    CREATE INDEX credit_ledger_entries_created_at_idx
      ON credit_ledger_entries (created_at DESC);

    CREATE INDEX phone_numbers_created_at_idx
      ON phone_numbers (created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX tenant_memberships_admin_created_idx
      ON tenant_memberships (created_at DESC)
      WHERE deleted_at IS NULL
        AND role IN ('company_developer', 'company_user');
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS tenant_memberships_admin_created_idx;
    DROP INDEX IF EXISTS phone_numbers_created_at_idx;
    DROP INDEX IF EXISTS credit_ledger_entries_created_at_idx;
    DROP INDEX IF EXISTS payment_transactions_subscription_settled_idx;
    DROP INDEX IF EXISTS payment_transactions_created_at_idx;
    DROP INDEX IF EXISTS call_sessions_started_at_idx;
  `);
}
