export const shorthands = undefined;
export async function up(pgm) { pgm.sql(`
  CREATE TYPE agent_tool_type AS ENUM ('webhook_api','calcom','hubspot','salesforce');
  CREATE TYPE agent_resource_status AS ENUM ('active','inactive');
  CREATE TYPE knowledge_ingestion_status AS ENUM ('pending_upload','uploaded','indexing','ready','failed');
  CREATE TYPE campaign_type AS ENUM ('batch','realtime');
  CREATE TYPE campaign_status AS ENUM ('draft','scheduled','running','paused','completed','failed','archived');
  CREATE TYPE campaign_priority AS ENUM ('low','medium','high');

  CREATE TABLE agent_tools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL, agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
    name varchar(160) NOT NULL, type agent_tool_type NOT NULL, description text,
    status agent_resource_status NOT NULL DEFAULT 'active', configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    secret_configuration_encrypted text, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
    CHECK (btrim(name)<>''), UNIQUE (tenant_id,agent_id,name)
  );
  CREATE TABLE agent_knowledge_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL, agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
    display_name varchar(240) NOT NULL, file_name varchar(240) NOT NULL, mime_type varchar(120) NOT NULL,
    size_bytes bigint NOT NULL, storage_backend varchar(20) NOT NULL DEFAULT 'b2', object_key varchar(700),
    checksum_sha256 char(64), ingestion_status knowledge_ingestion_status NOT NULL DEFAULT 'pending_upload',
    ingestion_error text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
    CHECK (btrim(display_name)<>''), CHECK (btrim(file_name)<>''), CHECK (size_bytes BETWEEN 1 AND 52428800),
    CHECK (storage_backend='b2')
  );
  CREATE UNIQUE INDEX agent_knowledge_object_unique_idx ON agent_knowledge_documents(tenant_id,object_key)
    WHERE object_key IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL, name varchar(180) NOT NULL, type campaign_type NOT NULL,
    status campaign_status NOT NULL DEFAULT 'draft', agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE RESTRICT,
    phone_number_id uuid NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT, timezone varchar(64) NOT NULL,
    concurrency_limit integer NOT NULL DEFAULT 20, priority campaign_priority NOT NULL DEFAULT 'medium',
    retries integer NOT NULL DEFAULT 0, retry_intervals_ms bigint[] NOT NULL DEFAULT '{}'::bigint[],
    retry_outcomes text[] NOT NULL DEFAULT '{}'::text[], calling_start_time time NOT NULL,
    calling_end_time time NOT NULL, start_after timestamptz, end_after timestamptz,
    context_schema jsonb NOT NULL DEFAULT '{}'::jsonb, total_tasks integer NOT NULL DEFAULT 0,
    attempted_tasks integer NOT NULL DEFAULT 0, connected_tasks integer NOT NULL DEFAULT 0,
    completed_tasks integer NOT NULL DEFAULT 0, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
    CHECK (btrim(name)<>''), CHECK (concurrency_limit BETWEEN 1 AND 20), CHECK (retries BETWEEN 0 AND 10),
    CHECK (cardinality(retry_intervals_ms)=retries), CHECK (calling_start_time<>calling_end_time),
    CHECK (end_after IS NULL OR start_after IS NULL OR end_after>start_after),
    CHECK (total_tasks>=0 AND attempted_tasks>=0 AND connected_tasks>=0 AND completed_tasks>=0)
  );
  CREATE UNIQUE INDEX campaigns_tenant_name_unique_idx ON campaigns(tenant_id,lower(name)) WHERE deleted_at IS NULL;
  CREATE INDEX campaigns_tenant_type_status_idx ON campaigns(tenant_id,type,status,created_at DESC) WHERE deleted_at IS NULL;

  CREATE TRIGGER agent_tools_set_updated_at BEFORE UPDATE ON agent_tools FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
  CREATE TRIGGER agent_knowledge_documents_set_updated_at BEFORE UPDATE ON agent_knowledge_documents FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
  CREATE TRIGGER campaigns_set_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
  ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_tools FORCE ROW LEVEL SECURITY;
  ALTER TABLE agent_knowledge_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_knowledge_documents FORCE ROW LEVEL SECURITY;
  ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY; ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
  CREATE POLICY agent_tools_isolation ON agent_tools FOR ALL TO zea_voice_runtime USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
  CREATE POLICY agent_knowledge_isolation ON agent_knowledge_documents FOR ALL TO zea_voice_runtime USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
  CREATE POLICY campaigns_isolation ON campaigns FOR ALL TO zea_voice_runtime USING (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id()) WITH CHECK (zea_is_platform_admin() OR tenant_id=zea_current_tenant_id());
  GRANT USAGE ON TYPE agent_tool_type,agent_resource_status,knowledge_ingestion_status,campaign_type,campaign_status,campaign_priority TO zea_voice_runtime;
  GRANT SELECT,INSERT,UPDATE,DELETE ON agent_tools,agent_knowledge_documents,campaigns TO zea_voice_runtime;
`); }
export async function down(pgm) { pgm.sql(`DROP TABLE IF EXISTS campaigns;DROP TABLE IF EXISTS agent_knowledge_documents;DROP TABLE IF EXISTS agent_tools;DROP TYPE IF EXISTS campaign_priority;DROP TYPE IF EXISTS campaign_status;DROP TYPE IF EXISTS campaign_type;DROP TYPE IF EXISTS knowledge_ingestion_status;DROP TYPE IF EXISTS agent_resource_status;DROP TYPE IF EXISTS agent_tool_type;`); }
