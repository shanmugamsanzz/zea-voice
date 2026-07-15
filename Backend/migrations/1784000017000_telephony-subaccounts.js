export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE telephony_accounts
      ADD COLUMN account_type varchar(20) NOT NULL DEFAULT 'main',
      ADD COLUMN parent_account_id uuid REFERENCES telephony_accounts(id) ON DELETE RESTRICT,
      ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      ADD COLUMN provider_subaccount_id varchar(240);

    ALTER TABLE telephony_accounts
      ADD CONSTRAINT telephony_accounts_type_check
        CHECK (account_type IN ('main', 'subaccount')),
      ADD CONSTRAINT telephony_accounts_hierarchy_shape_check
        CHECK (
          (account_type = 'main' AND parent_account_id IS NULL AND tenant_id IS NULL AND provider_subaccount_id IS NULL)
          OR
          (account_type = 'subaccount' AND parent_account_id IS NOT NULL AND tenant_id IS NOT NULL AND provider_subaccount_id IS NOT NULL)
        );

    CREATE UNIQUE INDEX telephony_accounts_parent_tenant_unique
      ON telephony_accounts (parent_account_id, tenant_id)
      WHERE account_type = 'subaccount' AND deleted_at IS NULL;

    CREATE UNIQUE INDEX telephony_accounts_provider_subaccount_unique
      ON telephony_accounts (provider, provider_subaccount_id)
      WHERE provider_subaccount_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX telephony_accounts_tenant_idx
      ON telephony_accounts (tenant_id)
      WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS telephony_accounts_tenant_idx;
    DROP INDEX IF EXISTS telephony_accounts_provider_subaccount_unique;
    DROP INDEX IF EXISTS telephony_accounts_parent_tenant_unique;
    ALTER TABLE telephony_accounts
      DROP CONSTRAINT IF EXISTS telephony_accounts_hierarchy_shape_check,
      DROP CONSTRAINT IF EXISTS telephony_accounts_type_check,
      DROP COLUMN IF EXISTS provider_subaccount_id,
      DROP COLUMN IF EXISTS tenant_id,
      DROP COLUMN IF EXISTS parent_account_id,
      DROP COLUMN IF EXISTS account_type;
  `);
}
