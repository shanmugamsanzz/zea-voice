export async function up(pgm) {
  pgm.sql(`CREATE TABLE phone_test_share_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id), agent_id uuid NOT NULL REFERENCES voice_agents(id),
    created_by uuid NOT NULL REFERENCES users(id), token_hash char(64) NOT NULL UNIQUE,
    expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX phone_test_share_links_agent_idx ON phone_test_share_links(tenant_id,agent_id,created_at);
  ALTER TABLE phone_test_share_links ENABLE ROW LEVEL SECURITY;
  ALTER TABLE phone_test_share_links FORCE ROW LEVEL SECURITY;
  CREATE POLICY phone_test_share_links_tenant_policy ON phone_test_share_links FOR ALL TO zea_voice_runtime
    USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id())
    WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
  GRANT SELECT,INSERT,UPDATE ON phone_test_share_links TO zea_voice_runtime;
  ALTER TABLE agent_phone_test_requests ADD COLUMN share_link_id uuid REFERENCES phone_test_share_links(id);
  CREATE INDEX phone_test_requests_share_idx ON agent_phone_test_requests(share_link_id) WHERE share_link_id IS NOT NULL;`);
}
export async function down(pgm) {
  pgm.sql('ALTER TABLE agent_phone_test_requests DROP COLUMN share_link_id; DROP TABLE phone_test_share_links;');
}
