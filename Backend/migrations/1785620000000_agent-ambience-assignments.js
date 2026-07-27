export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE agent_ambience_assignments (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      ambience_asset_id uuid NOT NULL,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, workspace_id, agent_id),
      CONSTRAINT agent_ambience_assignments_agent_tenant_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES voice_agents(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT agent_ambience_assignments_asset_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id, ambience_asset_id)
        REFERENCES company_ambience_assets(tenant_id, workspace_id, id) ON DELETE RESTRICT
    );

    CREATE INDEX agent_ambience_assignments_asset_idx
      ON agent_ambience_assignments (tenant_id, workspace_id, ambience_asset_id);

    CREATE TRIGGER agent_ambience_assignments_set_updated_at
      BEFORE UPDATE ON agent_ambience_assignments
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE agent_ambience_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_ambience_assignments FORCE ROW LEVEL SECURITY;
    CREATE POLICY agent_ambience_assignments_isolation_policy
      ON agent_ambience_assignments FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ambience_assignments TO zea_voice_runtime;

    COMMENT ON TABLE agent_ambience_assignments IS
      'One tenant- and workspace-isolated ambience asset assignment per voice agent.';
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS agent_ambience_assignments;');
}
