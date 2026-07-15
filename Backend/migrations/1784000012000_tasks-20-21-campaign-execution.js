export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE plivo_callback_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id uuid NOT NULL REFERENCES campaign_task_attempts(id) ON DELETE CASCADE,
      provider_call_id varchar(240) NOT NULL,
      event_type varchar(40) NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id, event_type, provider_call_id)
    );
    CREATE INDEX plivo_callback_events_call_idx
      ON plivo_callback_events (provider_call_id, received_at DESC);

    ALTER TABLE plivo_callback_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plivo_callback_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY plivo_callback_events_service_policy ON plivo_callback_events
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    GRANT SELECT, INSERT, DELETE ON plivo_callback_events TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS plivo_callback_events;');
}
