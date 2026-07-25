export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE agent_pronunciation_groups (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL,
      group_id uuid NOT NULL,
      priority integer NOT NULL DEFAULT 100,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, agent_id, group_id),
      CONSTRAINT agent_pronunciation_groups_agent_tenant_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES voice_agents(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT agent_pronunciation_groups_group_tenant_fk
        FOREIGN KEY (tenant_id, group_id)
        REFERENCES pronunciation_groups(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT agent_pronunciation_groups_priority_range
        CHECK (priority BETWEEN 0 AND 10000)
    );

    CREATE INDEX agent_pronunciation_groups_agent_priority_idx
      ON agent_pronunciation_groups (tenant_id, agent_id, priority, created_at);
    CREATE INDEX agent_pronunciation_groups_group_idx
      ON agent_pronunciation_groups (tenant_id, group_id);

    ALTER TABLE agent_pronunciation_groups ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_pronunciation_groups FORCE ROW LEVEL SECURITY;
    CREATE POLICY agent_pronunciation_groups_isolation_policy
      ON agent_pronunciation_groups FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_pronunciation_groups TO zea_voice_runtime;

    COMMENT ON TABLE agent_pronunciation_groups IS
      'Tenant-safe ordered assignment of reusable pronunciation groups to voice agents.';
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS agent_pronunciation_groups;');
}
