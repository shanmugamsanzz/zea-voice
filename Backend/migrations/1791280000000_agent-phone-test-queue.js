export async function up(pgm) {
  pgm.sql(`CREATE TABLE agent_phone_test_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    agent_id uuid NOT NULL REFERENCES voice_agents(id),
    created_by uuid REFERENCES users(id),
    request_key uuid NOT NULL,
    phone varchar(32) NOT NULL,
    status text NOT NULL CHECK(status IN ('queued','dispatching','initiated','failed','canceled')),
    queue_reason text NOT NULL DEFAULT 'company_capacity',
    provider_request_id text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,workspace_id,request_key)
  );
  CREATE INDEX agent_phone_test_waiting_idx ON agent_phone_test_requests(tenant_id,created_at,id) WHERE status='queued';
  ALTER TABLE agent_phone_test_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE agent_phone_test_requests FORCE ROW LEVEL SECURITY;
  CREATE POLICY agent_phone_test_tenant_policy ON agent_phone_test_requests FOR ALL TO zea_voice_runtime
    USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id())
    WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
  GRANT SELECT,INSERT,UPDATE,DELETE ON agent_phone_test_requests TO zea_voice_runtime;`);
}
export async function down(pgm) { pgm.sql('DROP TABLE agent_phone_test_requests;'); }
