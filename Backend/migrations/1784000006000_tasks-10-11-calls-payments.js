export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
    CREATE TYPE call_status AS ENUM (
      'queued', 'ringing', 'connected', 'completed', 'failed',
      'busy', 'no_answer', 'canceled'
    );
    CREATE TYPE call_sentiment AS ENUM ('unknown', 'positive', 'neutral', 'negative');
    CREATE TYPE transcript_speaker AS ENUM ('agent', 'user', 'system');
    CREATE TYPE payment_type AS ENUM ('subscription', 'credit_refill', 'add_on');
    CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

    CREATE TABLE call_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      workspace_id uuid NOT NULL,
      telephony_account_id uuid REFERENCES telephony_accounts(id) ON DELETE SET NULL,
      phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
      provider_call_id varchar(240),
      agent_id uuid,
      agent_name varchar(240),
      campaign_id uuid,
      campaign_name varchar(240),
      from_number varchar(20) NOT NULL,
      to_number varchar(20) NOT NULL,
      direction call_direction NOT NULL,
      status call_status NOT NULL DEFAULT 'queued',
      sentiment call_sentiment NOT NULL DEFAULT 'unknown',
      started_at timestamptz NOT NULL DEFAULT now(),
      ringing_at timestamptz,
      answered_at timestamptz,
      ended_at timestamptz,
      duration_seconds integer NOT NULL DEFAULT 0,
      cost numeric(14, 4) NOT NULL DEFAULT 0,
      currency char(3) NOT NULL DEFAULT 'INR',
      recording_object_key varchar(1000),
      provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_sessions_workspace_tenant_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT call_sessions_provider_call_unique UNIQUE (telephony_account_id, provider_call_id),
      CONSTRAINT call_sessions_from_e164 CHECK (from_number ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT call_sessions_to_e164 CHECK (to_number ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT call_sessions_duration_nonnegative CHECK (duration_seconds >= 0),
      CONSTRAINT call_sessions_cost_nonnegative CHECK (cost >= 0),
      CONSTRAINT call_sessions_time_order CHECK (
        (answered_at IS NULL OR answered_at >= started_at)
        AND (ended_at IS NULL OR ended_at >= started_at)
      )
    );

    CREATE TABLE call_transcript_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_session_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      sequence_number integer NOT NULL,
      speaker transcript_speaker NOT NULL,
      text text NOT NULL,
      offset_ms integer NOT NULL DEFAULT 0,
      is_final boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_transcript_entries_sequence_unique UNIQUE (call_session_id, sequence_number),
      CONSTRAINT call_transcript_entries_text_not_blank CHECK (btrim(text) <> ''),
      CONSTRAINT call_transcript_entries_offset_nonnegative CHECK (offset_ms >= 0)
    );

    CREATE TABLE call_control_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_session_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      action varchar(60) NOT NULL,
      reason varchar(300),
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE payment_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      workspace_id uuid NOT NULL,
      transaction_reference varchar(120) NOT NULL,
      external_reference varchar(240),
      type payment_type NOT NULL,
      status payment_status NOT NULL DEFAULT 'pending',
      amount numeric(18, 4) NOT NULL,
      currency char(3) NOT NULL DEFAULT 'INR',
      payment_method_label varchar(160),
      invoice_number varchar(120),
      invoice_object_key varchar(1000),
      settled_at timestamptz,
      failure_code varchar(120),
      failure_message varchar(500),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_transactions_workspace_tenant_fk FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT payment_transactions_reference_unique UNIQUE (transaction_reference),
      CONSTRAINT payment_transactions_external_unique UNIQUE (external_reference),
      CONSTRAINT payment_transactions_amount_positive CHECK (amount > 0),
      CONSTRAINT payment_transactions_settlement_shape CHECK (
        status <> 'succeeded' OR settled_at IS NOT NULL
      ),
      CONSTRAINT payment_transactions_failure_shape CHECK (
        status <> 'failed' OR failure_message IS NOT NULL
      )
    );

    CREATE INDEX call_sessions_active_idx ON call_sessions (status, started_at DESC)
      WHERE status IN ('queued', 'ringing', 'connected');
    CREATE INDEX call_sessions_tenant_started_idx ON call_sessions (tenant_id, started_at DESC);
    CREATE INDEX call_transcript_entries_call_sequence_idx
      ON call_transcript_entries (call_session_id, sequence_number);
    CREATE INDEX payment_transactions_tenant_created_idx
      ON payment_transactions (tenant_id, created_at DESC);
    CREATE INDEX payment_transactions_status_created_idx
      ON payment_transactions (status, created_at DESC);

    CREATE TRIGGER call_sessions_set_updated_at BEFORE UPDATE ON call_sessions
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER payment_transactions_set_updated_at BEFORE UPDATE ON payment_transactions
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE call_transcript_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_transcript_entries FORCE ROW LEVEL SECURITY;
    ALTER TABLE call_control_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_control_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payment_transactions FORCE ROW LEVEL SECURITY;

    CREATE POLICY call_sessions_select_policy ON call_sessions FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY call_sessions_write_policy ON call_sessions FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    CREATE POLICY call_transcript_select_policy ON call_transcript_entries FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY call_transcript_write_policy ON call_transcript_entries FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    CREATE POLICY call_control_select_policy ON call_control_events FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY call_control_insert_policy ON call_control_events FOR INSERT TO zea_voice_runtime
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());
    CREATE POLICY payment_transactions_select_policy ON payment_transactions FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY payment_transactions_write_policy ON payment_transactions FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());

    GRANT USAGE ON TYPE call_direction, call_status, call_sentiment,
      transcript_speaker, payment_type, payment_status TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE ON call_sessions, call_transcript_entries,
      payment_transactions TO zea_voice_runtime;
    GRANT SELECT, INSERT ON call_control_events TO zea_voice_runtime;

    COMMENT ON TABLE call_sessions IS 'Tenant-isolated live and completed Plivo call state used by monitoring and reports.';
    COMMENT ON TABLE payment_transactions IS 'Tenant-isolated billing ledger; gateway webhooks can update settlement state later.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_transactions;
    DROP TABLE IF EXISTS call_control_events;
    DROP TABLE IF EXISTS call_transcript_entries;
    DROP TABLE IF EXISTS call_sessions;
    DROP TYPE IF EXISTS payment_status;
    DROP TYPE IF EXISTS payment_type;
    DROP TYPE IF EXISTS transcript_speaker;
    DROP TYPE IF EXISTS call_sentiment;
    DROP TYPE IF EXISTS call_status;
    DROP TYPE IF EXISTS call_direction;
  `);
}
