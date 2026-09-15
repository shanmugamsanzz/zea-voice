export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE browser_test_share_links (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      agent_id uuid NOT NULL REFERENCES voice_agents(id),
      created_by_user_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX browser_test_share_links_active_lookup
      ON browser_test_share_links(token_hash, expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE browser_test_share_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_test_share_links FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_test_share_links_tenant_isolation
      ON browser_test_share_links FOR ALL TO zea_voice_runtime
      USING (zea_is_auth_service() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_auth_service() OR tenant_id = zea_current_tenant_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON browser_test_share_links TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS browser_test_share_links;');
}
