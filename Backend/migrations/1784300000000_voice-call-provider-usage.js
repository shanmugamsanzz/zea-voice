export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE call_provider_kind AS ENUM ('telephony', 'stt', 'llm', 'tts');
    CREATE TABLE call_provider_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_session_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      provider_kind call_provider_kind NOT NULL,
      provider_id uuid,
      provider_name varchar(160),
      model_id uuid,
      model_key varchar(240),
      request_count integer NOT NULL DEFAULT 0,
      input_tokens bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      total_tokens bigint NOT NULL DEFAULT 0,
      audio_input_ms bigint NOT NULL DEFAULT 0,
      audio_output_ms bigint NOT NULL DEFAULT 0,
      character_count bigint NOT NULL DEFAULT 0,
      duration_ms bigint NOT NULL DEFAULT 0,
      cost numeric(18, 8) NOT NULL DEFAULT 0,
      currency char(3) NOT NULL DEFAULT 'INR',
      raw_usage jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_provider_usage_call_tenant_fk FOREIGN KEY (call_session_id, tenant_id)
        REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT call_provider_usage_identity_unique UNIQUE
        (call_session_id, provider_kind, provider_id, model_id),
      CONSTRAINT call_provider_usage_nonnegative CHECK (
        request_count >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0
        AND audio_input_ms >= 0 AND audio_output_ms >= 0 AND character_count >= 0
        AND duration_ms >= 0 AND cost >= 0
      )
    );
    CREATE INDEX call_provider_usage_tenant_created_idx ON call_provider_usage (tenant_id, created_at DESC);
    CREATE TRIGGER call_provider_usage_set_updated_at BEFORE UPDATE ON call_provider_usage
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    ALTER TABLE call_provider_usage ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_provider_usage FORCE ROW LEVEL SECURITY;
    CREATE POLICY call_provider_usage_select_policy ON call_provider_usage FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());
    CREATE POLICY call_provider_usage_write_policy ON call_provider_usage FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    GRANT USAGE ON TYPE call_provider_kind TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE ON call_provider_usage TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS call_provider_usage; DROP TYPE IF EXISTS call_provider_kind;');
}
