export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE postcall_summary_status AS ENUM
      ('queued', 'processing', 'completed', 'failed', 'skipped');

    CREATE TABLE call_ai_summaries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      workspace_id uuid NOT NULL,
      call_session_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE RESTRICT,
      model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
      status postcall_summary_status NOT NULL DEFAULT 'queued',
      instructions text NOT NULL,
      include_transcript_in_webhook boolean NOT NULL DEFAULT true,
      include_summary_in_webhook boolean NOT NULL DEFAULT true,
      summary_text text,
      outcome varchar(120),
      customer_intent varchar(240),
      sentiment varchar(40),
      collected_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      follow_up_required boolean,
      follow_up_reason text,
      usage jsonb NOT NULL DEFAULT '{}'::jsonb,
      provider_request_id varchar(500),
      duration_ms integer,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      bullmq_job_id varchar(240),
      error_code varchar(160),
      error_message varchar(2000),
      webhook_delivery jsonb NOT NULL DEFAULT '{}'::jsonb,
      queued_at timestamptz NOT NULL DEFAULT now(),
      processing_started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_ai_summaries_workspace_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT call_ai_summaries_call_fk FOREIGN KEY (call_session_id, tenant_id)
        REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT call_ai_summaries_agent_fk FOREIGN KEY (tenant_id, agent_id)
        REFERENCES voice_agents(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT call_ai_summaries_call_unique UNIQUE (call_session_id),
      CONSTRAINT call_ai_summaries_attempts_valid CHECK
        (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempt_count <= max_attempts),
      CONSTRAINT call_ai_summaries_duration_valid CHECK (duration_ms IS NULL OR duration_ms >= 0),
      CONSTRAINT call_ai_summaries_instructions_size CHECK
        (length(instructions) BETWEEN 1 AND 20000),
      CONSTRAINT call_ai_summaries_summary_size CHECK
        (summary_text IS NULL OR length(summary_text) <= 50000),
      CONSTRAINT call_ai_summaries_collected_data_object CHECK
        (jsonb_typeof(collected_data) = 'object' AND octet_length(collected_data::text) <= 131072),
      CONSTRAINT call_ai_summaries_usage_object CHECK
        (jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 131072),
      CONSTRAINT call_ai_summaries_webhook_object CHECK
        (jsonb_typeof(webhook_delivery) = 'object' AND octet_length(webhook_delivery::text) <= 131072)
    );

    CREATE INDEX call_ai_summaries_tenant_created_idx
      ON call_ai_summaries (tenant_id, created_at DESC);
    CREATE INDEX call_ai_summaries_workspace_created_idx
      ON call_ai_summaries (tenant_id, workspace_id, created_at DESC);
    CREATE INDEX call_ai_summaries_queue_recovery_idx
      ON call_ai_summaries (status, queued_at, created_at)
      WHERE status = 'queued' AND bullmq_job_id IS NULL;
    CREATE INDEX call_ai_summaries_agent_created_idx
      ON call_ai_summaries (tenant_id, agent_id, created_at DESC);

    CREATE TRIGGER call_ai_summaries_set_updated_at BEFORE UPDATE ON call_ai_summaries
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE call_ai_summaries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_ai_summaries FORCE ROW LEVEL SECURITY;
    CREATE POLICY call_ai_summaries_isolation_policy ON call_ai_summaries
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());

    GRANT USAGE ON TYPE postcall_summary_status TO zea_voice_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON call_ai_summaries TO zea_voice_runtime;

    COMMENT ON TABLE call_ai_summaries IS
      'Tenant/workspace/agent-isolated asynchronous AI summaries with one idempotent record per call.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS call_ai_summaries;
    DROP TYPE IF EXISTS postcall_summary_status;
  `);
}

