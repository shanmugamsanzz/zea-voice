export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE agent_live_data_tables (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL,
      agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
      name varchar(160) NOT NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_live_data_tables_name_not_blank CHECK (btrim(name) <> '')
    );

    CREATE UNIQUE INDEX agent_live_data_tables_agent_name_unique_idx
      ON agent_live_data_tables (tenant_id, agent_id, lower(name));
    CREATE INDEX agent_live_data_tables_agent_idx
      ON agent_live_data_tables (tenant_id, agent_id, created_at);

    CREATE TABLE agent_live_data_columns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      table_id uuid NOT NULL REFERENCES agent_live_data_tables(id) ON DELETE CASCADE,
      name varchar(160) NOT NULL,
      column_key varchar(160) NOT NULL,
      data_type varchar(20) NOT NULL DEFAULT 'text',
      position integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_live_data_columns_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT agent_live_data_columns_key_format CHECK (column_key ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT agent_live_data_columns_type CHECK (data_type IN ('text', 'number', 'date', 'boolean')),
      CONSTRAINT agent_live_data_columns_position_nonnegative CHECK (position >= 0)
    );

    CREATE UNIQUE INDEX agent_live_data_columns_table_key_unique_idx
      ON agent_live_data_columns (table_id, column_key);
    CREATE INDEX agent_live_data_columns_table_position_idx
      ON agent_live_data_columns (tenant_id, table_id, position, created_at);

    CREATE TABLE agent_live_data_rows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      table_id uuid NOT NULL REFERENCES agent_live_data_tables(id) ON DELETE CASCADE,
      row_values jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_live_data_rows_values_object CHECK (jsonb_typeof(row_values) = 'object')
    );

    CREATE INDEX agent_live_data_rows_table_idx
      ON agent_live_data_rows (tenant_id, table_id, updated_at DESC);

    CREATE TRIGGER agent_live_data_tables_set_updated_at BEFORE UPDATE ON agent_live_data_tables
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER agent_live_data_columns_set_updated_at BEFORE UPDATE ON agent_live_data_columns
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER agent_live_data_rows_set_updated_at BEFORE UPDATE ON agent_live_data_rows
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE agent_live_data_tables ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_live_data_tables FORCE ROW LEVEL SECURITY;
    ALTER TABLE agent_live_data_columns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_live_data_columns FORCE ROW LEVEL SECURITY;
    ALTER TABLE agent_live_data_rows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_live_data_rows FORCE ROW LEVEL SECURITY;

    CREATE POLICY agent_live_data_tables_tenant_policy ON agent_live_data_tables FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY agent_live_data_columns_tenant_policy ON agent_live_data_columns FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY agent_live_data_rows_tenant_policy ON agent_live_data_rows FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_live_data_tables, agent_live_data_columns, agent_live_data_rows TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS agent_live_data_rows;
    DROP TABLE IF EXISTS agent_live_data_columns;
    DROP TABLE IF EXISTS agent_live_data_tables;
  `);
}
