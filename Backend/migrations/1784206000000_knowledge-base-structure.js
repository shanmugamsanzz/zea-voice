export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE knowledge_base_status AS ENUM (
      'draft', 'processing', 'ready', 'partially_failed', 'published', 'deleting', 'deleted'
    );
    CREATE TYPE knowledge_document_type AS ENUM (
      'faq', 'catalog', 'workflow_rules', 'conversation_script', 'general_knowledge'
    );
    CREATE TYPE knowledge_document_status AS ENUM (
      'uploading', 'queued', 'processing', 'review_required', 'ready', 'failed', 'archived', 'deleting', 'deleted'
    );
    CREATE TYPE knowledge_version_status AS ENUM (
      'uploaded', 'queued', 'processing', 'review_required', 'ready', 'failed', 'archived', 'deleting', 'deleted'
    );
    CREATE TYPE knowledge_job_type AS ENUM (
      'extract', 'index', 'reprocess', 'publish', 'delete_document', 'delete_knowledge_base'
    );
    CREATE TYPE knowledge_job_status AS ENUM (
      'queued', 'running', 'completed', 'failed', 'cancelled'
    );
    CREATE TYPE knowledge_record_status AS ENUM (
      'draft', 'approved', 'rejected', 'archived'
    );

    ALTER TABLE voice_agents
      ADD CONSTRAINT voice_agents_tenant_id_id_unique UNIQUE (tenant_id, id);

    CREATE TABLE knowledge_bases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      workspace_id uuid NOT NULL,
      name varchar(180) NOT NULL,
      description text,
      status knowledge_base_status NOT NULL DEFAULT 'draft',
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      publication_revision integer NOT NULL DEFAULT 0,
      published_at timestamptz,
      published_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT knowledge_bases_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT knowledge_bases_workspace_tenant_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_bases_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT knowledge_bases_publication_revision_nonnegative CHECK (publication_revision >= 0),
      CONSTRAINT knowledge_bases_published_fields CHECK (
        (status = 'published' AND published_at IS NOT NULL)
        OR status <> 'published'
      ),
      CONSTRAINT knowledge_bases_tenant_id_id_unique UNIQUE (tenant_id, id)
    );

    CREATE UNIQUE INDEX knowledge_bases_tenant_name_unique_idx
      ON knowledge_bases (tenant_id, workspace_id, lower(name))
      WHERE deleted_at IS NULL AND status <> 'deleted';
    CREATE INDEX knowledge_bases_tenant_status_idx
      ON knowledge_bases (tenant_id, workspace_id, status, updated_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE knowledge_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_type knowledge_document_type NOT NULL,
      display_name varchar(240) NOT NULL,
      original_filename varchar(500) NOT NULL,
      mime_type varchar(120) NOT NULL DEFAULT 'application/pdf',
      size_bytes bigint NOT NULL,
      status knowledge_document_status NOT NULL DEFAULT 'uploading',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT knowledge_documents_kb_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id)
        REFERENCES knowledge_bases(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_documents_display_name_not_blank CHECK (btrim(display_name) <> ''),
      CONSTRAINT knowledge_documents_filename_not_blank CHECK (btrim(original_filename) <> ''),
      CONSTRAINT knowledge_documents_pdf_only CHECK (lower(mime_type) = 'application/pdf'),
      CONSTRAINT knowledge_documents_size_positive CHECK (size_bytes > 0),
      CONSTRAINT knowledge_documents_tenant_kb_id_unique
        UNIQUE (tenant_id, knowledge_base_id, id)
    );

    CREATE INDEX knowledge_documents_kb_type_status_idx
      ON knowledge_documents (tenant_id, knowledge_base_id, document_type, status, created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE knowledge_document_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      version_number integer NOT NULL,
      status knowledge_version_status NOT NULL DEFAULT 'uploaded',
      is_current boolean NOT NULL DEFAULT false,
      b2_bucket varchar(255) NOT NULL,
      b2_object_key text NOT NULL,
      content_sha256 char(64) NOT NULL,
      size_bytes bigint NOT NULL,
      page_count integer,
      extracted_text_object_key text,
      extraction_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      embedding_model varchar(240),
      embedding_dimensions integer,
      chunk_size_tokens integer,
      chunk_overlap_tokens integer,
      chunk_count integer NOT NULL DEFAULT 0,
      error_code varchar(120),
      error_message text,
      processed_at timestamptz,
      activated_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT knowledge_versions_document_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id)
        REFERENCES knowledge_documents(tenant_id, knowledge_base_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_versions_number_positive CHECK (version_number >= 1),
      CONSTRAINT knowledge_versions_b2_bucket_not_blank CHECK (btrim(b2_bucket) <> ''),
      CONSTRAINT knowledge_versions_b2_key_not_blank CHECK (btrim(b2_object_key) <> ''),
      CONSTRAINT knowledge_versions_sha256_format CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      CONSTRAINT knowledge_versions_size_positive CHECK (size_bytes > 0),
      CONSTRAINT knowledge_versions_page_count_positive CHECK (page_count IS NULL OR page_count >= 1),
      CONSTRAINT knowledge_versions_embedding_pair CHECK (
        (embedding_model IS NULL AND embedding_dimensions IS NULL)
        OR (embedding_model IS NOT NULL AND embedding_dimensions IS NOT NULL AND embedding_dimensions > 0)
      ),
      CONSTRAINT knowledge_versions_chunk_values CHECK (
        chunk_count >= 0
        AND (chunk_size_tokens IS NULL OR chunk_size_tokens >= 1)
        AND (chunk_overlap_tokens IS NULL OR chunk_overlap_tokens >= 0)
        AND (
          chunk_size_tokens IS NULL OR chunk_overlap_tokens IS NULL
          OR chunk_overlap_tokens < chunk_size_tokens
        )
      ),
      CONSTRAINT knowledge_versions_document_version_unique
        UNIQUE (tenant_id, document_id, version_number),
      CONSTRAINT knowledge_versions_tenant_chain_id_unique
        UNIQUE (tenant_id, knowledge_base_id, document_id, id),
      CONSTRAINT knowledge_versions_b2_object_unique UNIQUE (b2_bucket, b2_object_key)
    );

    CREATE UNIQUE INDEX knowledge_versions_one_current_idx
      ON knowledge_document_versions (tenant_id, document_id)
      WHERE is_current = true AND deleted_at IS NULL AND status <> 'deleted';
    CREATE INDEX knowledge_versions_document_status_idx
      ON knowledge_document_versions (tenant_id, knowledge_base_id, document_id, status, version_number DESC);

    CREATE TABLE knowledge_processing_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid,
      document_version_id uuid,
      job_type knowledge_job_type NOT NULL,
      status knowledge_job_status NOT NULL DEFAULT 'queued',
      queue_name varchar(120) NOT NULL DEFAULT 'knowledge-processing',
      bullmq_job_id varchar(240),
      progress smallint NOT NULL DEFAULT 0,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      error_code varchar(120),
      error_message text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      scheduled_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT knowledge_jobs_kb_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id)
        REFERENCES knowledge_bases(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_jobs_document_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id)
        REFERENCES knowledge_documents(tenant_id, knowledge_base_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_jobs_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_jobs_document_chain CHECK (
        document_version_id IS NULL OR document_id IS NOT NULL
      ),
      CONSTRAINT knowledge_jobs_queue_not_blank CHECK (btrim(queue_name) <> ''),
      CONSTRAINT knowledge_jobs_progress_range CHECK (progress BETWEEN 0 AND 100),
      CONSTRAINT knowledge_jobs_attempt_values CHECK (
        attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts
      )
    );

    CREATE UNIQUE INDEX knowledge_jobs_queue_id_unique_idx
      ON knowledge_processing_jobs (tenant_id, queue_name, bullmq_job_id)
      WHERE bullmq_job_id IS NOT NULL;
    CREATE INDEX knowledge_jobs_tenant_status_idx
      ON knowledge_processing_jobs (tenant_id, status, scheduled_at, created_at)
      WHERE status IN ('queued', 'running', 'failed');
    CREATE INDEX knowledge_jobs_kb_document_idx
      ON knowledge_processing_jobs (tenant_id, knowledge_base_id, document_id, created_at DESC);

    CREATE TABLE faq_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      question text NOT NULL,
      answer text NOT NULL,
      language varchar(20) NOT NULL DEFAULT 'en',
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      qdrant_point_id uuid,
      source_page_start integer,
      source_page_end integer,
      extraction_confidence numeric(5,4),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT faq_entries_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT faq_entries_question_not_blank CHECK (btrim(question) <> ''),
      CONSTRAINT faq_entries_answer_not_blank CHECK (btrim(answer) <> ''),
      CONSTRAINT faq_entries_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT faq_entries_confidence_range CHECK (
        extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT faq_entries_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      )
    );

    CREATE INDEX faq_entries_lookup_idx
      ON faq_entries (tenant_id, knowledge_base_id, language, usage_direction, status);
    CREATE INDEX faq_entries_document_idx
      ON faq_entries (tenant_id, document_id, document_version_id);
    CREATE UNIQUE INDEX faq_entries_qdrant_point_unique_idx
      ON faq_entries (qdrant_point_id) WHERE qdrant_point_id IS NOT NULL;

    CREATE TABLE structured_catalogs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      catalog_type varchar(80) NOT NULL,
      name varchar(200) NOT NULL,
      description text,
      default_currency char(3),
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      source_text text,
      source_page_start integer,
      source_page_end integer,
      extraction_confidence numeric(5,4),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT structured_catalogs_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT structured_catalogs_type_not_blank CHECK (btrim(catalog_type) <> ''),
      CONSTRAINT structured_catalogs_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT structured_catalogs_currency_uppercase CHECK (
        default_currency IS NULL OR default_currency = upper(default_currency)
      ),
      CONSTRAINT structured_catalogs_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT structured_catalogs_confidence_range CHECK (
        extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT structured_catalogs_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      ),
      CONSTRAINT structured_catalogs_tenant_kb_id_unique
        UNIQUE (tenant_id, knowledge_base_id, id)
    );

    CREATE INDEX structured_catalogs_lookup_idx
      ON structured_catalogs (tenant_id, knowledge_base_id, catalog_type, status);
    CREATE INDEX structured_catalogs_document_idx
      ON structured_catalogs (tenant_id, document_id, document_version_id);

    CREATE TABLE structured_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      catalog_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      item_key varchar(160),
      name varchar(240) NOT NULL,
      description text,
      price numeric(14,2),
      currency char(3),
      display_order integer NOT NULL DEFAULT 0,
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      source_text text,
      source_page_start integer,
      source_page_end integer,
      extraction_confidence numeric(5,4),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT structured_items_catalog_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, catalog_id)
        REFERENCES structured_catalogs(tenant_id, knowledge_base_id, id) ON DELETE CASCADE,
      CONSTRAINT structured_items_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT structured_items_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT structured_items_price_nonnegative CHECK (price IS NULL OR price >= 0),
      CONSTRAINT structured_items_currency_uppercase CHECK (currency IS NULL OR currency = upper(currency)),
      CONSTRAINT structured_items_display_order_nonnegative CHECK (display_order >= 0),
      CONSTRAINT structured_items_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT structured_items_confidence_range CHECK (
        extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT structured_items_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      ),
      CONSTRAINT structured_items_tenant_kb_id_unique
        UNIQUE (tenant_id, knowledge_base_id, id)
    );

    CREATE UNIQUE INDEX structured_items_catalog_key_unique_idx
      ON structured_items (tenant_id, catalog_id, lower(item_key))
      WHERE item_key IS NOT NULL AND status <> 'archived';
    CREATE INDEX structured_items_lookup_idx
      ON structured_items (tenant_id, knowledge_base_id, catalog_id, status, display_order);
    CREATE INDEX structured_items_document_idx
      ON structured_items (tenant_id, document_id, document_version_id);

    CREATE TABLE structured_item_attributes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      item_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      attribute_key varchar(160) NOT NULL,
      display_name varchar(200) NOT NULL,
      value jsonb NOT NULL,
      display_order integer NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT structured_attributes_item_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, item_id)
        REFERENCES structured_items(tenant_id, knowledge_base_id, id) ON DELETE CASCADE,
      CONSTRAINT structured_attributes_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT structured_attributes_key_not_blank CHECK (btrim(attribute_key) <> ''),
      CONSTRAINT structured_attributes_name_not_blank CHECK (btrim(display_name) <> ''),
      CONSTRAINT structured_attributes_display_order_nonnegative CHECK (display_order >= 0),
      CONSTRAINT structured_attributes_item_key_unique
        UNIQUE (tenant_id, item_id, attribute_key)
    );

    CREATE INDEX structured_attributes_document_idx
      ON structured_item_attributes (tenant_id, document_id, document_version_id);

    CREATE TABLE workflow_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      name varchar(200) NOT NULL,
      intent varchar(160) NOT NULL,
      priority integer NOT NULL DEFAULT 100,
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
      action_type varchar(120) NOT NULL,
      action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
      response_template text,
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      source_text text,
      source_page_start integer,
      source_page_end integer,
      extraction_confidence numeric(5,4),
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_rules_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT workflow_rules_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT workflow_rules_intent_not_blank CHECK (btrim(intent) <> ''),
      CONSTRAINT workflow_rules_action_not_blank CHECK (btrim(action_type) <> ''),
      CONSTRAINT workflow_rules_priority_nonnegative CHECK (priority >= 0),
      CONSTRAINT workflow_rules_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT workflow_rules_confidence_range CHECK (
        extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT workflow_rules_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      )
    );

    CREATE INDEX workflow_rules_intent_idx
      ON workflow_rules (tenant_id, knowledge_base_id, lower(intent), usage_direction, priority)
      WHERE status = 'approved';
    CREATE INDEX workflow_rules_document_idx
      ON workflow_rules (tenant_id, document_id, document_version_id);

    CREATE TABLE conversation_flows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      flow_key varchar(160) NOT NULL,
      node_key varchar(160) NOT NULL,
      node_type varchar(80) NOT NULL DEFAULT 'message',
      language varchar(20) NOT NULL DEFAULT 'en',
      sequence_order integer NOT NULL DEFAULT 0,
      is_entry boolean NOT NULL DEFAULT false,
      content text NOT NULL,
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      source_text text,
      source_page_start integer,
      source_page_end integer,
      extraction_confidence numeric(5,4),
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT conversation_flows_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT conversation_flows_flow_key_not_blank CHECK (btrim(flow_key) <> ''),
      CONSTRAINT conversation_flows_node_key_not_blank CHECK (btrim(node_key) <> ''),
      CONSTRAINT conversation_flows_node_type_not_blank CHECK (btrim(node_type) <> ''),
      CONSTRAINT conversation_flows_content_not_blank CHECK (btrim(content) <> ''),
      CONSTRAINT conversation_flows_sequence_nonnegative CHECK (sequence_order >= 0),
      CONSTRAINT conversation_flows_variables_array CHECK (jsonb_typeof(variables) = 'array'),
      CONSTRAINT conversation_flows_transitions_array CHECK (jsonb_typeof(transitions) = 'array'),
      CONSTRAINT conversation_flows_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT conversation_flows_confidence_range CHECK (
        extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT conversation_flows_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      )
    );

    CREATE UNIQUE INDEX conversation_flows_node_unique_idx
      ON conversation_flows (tenant_id, knowledge_base_id, flow_key, language, node_key)
      WHERE status <> 'archived';
    CREATE UNIQUE INDEX conversation_flows_one_entry_idx
      ON conversation_flows (tenant_id, knowledge_base_id, flow_key, language)
      WHERE is_entry = true AND status = 'approved';
    CREATE INDEX conversation_flows_document_idx
      ON conversation_flows (tenant_id, document_id, document_version_id);

    CREATE TABLE knowledge_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_version_id uuid NOT NULL,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      token_count integer NOT NULL,
      source_heading text,
      source_page_start integer,
      source_page_end integer,
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      status knowledge_record_status NOT NULL DEFAULT 'draft',
      qdrant_point_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT knowledge_chunks_version_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id, document_id, document_version_id)
        REFERENCES knowledge_document_versions(tenant_id, knowledge_base_id, document_id, id) ON DELETE CASCADE,
      CONSTRAINT knowledge_chunks_index_nonnegative CHECK (chunk_index >= 0),
      CONSTRAINT knowledge_chunks_content_not_blank CHECK (btrim(content) <> ''),
      CONSTRAINT knowledge_chunks_token_count_positive CHECK (token_count >= 1),
      CONSTRAINT knowledge_chunks_page_range CHECK (
        (source_page_start IS NULL AND source_page_end IS NULL)
        OR (source_page_start >= 1 AND source_page_end >= source_page_start)
      ),
      CONSTRAINT knowledge_chunks_approval_fields CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
      ),
      CONSTRAINT knowledge_chunks_version_index_unique
        UNIQUE (tenant_id, document_version_id, chunk_index)
    );

    CREATE INDEX knowledge_chunks_retrieval_idx
      ON knowledge_chunks (tenant_id, knowledge_base_id, usage_direction, status);
    CREATE INDEX knowledge_chunks_document_idx
      ON knowledge_chunks (tenant_id, document_id, document_version_id);
    CREATE UNIQUE INDEX knowledge_chunks_qdrant_point_unique_idx
      ON knowledge_chunks (qdrant_point_id) WHERE qdrant_point_id IS NOT NULL;

    CREATE TABLE agent_knowledge_bases (
      tenant_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      knowledge_base_id uuid NOT NULL,
      usage_direction agent_usage_direction NOT NULL DEFAULT 'both',
      priority integer NOT NULL DEFAULT 100,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_knowledge_bases_pk PRIMARY KEY (tenant_id, agent_id, knowledge_base_id),
      CONSTRAINT agent_knowledge_bases_agent_tenant_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES voice_agents(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT agent_knowledge_bases_kb_tenant_fk
        FOREIGN KEY (tenant_id, knowledge_base_id)
        REFERENCES knowledge_bases(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT agent_knowledge_bases_priority_nonnegative CHECK (priority >= 0)
    );

    CREATE INDEX agent_knowledge_bases_kb_idx
      ON agent_knowledge_bases (tenant_id, knowledge_base_id, agent_id);

    CREATE TRIGGER knowledge_bases_set_updated_at BEFORE UPDATE ON knowledge_bases
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER knowledge_documents_set_updated_at BEFORE UPDATE ON knowledge_documents
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER knowledge_versions_set_updated_at BEFORE UPDATE ON knowledge_document_versions
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER knowledge_jobs_set_updated_at BEFORE UPDATE ON knowledge_processing_jobs
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER faq_entries_set_updated_at BEFORE UPDATE ON faq_entries
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER structured_catalogs_set_updated_at BEFORE UPDATE ON structured_catalogs
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER structured_items_set_updated_at BEFORE UPDATE ON structured_items
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER structured_attributes_set_updated_at BEFORE UPDATE ON structured_item_attributes
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER workflow_rules_set_updated_at BEFORE UPDATE ON workflow_rules
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER conversation_flows_set_updated_at BEFORE UPDATE ON conversation_flows
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER knowledge_chunks_set_updated_at BEFORE UPDATE ON knowledge_chunks
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_bases FORCE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_document_versions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_document_versions FORCE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_processing_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_processing_jobs FORCE ROW LEVEL SECURITY;
    ALTER TABLE faq_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE faq_entries FORCE ROW LEVEL SECURITY;
    ALTER TABLE structured_catalogs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE structured_catalogs FORCE ROW LEVEL SECURITY;
    ALTER TABLE structured_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE structured_items FORCE ROW LEVEL SECURITY;
    ALTER TABLE structured_item_attributes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE structured_item_attributes FORCE ROW LEVEL SECURITY;
    ALTER TABLE workflow_rules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workflow_rules FORCE ROW LEVEL SECURITY;
    ALTER TABLE conversation_flows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversation_flows FORCE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
    ALTER TABLE agent_knowledge_bases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_knowledge_bases FORCE ROW LEVEL SECURITY;

    CREATE POLICY knowledge_bases_isolation_policy ON knowledge_bases FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY knowledge_documents_isolation_policy ON knowledge_documents FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY knowledge_versions_isolation_policy ON knowledge_document_versions FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY knowledge_jobs_isolation_policy ON knowledge_processing_jobs FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY faq_entries_isolation_policy ON faq_entries FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY structured_catalogs_isolation_policy ON structured_catalogs FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY structured_items_isolation_policy ON structured_items FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY structured_attributes_isolation_policy ON structured_item_attributes FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY workflow_rules_isolation_policy ON workflow_rules FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY conversation_flows_isolation_policy ON conversation_flows FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY knowledge_chunks_isolation_policy ON knowledge_chunks FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY agent_knowledge_bases_isolation_policy ON agent_knowledge_bases FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT USAGE ON TYPE knowledge_base_status, knowledge_document_type,
      knowledge_document_status, knowledge_version_status, knowledge_job_type,
      knowledge_job_status, knowledge_record_status TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      knowledge_bases, knowledge_documents, knowledge_document_versions,
      knowledge_processing_jobs, faq_entries, structured_catalogs,
      structured_items, structured_item_attributes, workflow_rules,
      conversation_flows, knowledge_chunks, agent_knowledge_bases
      TO zea_voice_runtime;

    COMMENT ON TABLE knowledge_bases IS 'Tenant-isolated group of approved knowledge and operational records assignable to voice agents.';
    COMMENT ON TABLE knowledge_documents IS 'Developer-categorized PDF metadata; automatic document type detection is intentionally excluded from Phase 1.';
    COMMENT ON TABLE knowledge_document_versions IS 'Immutable B2-backed versions and the exact extraction/embedding settings used for each PDF.';
    COMMENT ON TABLE knowledge_processing_jobs IS 'Durable PostgreSQL state for BullMQ knowledge ingestion, publication, reprocessing, and deletion jobs.';
    COMMENT ON TABLE faq_entries IS 'Approved FAQ answers in PostgreSQL with optional Qdrant point IDs used only for semantic question matching.';
    COMMENT ON TABLE structured_catalogs IS 'Typed company catalogs such as packages, products, services, or courses extracted from approved PDFs.';
    COMMENT ON TABLE structured_items IS 'Structured catalog entries used for deterministic low-latency answers.';
    COMMENT ON TABLE structured_item_attributes IS 'Flexible typed values such as package tests and features stored as JSON values.';
    COMMENT ON TABLE workflow_rules IS 'Approved business actions and transfer rules that must not be treated as general RAG content.';
    COMMENT ON TABLE conversation_flows IS 'Approved deterministic voice scripts and flow nodes.';
    COMMENT ON TABLE knowledge_chunks IS 'Reviewable General Knowledge chunks before and after tenant-isolated Qdrant indexing.';
    COMMENT ON TABLE agent_knowledge_bases IS 'Tenant-safe many-to-many assignment between published knowledge bases and voice agents.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS agent_knowledge_bases;
    DROP TABLE IF EXISTS knowledge_chunks;
    DROP TABLE IF EXISTS conversation_flows;
    DROP TABLE IF EXISTS workflow_rules;
    DROP TABLE IF EXISTS structured_item_attributes;
    DROP TABLE IF EXISTS structured_items;
    DROP TABLE IF EXISTS structured_catalogs;
    DROP TABLE IF EXISTS faq_entries;
    DROP TABLE IF EXISTS knowledge_processing_jobs;
    DROP TABLE IF EXISTS knowledge_document_versions;
    DROP TABLE IF EXISTS knowledge_documents;
    DROP TABLE IF EXISTS knowledge_bases;

    ALTER TABLE voice_agents DROP CONSTRAINT IF EXISTS voice_agents_tenant_id_id_unique;

    DROP TYPE IF EXISTS knowledge_record_status;
    DROP TYPE IF EXISTS knowledge_job_status;
    DROP TYPE IF EXISTS knowledge_job_type;
    DROP TYPE IF EXISTS knowledge_version_status;
    DROP TYPE IF EXISTS knowledge_document_status;
    DROP TYPE IF EXISTS knowledge_document_type;
    DROP TYPE IF EXISTS knowledge_base_status;
  `);
}
