export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE agent_call_transfer_settings (
      agent_id uuid PRIMARY KEY REFERENCES voice_agents(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      enabled boolean NOT NULL DEFAULT false,
      credential_source text NOT NULL CHECK (credential_source IN ('saved_account','manual')),
      telephony_account_id uuid NOT NULL REFERENCES telephony_accounts(id) ON DELETE RESTRICT,
      auth_id varchar(80),
      auth_token_encrypted text,
      destination_number varchar(20) NOT NULL CHECK (destination_number ~ '^\\+[1-9][0-9]{6,14}$'),
      transfer_mode text NOT NULL CHECK (transfer_mode IN ('direct_handoff','wait_and_return')),
      ring_timeout_seconds integer NOT NULL CHECK (ring_timeout_seconds BETWEEN 10 AND 120),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((credential_source='saved_account' AND auth_id IS NULL AND auth_token_encrypted IS NULL)
        OR (credential_source='manual' AND auth_id IS NOT NULL AND auth_token_encrypted IS NOT NULL))
    );
    ALTER TABLE agent_call_transfer_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_call_transfer_settings FORCE ROW LEVEL SECURITY;
    CREATE POLICY agent_call_transfer_settings_isolation ON agent_call_transfer_settings
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
    GRANT SELECT,INSERT,UPDATE,DELETE ON agent_call_transfer_settings TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS agent_call_transfer_settings');
}
