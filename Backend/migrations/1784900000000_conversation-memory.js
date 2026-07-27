export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE conversation_memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      context_hash char(64) NOT NULL,
      context_source varchar(40) NOT NULL,
      memory_state jsonb NOT NULL DEFAULT '{}'::jsonb,
      revision integer NOT NULL DEFAULT 1,
      last_call_session_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
      last_outcome varchar(80),
      last_call_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT conversation_memories_workspace_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT conversation_memories_agent_fk FOREIGN KEY (tenant_id, agent_id)
        REFERENCES voice_agents(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT conversation_memories_identity_unique UNIQUE
        (tenant_id, workspace_id, agent_id, context_hash),
      CONSTRAINT conversation_memories_hash_format CHECK (context_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT conversation_memories_revision_positive CHECK (revision > 0),
      CONSTRAINT conversation_memories_state_object CHECK (jsonb_typeof(memory_state)='object'),
      CONSTRAINT conversation_memories_state_size CHECK (octet_length(memory_state::text) <= 131072)
    );
    CREATE INDEX conversation_memories_tenant_updated_idx
      ON conversation_memories (tenant_id, updated_at DESC);
    CREATE INDEX conversation_memories_last_call_idx
      ON conversation_memories (last_call_session_id) WHERE last_call_session_id IS NOT NULL;
    CREATE TRIGGER conversation_memories_set_updated_at BEFORE UPDATE ON conversation_memories
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    ALTER TABLE conversation_memories ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversation_memories FORCE ROW LEVEL SECURITY;
    CREATE POLICY conversation_memories_isolation_policy ON conversation_memories FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());
    GRANT SELECT,INSERT,UPDATE,DELETE ON conversation_memories TO zea_voice_runtime;
    COMMENT ON TABLE conversation_memories IS
      'Durable tenant/workspace/agent-isolated conversation continuation state keyed by a one-way context hash.';
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS conversation_memories;');
}
