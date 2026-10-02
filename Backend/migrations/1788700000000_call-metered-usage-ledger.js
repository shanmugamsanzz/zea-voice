export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE metered_service_type AS ENUM ('telephony', 'stt', 'llm', 'tts', 'audio_to_audio');
    CREATE TABLE call_metered_usage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_session_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      service_type metered_service_type NOT NULL,
      provider_id uuid,
      provider_name varchar(160),
      model_id uuid,
      model_key varchar(240),
      model_call_count integer NOT NULL DEFAULT 1,
      input_tokens bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      cached_input_tokens bigint NOT NULL DEFAULT 0,
      audio_input_tokens bigint NOT NULL DEFAULT 0,
      audio_output_tokens bigint NOT NULL DEFAULT 0,
      audio_input_ms bigint NOT NULL DEFAULT 0,
      audio_output_ms bigint NOT NULL DEFAULT 0,
      character_count bigint NOT NULL DEFAULT 0,
      duration_ms bigint NOT NULL DEFAULT 0,
      request_count integer NOT NULL DEFAULT 0,
      raw_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_metered_usage_events_call_tenant_fk FOREIGN KEY (call_session_id, tenant_id)
        REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT call_metered_usage_events_nonnegative CHECK (
        model_call_count > 0 AND input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0
        AND audio_input_tokens >= 0 AND audio_output_tokens >= 0 AND audio_input_ms >= 0
        AND audio_output_ms >= 0 AND character_count >= 0 AND duration_ms >= 0 AND request_count >= 0
      )
    );
    CREATE INDEX call_metered_usage_events_call_time_idx
      ON call_metered_usage_events (call_session_id, occurred_at ASC);
    CREATE INDEX call_metered_usage_events_tenant_service_idx
      ON call_metered_usage_events (tenant_id, service_type, created_at DESC);
    ALTER TABLE call_metered_usage_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_metered_usage_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY call_metered_usage_events_read_policy ON call_metered_usage_events FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());
    CREATE POLICY call_metered_usage_events_write_policy ON call_metered_usage_events FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    GRANT USAGE ON TYPE metered_service_type TO zea_voice_runtime;
    GRANT SELECT, INSERT ON call_metered_usage_events TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS call_metered_usage_events; DROP TYPE IF EXISTS metered_service_type;');
}
