export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE ai_provider_type AS ENUM ('llm', 'tts', 'stt');
    CREATE TYPE provider_connection_status AS ENUM ('connected', 'disconnected', 'error');
    CREATE TYPE provider_model_status AS ENUM ('active', 'inactive');
    CREATE TYPE phone_number_status AS ENUM ('active', 'unavailable', 'released');

    CREATE TABLE ai_providers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(160) NOT NULL,
      slug varchar(100) NOT NULL,
      type ai_provider_type NOT NULL,
      status provider_connection_status NOT NULL DEFAULT 'disconnected',
      base_url varchar(1000),
      latency_ms integer,
      usage_count bigint NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT ai_providers_name_unique UNIQUE (name),
      CONSTRAINT ai_providers_slug_unique UNIQUE (slug),
      CONSTRAINT ai_providers_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT ai_providers_latency_nonnegative CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CONSTRAINT ai_providers_usage_nonnegative CHECK (usage_count >= 0)
    );

    CREATE TABLE ai_provider_parameters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      key varchar(160) NOT NULL,
      plain_value text,
      encrypted_value text,
      is_secret boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_provider_parameters_provider_key_unique UNIQUE (provider_id, key),
      CONSTRAINT ai_provider_parameters_key_format CHECK (key ~ '^[A-Za-z][A-Za-z0-9_.-]*$'),
      CONSTRAINT ai_provider_parameters_value_shape CHECK (
        (is_secret AND encrypted_value IS NOT NULL AND plain_value IS NULL)
        OR (NOT is_secret AND plain_value IS NOT NULL AND encrypted_value IS NULL)
      )
    );

    CREATE TABLE provider_models (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      model_key varchar(240) NOT NULL,
      display_name varchar(240) NOT NULL,
      status provider_model_status NOT NULL DEFAULT 'active',
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT provider_models_provider_key_unique UNIQUE (provider_id, model_key),
      CONSTRAINT provider_models_key_not_blank CHECK (btrim(model_key) <> ''),
      CONSTRAINT provider_models_name_not_blank CHECK (btrim(display_name) <> '')
    );

    CREATE TABLE telephony_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider varchar(40) NOT NULL,
      name varchar(160) NOT NULL,
      auth_id varchar(240) NOT NULL,
      auth_token_encrypted text NOT NULL,
      status provider_connection_status NOT NULL DEFAULT 'disconnected',
      last_synced_at timestamptz,
      sync_error text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT telephony_accounts_provider_supported CHECK (provider IN ('plivo')),
      CONSTRAINT telephony_accounts_provider_auth_unique UNIQUE (provider, auth_id),
      CONSTRAINT telephony_accounts_name_unique UNIQUE (name)
    );

    CREATE TABLE phone_numbers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telephony_account_id uuid NOT NULL REFERENCES telephony_accounts(id) ON DELETE RESTRICT,
      e164 varchar(20) NOT NULL,
      provider_number_id varchar(240),
      country_iso varchar(2),
      number_type varchar(40),
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      monthly_cost numeric(14, 4),
      currency char(3) NOT NULL DEFAULT 'USD',
      status phone_number_status NOT NULL DEFAULT 'active',
      provider_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT phone_numbers_e164_unique UNIQUE (e164),
      CONSTRAINT phone_numbers_e164_format CHECK (e164 ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT phone_numbers_country_uppercase CHECK (country_iso IS NULL OR country_iso = upper(country_iso)),
      CONSTRAINT phone_numbers_currency_uppercase CHECK (currency = upper(currency)),
      CONSTRAINT phone_numbers_cost_nonnegative CHECK (monthly_cost IS NULL OR monthly_cost >= 0)
    );

    CREATE TABLE phone_number_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number_id uuid NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      released_by uuid REFERENCES users(id) ON DELETE SET NULL,
      released_at timestamptz,
      release_reason varchar(300),
      CONSTRAINT phone_number_assignments_release_shape CHECK (
        (released_at IS NULL AND released_by IS NULL)
        OR released_at IS NOT NULL
      )
    );

    CREATE UNIQUE INDEX phone_number_assignments_one_active_idx
      ON phone_number_assignments (phone_number_id) WHERE released_at IS NULL;
    CREATE INDEX phone_number_assignments_tenant_active_idx
      ON phone_number_assignments (tenant_id, assigned_at DESC) WHERE released_at IS NULL;
    CREATE INDEX provider_models_catalog_idx
      ON provider_models (provider_id, status) WHERE deleted_at IS NULL;
    CREATE INDEX phone_numbers_account_status_idx
      ON phone_numbers (telephony_account_id, status) WHERE deleted_at IS NULL;

    CREATE TRIGGER ai_providers_set_updated_at BEFORE UPDATE ON ai_providers
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER ai_provider_parameters_set_updated_at BEFORE UPDATE ON ai_provider_parameters
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER provider_models_set_updated_at BEFORE UPDATE ON provider_models
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER telephony_accounts_set_updated_at BEFORE UPDATE ON telephony_accounts
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER phone_numbers_set_updated_at BEFORE UPDATE ON phone_numbers
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_provider_parameters ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_provider_parameters FORCE ROW LEVEL SECURITY;
    ALTER TABLE provider_models ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_models FORCE ROW LEVEL SECURITY;
    ALTER TABLE telephony_accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE telephony_accounts FORCE ROW LEVEL SECURITY;
    ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE phone_numbers FORCE ROW LEVEL SECURITY;
    ALTER TABLE phone_number_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE phone_number_assignments FORCE ROW LEVEL SECURITY;

    CREATE POLICY ai_providers_select_policy ON ai_providers FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR (status = 'connected' AND deleted_at IS NULL));
    CREATE POLICY ai_providers_admin_write_policy ON ai_providers FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY ai_provider_parameters_admin_policy ON ai_provider_parameters FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY provider_models_select_policy ON provider_models FOR SELECT TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR (status = 'active' AND deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM ai_providers p
          WHERE p.id = provider_id AND p.status = 'connected' AND p.deleted_at IS NULL
        ))
      );
    CREATE POLICY provider_models_admin_write_policy ON provider_models FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY telephony_accounts_admin_policy ON telephony_accounts FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY phone_numbers_admin_write_policy ON phone_numbers FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY phone_numbers_tenant_select_policy ON phone_numbers FOR SELECT TO zea_voice_runtime
      USING (EXISTS (
        SELECT 1 FROM phone_number_assignments a
        WHERE a.phone_number_id = id
          AND a.tenant_id = zea_current_tenant_id()
          AND a.released_at IS NULL
      ));
    CREATE POLICY phone_assignments_admin_write_policy ON phone_number_assignments FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY phone_assignments_tenant_select_policy ON phone_number_assignments FOR SELECT TO zea_voice_runtime
      USING (tenant_id = zea_current_tenant_id() AND released_at IS NULL);

    GRANT USAGE ON TYPE ai_provider_type, provider_connection_status,
      provider_model_status, phone_number_status TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ai_providers, ai_provider_parameters,
      provider_models, telephony_accounts, phone_numbers, phone_number_assignments
      TO zea_voice_runtime;

    COMMENT ON TABLE ai_provider_parameters IS 'Provider configuration; secret values are AES-GCM encrypted by the application.';
    COMMENT ON TABLE phone_number_assignments IS 'Historical exclusive company assignments; only one unreleased row may exist per number.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS phone_number_assignments;
    DROP TABLE IF EXISTS phone_numbers;
    DROP TABLE IF EXISTS telephony_accounts;
    DROP TABLE IF EXISTS provider_models;
    DROP TABLE IF EXISTS ai_provider_parameters;
    DROP TABLE IF EXISTS ai_providers;
    DROP TYPE IF EXISTS phone_number_status;
    DROP TYPE IF EXISTS provider_model_status;
    DROP TYPE IF EXISTS provider_connection_status;
    DROP TYPE IF EXISTS ai_provider_type;
  `);
}
