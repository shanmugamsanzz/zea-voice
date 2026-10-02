export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE provider_models
      ADD CONSTRAINT provider_models_id_provider_unique UNIQUE (id, provider_id);

    CREATE TABLE provider_model_prices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id uuid NOT NULL,
      model_id uuid NOT NULL,
      parameter_name varchar(120) NOT NULL,
      currency char(3) NOT NULL,
      unit_name varchar(120) NOT NULL,
      unit_quantity numeric(24, 8) NOT NULL,
      price numeric(24, 8) NOT NULL,
      effective_date date NOT NULL DEFAULT CURRENT_DATE,
      status varchar(16) NOT NULL DEFAULT 'active',
      notes varchar(2000),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_model_prices_provider_model_fk
        FOREIGN KEY (model_id, provider_id)
        REFERENCES provider_models (id, provider_id) ON DELETE CASCADE,
      CONSTRAINT provider_model_prices_parameter_not_blank
        CHECK (btrim(parameter_name) <> ''),
      CONSTRAINT provider_model_prices_currency_uppercase
        CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT provider_model_prices_unit_not_blank
        CHECK (btrim(unit_name) <> ''),
      CONSTRAINT provider_model_prices_unit_quantity_positive
        CHECK (unit_quantity > 0),
      CONSTRAINT provider_model_prices_price_nonnegative
        CHECK (price >= 0),
      CONSTRAINT provider_model_prices_status_check
        CHECK (status IN ('active', 'inactive'))
    );

    CREATE INDEX provider_model_prices_model_effective_idx
      ON provider_model_prices (model_id, effective_date DESC, updated_at DESC);
    CREATE INDEX provider_model_prices_provider_status_idx
      ON provider_model_prices (provider_id, status, effective_date DESC);

    CREATE TRIGGER provider_model_prices_set_updated_at
      BEFORE UPDATE ON provider_model_prices
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE provider_model_prices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_model_prices FORCE ROW LEVEL SECURITY;
    CREATE POLICY provider_model_prices_admin_policy ON provider_model_prices
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_model_prices TO zea_voice_runtime;

    COMMENT ON TABLE provider_model_prices IS
      'Admin-maintained provider model price parameters. This table stores pricing only; it does not calculate call cost.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS provider_model_prices;
    ALTER TABLE provider_models
      DROP CONSTRAINT IF EXISTS provider_models_id_provider_unique;
  `);
}
