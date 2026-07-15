export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE telephony_accounts
      DROP CONSTRAINT IF EXISTS telephony_accounts_provider_auth_unique,
      DROP CONSTRAINT IF EXISTS telephony_accounts_name_unique;

    CREATE UNIQUE INDEX telephony_accounts_active_provider_auth_unique
      ON telephony_accounts (provider, auth_id)
      WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX telephony_accounts_active_name_unique
      ON telephony_accounts (name)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS telephony_accounts_active_name_unique;
    DROP INDEX IF EXISTS telephony_accounts_active_provider_auth_unique;
  `);
}
