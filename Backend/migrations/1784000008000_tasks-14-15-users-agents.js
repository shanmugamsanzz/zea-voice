export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE voice_agent_status AS ENUM ('draft', 'active', 'archived');

    CREATE TABLE voice_agents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL,
      name varchar(160) NOT NULL,
      description text,
      goal text,
      language varchar(80) NOT NULL DEFAULT 'English (US)',
      status voice_agent_status NOT NULL DEFAULT 'draft',
      phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE RESTRICT,
      stt_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
      llm_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
      tts_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
      voice_id varchar(240) NOT NULL,
      prompt text NOT NULL,
      welcome_message text,
      temperature numeric(4,3) NOT NULL DEFAULT 0.7,
      interruption_sensitivity numeric(4,3) NOT NULL DEFAULT 0.3,
      silence_timeout_ms integer NOT NULL DEFAULT 600,
      inactivity_timeout_seconds integer NOT NULL DEFAULT 5,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT voice_agents_workspace_tenant_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT voice_agents_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT voice_agents_voice_not_blank CHECK (btrim(voice_id) <> ''),
      CONSTRAINT voice_agents_prompt_not_blank CHECK (btrim(prompt) <> ''),
      CONSTRAINT voice_agents_temperature_range CHECK (temperature BETWEEN 0 AND 2),
      CONSTRAINT voice_agents_interruption_range CHECK (interruption_sensitivity BETWEEN 0 AND 1),
      CONSTRAINT voice_agents_silence_timeout_range CHECK (silence_timeout_ms BETWEEN 100 AND 120000),
      CONSTRAINT voice_agents_inactivity_timeout_range CHECK (inactivity_timeout_seconds BETWEEN 1 AND 3600)
    );

    CREATE UNIQUE INDEX voice_agents_tenant_name_unique_idx ON voice_agents (tenant_id, lower(name))
      WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX voice_agents_phone_mapping_unique_idx ON voice_agents (phone_number_id)
      WHERE phone_number_id IS NOT NULL AND status <> 'archived' AND deleted_at IS NULL;
    CREATE INDEX voice_agents_tenant_status_idx ON voice_agents (tenant_id, status, created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TRIGGER voice_agents_set_updated_at BEFORE UPDATE ON voice_agents
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE voice_agents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE voice_agents FORCE ROW LEVEL SECURITY;
    CREATE POLICY voice_agents_isolation_policy ON voice_agents FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT USAGE ON TYPE voice_agent_status TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON voice_agents TO zea_voice_runtime;
    COMMENT ON TABLE voice_agents IS 'Tenant-isolated voice agent definitions referencing centrally managed provider models.';
  `);
}

export async function down(pgm) {
  pgm.sql(`DROP TABLE IF EXISTS voice_agents; DROP TYPE IF EXISTS voice_agent_status;`);
}
