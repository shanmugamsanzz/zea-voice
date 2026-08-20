export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE agent_tools
      DROP CONSTRAINT IF EXISTS agent_tools_tenant_id_agent_id_name_key;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_tools_active_name_unique_idx
      ON agent_tools(tenant_id, agent_id, name)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS agent_tools_active_name_unique_idx;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM agent_tools
        GROUP BY tenant_id, agent_id, name
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot restore legacy agent tool constraint while reused archived names exist';
      END IF;
    END $$;
    ALTER TABLE agent_tools
      ADD CONSTRAINT agent_tools_tenant_id_agent_id_name_key
      UNIQUE (tenant_id, agent_id, name);
  `);
}
