export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE currency_exchange_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      inr_per_unit numeric(24, 8) NOT NULL CHECK (inr_per_unit > 0),
      effective_date date NOT NULL DEFAULT CURRENT_DATE,
      status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      notes varchar(2000),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX currency_exchange_rates_one_active_period_unique
      ON currency_exchange_rates (currency, effective_date) WHERE status='active';
    CREATE INDEX currency_exchange_rates_lookup_idx
      ON currency_exchange_rates (currency, status, effective_date DESC);
    CREATE TRIGGER currency_exchange_rates_set_updated_at
      BEFORE UPDATE ON currency_exchange_rates
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    ALTER TABLE currency_exchange_rates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE currency_exchange_rates FORCE ROW LEVEL SECURITY;
    CREATE POLICY currency_exchange_rates_admin_policy ON currency_exchange_rates
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY currency_exchange_rates_runtime_read_policy ON currency_exchange_rates
      FOR SELECT TO zea_voice_runtime USING (zea_is_platform_admin() OR zea_is_auth_service());
    GRANT SELECT, INSERT, UPDATE, DELETE ON currency_exchange_rates TO zea_voice_runtime;

    DROP POLICY IF EXISTS provider_model_prices_admin_policy ON provider_model_prices;
    CREATE POLICY provider_model_prices_admin_policy ON provider_model_prices
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
    CREATE POLICY provider_model_prices_runtime_read_policy ON provider_model_prices
      FOR SELECT TO zea_voice_runtime USING (zea_is_platform_admin() OR zea_is_auth_service());

    CREATE TABLE call_metered_usage_costs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      usage_event_id uuid NOT NULL REFERENCES call_metered_usage_events(id) ON DELETE CASCADE,
      call_session_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      provider_model_price_id uuid,
      exchange_rate_id uuid,
      parameter_key varchar(80) NOT NULL,
      parameter_name varchar(120) NOT NULL,
      price_currency char(3) NOT NULL,
      price_unit_name varchar(120) NOT NULL,
      price_unit_quantity numeric(24, 8) NOT NULL CHECK (price_unit_quantity > 0),
      configured_price numeric(24, 8) NOT NULL CHECK (configured_price >= 0),
      usage_quantity numeric(24, 8) NOT NULL CHECK (usage_quantity >= 0),
      source_cost numeric(24, 8) NOT NULL CHECK (source_cost >= 0),
      inr_exchange_rate numeric(24, 8) NOT NULL CHECK (inr_exchange_rate > 0),
      cost_inr numeric(24, 8) NOT NULL CHECK (cost_inr >= 0),
      calculated_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT call_metered_usage_costs_event_parameter_unique UNIQUE (usage_event_id, parameter_key),
      CONSTRAINT call_metered_usage_costs_call_tenant_fk FOREIGN KEY (call_session_id, tenant_id)
        REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE
    );
    CREATE INDEX call_metered_usage_costs_call_idx ON call_metered_usage_costs (call_session_id, calculated_at ASC);
    CREATE INDEX call_metered_usage_costs_tenant_idx ON call_metered_usage_costs (tenant_id, calculated_at DESC);
    ALTER TABLE call_metered_usage_costs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_metered_usage_costs FORCE ROW LEVEL SECURITY;
    CREATE POLICY call_metered_usage_costs_read_policy ON call_metered_usage_costs FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());
    CREATE POLICY call_metered_usage_costs_write_policy ON call_metered_usage_costs FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    GRANT SELECT, INSERT ON call_metered_usage_costs TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS call_metered_usage_costs;
    DROP POLICY IF EXISTS provider_model_prices_runtime_read_policy ON provider_model_prices;
    DROP TABLE IF EXISTS currency_exchange_rates;
  `);
}
