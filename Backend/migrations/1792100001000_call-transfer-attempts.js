export async function up(pgm) {
  pgm.sql(`CREATE TABLE call_transfer_attempts (
    id uuid PRIMARY KEY,
    call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    provider_call_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('requested','ringing','bridged','resuming','returned','failed','ended','canceled')),
    mode text NOT NULL CHECK (mode IN ('direct_handoff','wait_and_return')),
    destination_number text NOT NULL,
    caller_id text NOT NULL,
    ring_timeout_seconds integer NOT NULL CHECK (ring_timeout_seconds BETWEEN 10 AND 120),
    auth_id text NOT NULL,
    auth_token_encrypted text NOT NULL,
    main_auth_token_encrypted text NOT NULL,
    staff_call_id text,
    result text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX call_transfer_one_active ON call_transfer_attempts(call_id)
    WHERE state IN ('requested','ringing','bridged','resuming');
  ALTER TABLE call_transfer_attempts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE call_transfer_attempts FORCE ROW LEVEL SECURITY;
  CREATE POLICY call_transfer_attempts_admin ON call_transfer_attempts FOR ALL TO zea_voice_runtime
    USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());
  GRANT SELECT,INSERT,UPDATE,DELETE ON call_transfer_attempts TO zea_voice_runtime;`);
}
export async function down(pgm) { pgm.sql('DROP TABLE IF EXISTS call_transfer_attempts'); }
