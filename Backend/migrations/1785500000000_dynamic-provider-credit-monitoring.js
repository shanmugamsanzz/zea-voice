export const shorthands = undefined;

// Restored from the schema of the database where this historical migration was
// originally applied. Keep this filename and definition permanently: deleting
// an applied migration makes node-pg-migrate reject every later migration.
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE provider_balance_configs (
      provider_id uuid PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
      balance_fetch_enabled boolean NOT NULL DEFAULT true,
      balance_fetch_mode varchar(24) NOT NULL DEFAULT 'UNAVAILABLE',
      balance_endpoint varchar(2000),
      balance_http_method varchar(8) NOT NULL DEFAULT 'GET',
      balance_auth_type varchar(24) NOT NULL DEFAULT 'NONE',
      balance_auth_header varchar(160),
      credential_key varchar(160),
      balance_response_path varchar(400),
      usage_response_path varchar(400),
      limit_response_path varchar(400),
      currency_response_path varchar(400),
      plan_response_path varchar(400),
      status_response_path varchar(400),
      reset_response_path varchar(400),
      balance_unit varchar(80),
      balance_currency char(3),
      balance_formula varchar(40) NOT NULL DEFAULT 'DIRECT',
      manual_balance numeric(24,6),
      manual_available numeric(24,6),
      manual_used numeric(24,6),
      manual_limit numeric(24,6),
      manual_plan varchar(160),
      unavailable_reason varchar(500),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_balance_configs_mode_check
        CHECK (balance_fetch_mode IN ('API','USAGE_DERIVED','MANUAL','UNAVAILABLE')),
      CONSTRAINT provider_balance_configs_method_check CHECK (balance_http_method IN ('GET','POST')),
      CONSTRAINT provider_balance_configs_auth_check
        CHECK (balance_auth_type IN ('NONE','API_KEY_HEADER','BEARER','BASIC')),
      CONSTRAINT provider_balance_configs_endpoint_check
        CHECK (balance_endpoint IS NULL OR balance_endpoint ~ '^https://'),
      CONSTRAINT provider_balance_configs_currency_check
        CHECK (balance_currency IS NULL OR balance_currency ~ '^[A-Z]{3}$'),
      CONSTRAINT provider_balance_configs_formula_check
        CHECK (balance_formula IN ('DIRECT','LIMIT_MINUS_USAGE','SUM')),
      CONSTRAINT provider_balance_configs_values_check CHECK (
        (manual_balance IS NULL OR manual_balance >= 0) AND
        (manual_available IS NULL OR manual_available >= 0) AND
        (manual_used IS NULL OR manual_used >= 0) AND
        (manual_limit IS NULL OR manual_limit >= 0)
      )
    );

    CREATE TABLE provider_credit_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      balance numeric(24,6),
      available numeric(24,6),
      used numeric(24,6),
      "limit" numeric(24,6),
      unit varchar(80),
      currency char(3),
      plan varchar(160),
      fetch_mode varchar(24) NOT NULL,
      status varchar(24) NOT NULL,
      error varchar(500),
      raw_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_credit_snapshots_mode_check
        CHECK (fetch_mode IN ('API','USAGE_DERIVED','MANUAL','UNAVAILABLE')),
      CONSTRAINT provider_credit_snapshots_status_check
        CHECK (status IN ('LIVE','USAGE_DERIVED','MANUAL','NOT_AVAILABLE','FETCH_ERROR')),
      CONSTRAINT provider_credit_snapshots_currency_check
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
      CONSTRAINT provider_credit_snapshots_values_check CHECK (
        (balance IS NULL OR balance >= 0) AND
        (available IS NULL OR available >= 0) AND
        (used IS NULL OR used >= 0) AND
        ("limit" IS NULL OR "limit" >= 0)
      )
    );

    CREATE INDEX provider_credit_snapshots_provider_fetched_idx
      ON provider_credit_snapshots (provider_id, fetched_at DESC);
    CREATE INDEX provider_credit_snapshots_success_idx
      ON provider_credit_snapshots (provider_id, fetched_at DESC)
      WHERE status IN ('LIVE','USAGE_DERIVED','MANUAL');

    CREATE TRIGGER provider_balance_configs_set_updated_at
      BEFORE UPDATE ON provider_balance_configs
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE provider_balance_configs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_balance_configs FORCE ROW LEVEL SECURITY;
    CREATE POLICY provider_balance_configs_admin_policy
      ON provider_balance_configs FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    ALTER TABLE provider_credit_snapshots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_credit_snapshots FORCE ROW LEVEL SECURITY;
    CREATE POLICY provider_credit_snapshots_admin_policy
      ON provider_credit_snapshots FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_balance_configs TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_credit_snapshots TO zea_voice_runtime;

    COMMENT ON TABLE provider_balance_configs IS
      'Optional backend-only balance, quota, usage-derived, manual, or unavailable configuration for an AI provider.';
    COMMENT ON TABLE provider_credit_snapshots IS
      'Historical normalized provider balance and usage snapshots; never stores provider credentials.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS provider_credit_snapshots;
    DROP TABLE IF EXISTS provider_balance_configs;
  `);
}
