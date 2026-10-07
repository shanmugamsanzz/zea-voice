export async function up(pgm) {
  pgm.sql(`
    -- Legacy prompt/welcome fields remain authoritative until runtime rollout.
    ALTER TABLE voice_agents
      ADD COLUMN inbound_prompt text,
      ADD COLUMN outbound_prompt text,
      ADD COLUMN inbound_welcome_message text,
      ADD COLUMN outbound_welcome_message text,
      ADD CONSTRAINT voice_agents_direction_prompt_check CHECK (
        (inbound_prompt IS NULL OR btrim(inbound_prompt) <> '') AND
        (outbound_prompt IS NULL OR btrim(outbound_prompt) <> '')),
      ADD CONSTRAINT voice_agents_tenant_workspace_identity UNIQUE (tenant_id, workspace_id, id);
    UPDATE voice_agents SET inbound_prompt=prompt, outbound_prompt=prompt,
      inbound_welcome_message=welcome_message, outbound_welcome_message=welcome_message;
    ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_tenant_workspace_identity
      UNIQUE (tenant_id, workspace_id, id);

    CREATE TABLE conversation_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      phone_e164 varchar(16) NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{6,14}$'),
      display_name varchar(240) CHECK (display_name IS NULL OR btrim(display_name) <> ''),
      name_source varchar(40) CHECK (name_source IS NULL OR name_source IN ('caller','campaign','manual')),
      name_updated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, phone_e164), UNIQUE (tenant_id, id)
    );
    CREATE TABLE contact_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, contact_id) REFERENCES conversation_contacts(tenant_id,id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, contact_id), UNIQUE (tenant_id, id)
    );
    -- A link adds a timeline without moving transcripts, summaries or billing.
    CREATE TABLE conversation_call_links (
      call_session_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
      call_purpose varchar(80) NOT NULL DEFAULT 'unknown' CHECK (btrim(call_purpose) <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id,workspace_id,call_session_id)
        REFERENCES call_sessions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,conversation_id) REFERENCES contact_conversations(tenant_id,id) ON DELETE RESTRICT,
      UNIQUE (tenant_id,conversation_id,call_session_id)
    );
    CREATE INDEX conversation_call_links_timeline_idx
      ON conversation_call_links(tenant_id,conversation_id,created_at DESC,call_session_id);

    CREATE TABLE scheduled_follow_up_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
      conversation_id uuid NOT NULL, origin_call_session_id uuid,
      request_key uuid NOT NULL,
      kind varchar(20) NOT NULL CHECK (kind IN ('callback','reminder')),
      purpose text NOT NULL CHECK (btrim(purpose) <> ''),
      requested_for timestamptz NOT NULL, scheduled_for timestamptz NOT NULL,
      time_zone varchar(160) NOT NULL CHECK (btrim(time_zone) <> ''),
      request_text text,
      status varchar(20) NOT NULL DEFAULT 'scheduled' CHECK (
        status IN ('scheduled','queued','dispatching','initiated','completed','no_answer','busy','failed','canceled')),
      max_retries integer NOT NULL DEFAULT 0 CHECK (max_retries BETWEEN 0 AND 10),
      retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND max_retries),
      lease_token uuid, lease_expires_at timestamptz,
      last_error_code varchar(120), canceled_at timestamptz, finished_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id,workspace_id,agent_id)
        REFERENCES voice_agents(tenant_id,workspace_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,conversation_id) REFERENCES contact_conversations(tenant_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,conversation_id,origin_call_session_id)
        REFERENCES conversation_call_links(tenant_id,conversation_id,call_session_id) ON DELETE RESTRICT,
      CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
      UNIQUE (tenant_id,request_key), UNIQUE (tenant_id,workspace_id,id)
    );
    CREATE INDEX scheduled_follow_up_due_idx ON scheduled_follow_up_tasks(scheduled_for,tenant_id,id)
      WHERE status IN ('scheduled','queued');
    CREATE INDEX scheduled_follow_up_conversation_idx
      ON scheduled_follow_up_tasks(tenant_id,conversation_id,created_at DESC);
    -- Multiple attempts remain separate calls; repeated callbacks cannot duplicate a link.
    CREATE TABLE follow_up_call_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
      follow_up_task_id uuid NOT NULL, call_session_id uuid NOT NULL UNIQUE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id,workspace_id,follow_up_task_id)
        REFERENCES scheduled_follow_up_tasks(tenant_id,workspace_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,workspace_id,call_session_id)
        REFERENCES call_sessions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
      UNIQUE (follow_up_task_id,attempt_number)
    );
  `);
  for (const table of ['conversation_contacts', 'contact_conversations', 'conversation_call_links',
    'scheduled_follow_up_tasks', 'follow_up_call_attempts']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${table}_isolation ON ${table} FOR ALL TO zea_voice_runtime
        USING (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id())
        WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service() OR tenant_id=zea_current_tenant_id());
      GRANT SELECT,INSERT,UPDATE ON ${table} TO zea_voice_runtime;`);
  }
  for (const table of ['conversation_contacts', 'contact_conversations', 'scheduled_follow_up_tasks']) {
    pgm.sql(`CREATE TRIGGER ${table}_updated_at BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();`);
  }
}

export async function down(pgm) {
  pgm.sql(`DROP TABLE follow_up_call_attempts;
    DROP TABLE scheduled_follow_up_tasks;
    DROP TABLE conversation_call_links;
    DROP TABLE contact_conversations;
    DROP TABLE conversation_contacts;
    ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_tenant_workspace_identity;
    ALTER TABLE voice_agents DROP CONSTRAINT voice_agents_tenant_workspace_identity,
      DROP CONSTRAINT voice_agents_direction_prompt_check,
      DROP COLUMN inbound_prompt, DROP COLUMN outbound_prompt,
      DROP COLUMN inbound_welcome_message, DROP COLUMN outbound_welcome_message;`);
}
