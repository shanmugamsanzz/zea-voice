export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    WITH ranked_active_prices AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY model_id, lower(parameter_name), effective_date
               ORDER BY updated_at DESC, created_at DESC, id DESC
             ) AS version_rank
        FROM provider_model_prices
       WHERE status = 'active'
    )
    UPDATE provider_model_prices price
       SET status = 'inactive'
      FROM ranked_active_prices ranked
     WHERE price.id = ranked.id AND ranked.version_rank > 1;

    CREATE UNIQUE INDEX provider_model_prices_one_active_period_unique
      ON provider_model_prices (model_id, lower(parameter_name), effective_date)
      WHERE status = 'active';

    CREATE OR REPLACE FUNCTION zea_provider_model_prices_keep_rate_history()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
        OR NEW.model_id IS DISTINCT FROM OLD.model_id
        OR NEW.parameter_name IS DISTINCT FROM OLD.parameter_name
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.unit_name IS DISTINCT FROM OLD.unit_name
        OR NEW.unit_quantity IS DISTINCT FROM OLD.unit_quantity
        OR NEW.price IS DISTINCT FROM OLD.price
        OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
        OR NEW.notes IS DISTINCT FROM OLD.notes
      THEN
        RAISE EXCEPTION 'Provider model price values are immutable; create a new price version instead';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER provider_model_prices_keep_rate_history
      BEFORE UPDATE ON provider_model_prices
      FOR EACH ROW EXECUTE FUNCTION zea_provider_model_prices_keep_rate_history();

    COMMENT ON INDEX provider_model_prices_one_active_period_unique IS
      'Allows only one active price for a model, parameter, and effective date while keeping inactive price versions as history.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS provider_model_prices_keep_rate_history ON provider_model_prices;
    DROP FUNCTION IF EXISTS zea_provider_model_prices_keep_rate_history();
    DROP INDEX IF EXISTS provider_model_prices_one_active_period_unique;
  `);
}
