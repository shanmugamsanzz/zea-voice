export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid,
      name varchar(160) NOT NULL,
      key_prefix varchar(24) NOT NULL,
      key_hash char(64) NOT NULL,
      scopes text[] NOT NULL DEFAULT ARRAY['*']::text[],
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      expires_at timestamptz,
      last_used_at timestamptz,
      last_used_ip inet,
      revoked_at timestamptz,
      revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
      revoke_reason varchar(300),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT api_keys_hash_unique UNIQUE (key_hash),
      CONSTRAINT api_keys_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT api_keys_scopes_not_empty CHECK (cardinality(scopes) > 0),
      CONSTRAINT api_keys_tenant_context_complete CHECK (
        (tenant_id IS NULL AND workspace_id IS NULL)
        OR (tenant_id IS NOT NULL AND workspace_id IS NOT NULL)
      ),
      CONSTRAINT api_keys_workspace_tenant_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT api_keys_revocation_shape CHECK (
        revoked_at IS NULL OR revoke_reason IS NOT NULL
      )
    );

    CREATE INDEX api_keys_active_hash_idx ON api_keys (key_hash)
      WHERE revoked_at IS NULL;
    CREATE INDEX api_keys_tenant_created_idx ON api_keys (tenant_id, created_at DESC);
    CREATE INDEX api_keys_creator_idx ON api_keys (created_by, created_at DESC);

    ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
    ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

    CREATE POLICY api_keys_select_policy ON api_keys FOR SELECT TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR tenant_id = zea_current_tenant_id()
      );
    CREATE POLICY api_keys_insert_policy ON api_keys FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        zea_is_platform_admin()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      );
    CREATE POLICY api_keys_update_policy ON api_keys FOR UPDATE TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      )
      WITH CHECK (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      );

    GRANT SELECT, INSERT, UPDATE ON api_keys TO zea_voice_runtime;
    COMMENT ON TABLE api_keys IS 'Hashed platform and tenant API credentials; plaintext keys are never persisted.';
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS api_keys;');
}
