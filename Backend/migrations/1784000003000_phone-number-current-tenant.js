export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE phone_numbers
      ADD COLUMN assigned_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

    UPDATE phone_numbers n
    SET assigned_tenant_id = a.tenant_id
    FROM phone_number_assignments a
    WHERE a.phone_number_id = n.id AND a.released_at IS NULL;

    CREATE INDEX phone_numbers_assigned_tenant_idx
      ON phone_numbers (assigned_tenant_id) WHERE assigned_tenant_id IS NOT NULL;

    DROP POLICY phone_numbers_tenant_select_policy ON phone_numbers;
    CREATE POLICY phone_numbers_tenant_select_policy ON phone_numbers FOR SELECT TO zea_voice_runtime
      USING (assigned_tenant_id = zea_current_tenant_id());
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP POLICY IF EXISTS phone_numbers_tenant_select_policy ON phone_numbers;
    CREATE POLICY phone_numbers_tenant_select_policy ON phone_numbers FOR SELECT TO zea_voice_runtime
      USING (EXISTS (
        SELECT 1 FROM phone_number_assignments a
        WHERE a.phone_number_id = id
          AND a.tenant_id = zea_current_tenant_id()
          AND a.released_at IS NULL
      ));
    DROP INDEX IF EXISTS phone_numbers_assigned_tenant_idx;
    ALTER TABLE phone_numbers DROP COLUMN IF EXISTS assigned_tenant_id;
  `);
}
