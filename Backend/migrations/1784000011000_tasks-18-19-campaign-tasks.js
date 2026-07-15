export const shorthands=undefined;
export async function up(pgm){pgm.sql(`
CREATE TYPE campaign_task_source AS ENUM('batch','realtime');
CREATE TYPE campaign_task_status AS ENUM('queued','running','paused','completed','failed','busy','no_answer','rejected','unavailable','canceled','archived');
CREATE TYPE campaign_queue_reason AS ENUM('ready','scheduled','calling_hours','waiting_credits','campaign_paused','queue_unavailable');
CREATE TYPE campaign_attempt_status AS ENUM('scheduled','queued','ringing','connected','completed','failed','busy','no_answer','rejected','unavailable','canceled');
CREATE TABLE campaign_imports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,file_name varchar(240) NOT NULL,
 total_rows integer NOT NULL,accepted_rows integer NOT NULL,invalid_rows integer NOT NULL,duplicate_rows integer NOT NULL,
 validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
 CHECK(total_rows>=0 AND accepted_rows>=0 AND invalid_rows>=0 AND duplicate_rows>=0),CHECK(accepted_rows+invalid_rows+duplicate_rows=total_rows)
);
CREATE TABLE campaign_tasks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
 import_id uuid REFERENCES campaign_imports(id) ON DELETE SET NULL,source campaign_task_source NOT NULL,
 external_event_id varchar(200),agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE RESTRICT,
 phone_number_id uuid NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,lead_phone varchar(20) NOT NULL,
 lead_name varchar(240),remarks text,context jsonb NOT NULL DEFAULT '{}'::jsonb,status campaign_task_status NOT NULL DEFAULT 'queued',
 queue_reason campaign_queue_reason NOT NULL DEFAULT 'ready',max_retries integer NOT NULL,retry_count integer NOT NULL DEFAULT 0,
 scheduled_for timestamptz NOT NULL DEFAULT now(),final_outcome varchar(80),last_error text,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,archived_at timestamptz,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
 CHECK(lead_phone~'^\\+[1-9][0-9]{6,14}$'),CHECK(max_retries BETWEEN 0 AND 10),CHECK(retry_count BETWEEN 0 AND max_retries),
 CHECK((source='realtime' AND external_event_id IS NOT NULL) OR source='batch')
);
CREATE UNIQUE INDEX campaign_tasks_batch_phone_unique_idx ON campaign_tasks(campaign_id,lead_phone) WHERE source='batch' AND archived_at IS NULL;
CREATE UNIQUE INDEX campaign_tasks_realtime_event_unique_idx ON campaign_tasks(campaign_id,external_event_id) WHERE source='realtime';
CREATE INDEX campaign_tasks_campaign_status_idx ON campaign_tasks(tenant_id,campaign_id,status,scheduled_for);
CREATE INDEX campaign_tasks_phone_idx ON campaign_tasks(tenant_id,lead_phone,created_at DESC);
CREATE TABLE campaign_task_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES campaign_tasks(id) ON DELETE CASCADE,attempt_number integer NOT NULL,
 call_session_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,status campaign_attempt_status NOT NULL DEFAULT 'scheduled',
 outcome varchar(80),scheduled_for timestamptz NOT NULL,started_at timestamptz,ended_at timestamptz,error_message text,
 provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,attempt_number),CHECK(attempt_number>=1),CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at>=started_at)
);
CREATE INDEX campaign_task_attempts_task_idx ON campaign_task_attempts(task_id,attempt_number);
CREATE TRIGGER campaign_tasks_set_updated_at BEFORE UPDATE ON campaign_tasks FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
ALTER TABLE campaign_imports ENABLE ROW LEVEL SECURITY;ALTER TABLE campaign_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_tasks ENABLE ROW LEVEL SECURITY;ALTER TABLE campaign_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_task_attempts ENABLE ROW LEVEL SECURITY;ALTER TABLE campaign_task_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_imports_isolation ON campaign_imports FOR ALL TO zea_voice_runtime USING(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
CREATE POLICY campaign_tasks_isolation ON campaign_tasks FOR ALL TO zea_voice_runtime USING(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
CREATE POLICY campaign_attempts_isolation ON campaign_task_attempts FOR ALL TO zea_voice_runtime USING(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK(zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
GRANT USAGE ON TYPE campaign_task_source,campaign_task_status,campaign_queue_reason,campaign_attempt_status TO zea_voice_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON campaign_imports,campaign_tasks,campaign_task_attempts TO zea_voice_runtime;
`);}
export async function down(pgm){pgm.sql(`DROP TABLE IF EXISTS campaign_task_attempts;DROP TABLE IF EXISTS campaign_tasks;DROP TABLE IF EXISTS campaign_imports;DROP TYPE IF EXISTS campaign_attempt_status;DROP TYPE IF EXISTS campaign_queue_reason;DROP TYPE IF EXISTS campaign_task_status;DROP TYPE IF EXISTS campaign_task_source;`);}
