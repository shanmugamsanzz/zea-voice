import { env } from '../config/env.js';
import { embedPassages } from '../rag/embedding.client.js';
import {
  countTenantPointsByKnowledgeBaseRevision,
  deleteTenantPointsByKnowledgeBase,
  ensureTenantCollection,
  upsertTenantPoints,
} from '../rag/qdrant.client.js';
import { verifyB2Object } from '../rag/b2.client.js';
import { tenantVectorPayload } from '../rag/tenant-isolation.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { cacheCompactKnowledgeMap, deleteRevisionKnowledgeArtifacts } from './knowledge-map.service.js';
import { invalidateTenantRuntimeKnowledgeCache } from './knowledge-runtime.service.js';

const defaultDependencies = {
  contextRunner: withPlatformAdminContext,
  embed: embedPassages,
  ensureCollection: ensureTenantCollection,
  deleteKnowledgeBasePoints: deleteTenantPointsByKnowledgeBase,
  upsertPoints: upsertTenantPoints,
  countRevisionPoints: countTenantPointsByKnowledgeBaseRevision,
  verifyStorageObject: verifyB2Object,
  cacheKnowledgeMap: cacheCompactKnowledgeMap,
  deleteKnowledgeArtifacts: deleteRevisionKnowledgeArtifacts,
  invalidateCache: invalidateTenantRuntimeKnowledgeCache,
};

function embeddingText(value) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= env.RAG_EMBEDDING_MAX_CHARS) return normalized;
  const truncated = normalized.slice(0, env.RAG_EMBEDDING_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > env.RAG_EMBEDDING_MAX_CHARS * 0.8 ? truncated.slice(0, lastSpace) : truncated).trim();
}

const documentTypeByRecordType = Object.freeze({
  faq: 'faq',
  knowledge_chunk: 'general_knowledge',
  catalog_item: 'catalog',
  workflow_rule: 'workflow_rules',
  conversation_node: 'conversation_script',
});

export function buildSemanticPoint(job, record, vector) {
  const payload = tenantVectorPayload({
    tenantId: job.tenant_id,
    knowledgeBaseId: job.knowledge_base_id,
    documentId: record.document_id,
    documentVersionId: record.document_version_id,
    recordId: record.record_id,
    recordType: record.record_type,
    agentUsage: record.usage_direction.toUpperCase(),
    category: record.record_type,
    publicationRevision: job.targetRevision,
    content: record.content,
    language: record.language,
    assignedAgentIds: job.assigned_agent_ids ?? [],
    documentType: documentTypeByRecordType[record.record_type],
    ...(record.source_page_start ? { pageNumber: record.source_page_start } : {}),
  });
  return {
    id: record.record_id,
    vector,
    payload: {
      ...payload,
      ...(record.question ? { question: record.question, answer: record.answer } : {}),
      ...(record.entity_name ? { entity_name: record.entity_name } : {}),
      ...(record.entity_category ? { entity_category: record.entity_category } : {}),
      ...(Array.isArray(record.entity_category_aliases) && record.entity_category_aliases.length
        ? { entity_category_aliases: record.entity_category_aliases } : {}),
      ...(Array.isArray(record.entity_aliases) && record.entity_aliases.length
        ? { entity_aliases: record.entity_aliases } : {}),
      ...(record.entity_metadata && typeof record.entity_metadata === 'object'
        && !Array.isArray(record.entity_metadata) && Object.keys(record.entity_metadata).length
        ? { entity_metadata: record.entity_metadata } : {}),
    },
  };
}

async function claimIndexJob(jobId, contextRunner) {
  return contextRunner(null, async (client) => {
    const locator = await client.query(
      `SELECT tenant_id, knowledge_base_id FROM knowledge_processing_jobs
        WHERE id=$1 AND job_type='index'`,
      [jobId],
    );
    if (!locator.rowCount) throw new AppError(404, 'Semantic index job was not found', 'KNOWLEDGE_INDEX_JOB_NOT_FOUND');
    await client.query(
      `SELECT id FROM knowledge_bases
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [locator.rows[0].tenant_id, locator.rows[0].knowledge_base_id],
    );
    const result = await client.query(
      `SELECT j.*, kb.status AS knowledge_base_status,
          kb.publication_revision, kb.pending_publication_revision,
          kb.usage_direction AS knowledge_base_usage,
          COALESCE((SELECT jsonb_agg(akb.agent_id ORDER BY akb.priority, akb.agent_id)
            FROM agent_knowledge_bases akb
           WHERE akb.tenant_id=kb.tenant_id AND akb.knowledge_base_id=kb.id), '[]'::jsonb) AS assigned_agent_ids
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.tenant_id = j.tenant_id AND kb.id = j.knowledge_base_id
        WHERE j.id = $1 AND j.job_type = 'index'
        FOR UPDATE OF j`,
      [jobId],
    );
    if (!result.rowCount) throw new AppError(404, 'Semantic index job was not found', 'KNOWLEDGE_INDEX_JOB_NOT_FOUND');
    const job = result.rows[0];
    if (job.status === 'completed') return { ...job, alreadyCompleted: true };
    const targetRevision = Number(job.metadata?.publicationRevision);
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw new AppError(409, 'Semantic index job has no valid publication revision', 'KNOWLEDGE_INDEX_REVISION_INVALID');
    }
    if (job.pending_publication_revision !== targetRevision
      || job.knowledge_base_status !== 'processing') {
      await client.query(
        `UPDATE knowledge_processing_jobs
            SET status = 'cancelled', completed_at = now(), error_code = 'KNOWLEDGE_INDEX_STALE',
                error_message = 'Knowledge Base changed before semantic indexing began'
          WHERE id = $1`,
        [jobId],
      );
      return { ...job, targetRevision, stale: true };
    }
    if (job.attempt_count >= job.max_attempts) {
      throw new AppError(409, 'Semantic index job exhausted its retries', 'KNOWLEDGE_INDEX_RETRIES_EXHAUSTED');
    }
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'running', progress = 5, attempt_count = attempt_count + 1,
              started_at = now(), completed_at = NULL, error_code = NULL, error_message = NULL
        WHERE id = $1`,
      [jobId],
    );
    return { ...job, targetRevision, attempt_count: job.attempt_count + 1, alreadyCompleted: false };
  });
}

async function loadSemanticRecords(job, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT f.id AS record_id, 'faq'::text AS record_type,
          f.document_id, f.document_version_id, f.usage_direction,
          COALESCE(NULLIF(f.language, ''), NULLIF(d.metadata->>'language', ''), 'und') AS language,
          f.source_page_start, f.question, f.answer,
          ('Question: ' || f.question || E'\nAnswer: ' || f.answer) AS content,
          NULL::text AS entity_name, NULL::text AS entity_category,
          '[]'::jsonb AS entity_aliases, '[]'::jsonb AS entity_category_aliases,
          '{}'::jsonb AS entity_metadata
         FROM faq_entries f
         JOIN knowledge_documents d
           ON d.tenant_id = f.tenant_id AND d.id = f.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = f.tenant_id AND v.id = f.document_version_id
        WHERE f.tenant_id = $1 AND f.knowledge_base_id = $2
          AND f.status = 'approved' AND d.status = 'ready'
          AND v.is_current = true AND v.status = 'ready' AND v.deleted_at IS NULL
       UNION ALL
       SELECT c.id, 'knowledge_chunk'::text,
          c.document_id, c.document_version_id, c.usage_direction,
          COALESCE(NULLIF(d.metadata->>'language', ''), 'und'),
          c.source_page_start, NULL::text, NULL::text, c.content,
          NULL::text, NULL::text, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
         FROM knowledge_chunks c
         JOIN knowledge_documents d
           ON d.tenant_id = c.tenant_id AND d.id = c.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = c.tenant_id AND v.id = c.document_version_id
        WHERE c.tenant_id = $1 AND c.knowledge_base_id = $2
          AND c.status = 'approved' AND d.status = 'ready'
          AND v.is_current = true AND v.status = 'ready' AND v.deleted_at IS NULL
       UNION ALL
       SELECT si.id, 'catalog_item'::text,
          si.document_id, si.document_version_id, kb.usage_direction,
          COALESCE(NULLIF(d.metadata->>'language', ''), 'und'),
          si.source_page_start, NULL::text, NULL::text,
          concat_ws(E'\n',
            'Catalog item: ' || si.name,
            CASE WHEN si.item_key IS NOT NULL THEN 'Code: ' || si.item_key END,
            'Category: ' || COALESCE(si.category, sc.name),
            CASE WHEN jsonb_array_length(si.category_aliases) > 0
              THEN 'Category aliases: ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(si.category_aliases)), ', ') END,
            CASE WHEN jsonb_array_length(si.aliases) > 0
              THEN 'Aliases: ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(si.aliases)), ', ') END,
            CASE WHEN si.category_description IS NOT NULL
              THEN 'Category description: ' || si.category_description END,
            CASE WHEN si.description IS NOT NULL THEN 'Description: ' || si.description END,
            CASE WHEN si.price IS NOT NULL
              THEN 'Price: ' || si.price::text || ' ' || COALESCE(si.currency, '') END,
            CASE WHEN si.relationships <> '{}'::jsonb THEN 'Relationships: ' || si.relationships::text END,
            CASE WHEN si.selection_rules <> '{}'::jsonb THEN 'Selection rules: ' || si.selection_rules::text END
          ),
          si.name, COALESCE(si.category, sc.name), si.aliases, si.category_aliases,
          jsonb_build_object(
            'itemKey', si.item_key,
            'categoryKey', si.category_key,
            'parentCategoryKey', si.parent_category_key,
            'categoryDescription', si.category_description,
            'categorySelectionRules', si.category_selection_rules,
            'relationships', si.relationships,
            'selectionRules', si.selection_rules
          )
         FROM structured_items si
         JOIN structured_catalogs sc
           ON sc.tenant_id=si.tenant_id AND sc.knowledge_base_id=si.knowledge_base_id
          AND sc.id=si.catalog_id AND sc.status='approved'
         JOIN knowledge_bases kb
           ON kb.tenant_id=si.tenant_id AND kb.id=si.knowledge_base_id
         JOIN knowledge_documents d
           ON d.tenant_id=si.tenant_id AND d.id=si.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id=si.tenant_id AND v.id=si.document_version_id
        WHERE si.tenant_id=$1 AND si.knowledge_base_id=$2
          AND si.status='approved' AND d.status='ready'
          AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       UNION ALL
       SELECT w.id, 'workflow_rule'::text,
          w.document_id, w.document_version_id, w.usage_direction,
          COALESCE(NULLIF(d.metadata->>'language', ''), 'und'),
          w.source_page_start, NULL::text, NULL::text,
          concat_ws(E'\n',
            'Workflow: ' || w.name,
            'Intent: ' || w.intent,
            CASE WHEN jsonb_typeof(COALESCE(w.conditions->'examples', w.conditions->'triggerPhrases')) = 'array'
              THEN 'Caller examples: ' || array_to_string(
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(w.conditions->'examples', w.conditions->'triggerPhrases'))), ', '
              ) END,
            CASE WHEN w.response_template IS NOT NULL THEN 'Approved response: ' || w.response_template END
          ),
          w.name, w.intent,
          CASE WHEN jsonb_typeof(COALESCE(w.conditions->'examples', w.conditions->'triggerPhrases')) = 'array'
            THEN COALESCE(w.conditions->'examples', w.conditions->'triggerPhrases') ELSE '[]'::jsonb END,
          '[]'::jsonb, '{}'::jsonb
         FROM workflow_rules w
         JOIN knowledge_documents d
           ON d.tenant_id=w.tenant_id AND d.id=w.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id=w.tenant_id AND v.id=w.document_version_id
        WHERE w.tenant_id=$1 AND w.knowledge_base_id=$2
          AND w.status='approved' AND d.status='ready'
          AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       UNION ALL
       SELECT cf.id, 'conversation_node'::text,
          cf.document_id, cf.document_version_id, cf.usage_direction,
          COALESCE(NULLIF(cf.language, ''), NULLIF(d.metadata->>'language', ''), 'und'),
          cf.source_page_start, NULL::text, NULL::text,
          concat_ws(E'\n',
            'Conversation guidance: ' || cf.content,
            'Flow: ' || cf.flow_key,
            'Node: ' || cf.node_key,
            CASE WHEN cf.variables <> '[]'::jsonb THEN 'Variables: ' || cf.variables::text END,
            CASE WHEN cf.transitions <> '[]'::jsonb THEN 'Transitions: ' || cf.transitions::text END
          ),
          cf.node_key, cf.flow_key, '[]'::jsonb, '[]'::jsonb,
          jsonb_build_object(
            'flowKey', cf.flow_key,
            'nodeKey', cf.node_key,
            'nodeType', cf.node_type,
            'sequenceOrder', cf.sequence_order,
            'isEntry', cf.is_entry
          )
         FROM conversation_flows cf
         JOIN knowledge_documents d
           ON d.tenant_id=cf.tenant_id AND d.id=cf.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id=cf.tenant_id AND v.id=cf.document_version_id
        WHERE cf.tenant_id=$1 AND cf.knowledge_base_id=$2
          AND cf.status='approved' AND d.status='ready'
          AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       ORDER BY record_type, record_id`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return result.rows;
  });
}

async function loadPublicationVersions(job, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT d.id AS document_id, d.document_type, v.id AS document_version_id,
          v.b2_object_key, v.size_bytes, v.extracted_text_object_key
         FROM knowledge_documents d
         JOIN knowledge_document_versions v
           ON v.tenant_id=d.tenant_id AND v.document_id=d.id
          AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
        WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2
          AND d.status='ready' AND d.deleted_at IS NULL
        ORDER BY d.id`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return result.rows;
  });
}

export function validatePublicationMetadata(job, records, points, versions) {
  const documentIds = new Set(versions.map((version) => String(version.document_id).toLowerCase()));
  const versionIds = new Set(versions.map((version) => String(version.document_version_id).toLowerCase()));
  const expectedDocuments = new Set((job.metadata?.documentIds ?? []).map((id) => String(id).toLowerCase()));
  const expectedVersions = new Set((job.metadata?.documentVersionIds ?? []).map((id) => String(id).toLowerCase()));
  if (expectedDocuments.size && (expectedDocuments.size !== documentIds.size
    || [...expectedDocuments].some((id) => !documentIds.has(id)))) {
    throw new AppError(409, 'Publication document manifest changed during indexing', 'KNOWLEDGE_PUBLICATION_MANIFEST_STALE');
  }
  if (expectedVersions.size && (expectedVersions.size !== versionIds.size
    || [...expectedVersions].some((id) => !versionIds.has(id)))) {
    throw new AppError(409, 'Publication version manifest changed during indexing', 'KNOWLEDGE_PUBLICATION_MANIFEST_STALE');
  }
  if (versions.some((version) => !version.b2_object_key || !version.extracted_text_object_key)) {
    throw new AppError(409, 'Publication B2 manifest is incomplete', 'KNOWLEDGE_PUBLICATION_B2_MANIFEST_INVALID');
  }
  if (records.some((record) => !documentIds.has(String(record.document_id).toLowerCase())
    || !versionIds.has(String(record.document_version_id).toLowerCase()))) {
    throw new AppError(409, 'Publication record points outside its document manifest', 'KNOWLEDGE_PUBLICATION_RECORD_MANIFEST_INVALID');
  }
  if (points.length !== records.length) {
    throw new AppError(409, 'Publication vector count does not match PostgreSQL evidence', 'KNOWLEDGE_PUBLICATION_VECTOR_COUNT_INVALID');
  }
  for (let index = 0; index < points.length; index += 1) {
    const payload = points[index].payload;
    const record = records[index];
    const required = {
      tenant_id: String(job.tenant_id).toLowerCase(),
      knowledge_base_id: String(job.knowledge_base_id).toLowerCase(),
      document_id: String(record.document_id).toLowerCase(),
      document_version_id: String(record.document_version_id).toLowerCase(),
      record_id: String(record.record_id).toLowerCase(),
      record_type: String(record.record_type).toUpperCase(),
      document_type: documentTypeByRecordType[record.record_type].toUpperCase(),
      language: String(record.language ?? 'und').toLowerCase(),
      agent_usage: String(record.usage_direction).toUpperCase(),
      publication_revision: job.targetRevision,
    };
    if (Object.entries(required).some(([key, value]) => payload[key] !== value)) {
      throw new AppError(409, 'Qdrant publication metadata validation failed', 'KNOWLEDGE_PUBLICATION_VECTOR_METADATA_INVALID');
    }
    const assignedAgents = (job.assigned_agent_ids ?? []).map((id) => String(id).toLowerCase()).sort();
    if (!Array.isArray(payload.assigned_agent_ids)
      || payload.assigned_agent_ids.slice().sort().join('|') !== assignedAgents.join('|')) {
      throw new AppError(409, 'Qdrant assignment metadata validation failed', 'KNOWLEDGE_PUBLICATION_VECTOR_METADATA_INVALID');
    }
  }
  return { recordCount: records.length, documentCount: versions.length, verified: true };
}

async function verifyPublicationStorage(job, versions, verifyStorageObject) {
  for (const version of versions) {
    await verifyStorageObject({ key: version.b2_object_key, expectedSizeBytes: Number(version.size_bytes) });
    await verifyStorageObject({ key: version.extracted_text_object_key });
  }
  return { objectCount: versions.length * 2, verified: true };
}

async function updateProgress(jobId, progress, contextRunner) {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET progress = $2
      WHERE id = $1 AND status = 'running'`,
    [jobId, progress],
  ));
}

async function finishIndexJob(job, records, contextRunner, artifacts, verification) {
  return contextRunner(null, async (client) => {
    const state = await client.query(
      `SELECT status, publication_revision, pending_publication_revision FROM knowledge_bases
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [job.tenant_id, job.knowledge_base_id],
    );
    if (!state.rowCount || state.rows[0].pending_publication_revision !== job.targetRevision
      || state.rows[0].status !== 'processing') {
      throw new AppError(409, 'Knowledge Base changed during semantic indexing', 'KNOWLEDGE_INDEX_STALE');
    }
    const authoritative = await client.query(
      `SELECT count(*)::int AS record_count FROM (
         SELECT r.id FROM faq_entries r JOIN knowledge_document_versions v
           ON v.tenant_id=r.tenant_id AND v.id=r.document_version_id AND v.is_current=true AND v.status='ready'
          WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.status='approved'
         UNION ALL SELECT r.id FROM knowledge_chunks r JOIN knowledge_document_versions v
           ON v.tenant_id=r.tenant_id AND v.id=r.document_version_id AND v.is_current=true AND v.status='ready'
          WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.status='approved'
         UNION ALL SELECT r.id FROM structured_items r JOIN knowledge_document_versions v
           ON v.tenant_id=r.tenant_id AND v.id=r.document_version_id AND v.is_current=true AND v.status='ready'
          WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.status='approved'
         UNION ALL SELECT r.id FROM workflow_rules r JOIN knowledge_document_versions v
           ON v.tenant_id=r.tenant_id AND v.id=r.document_version_id AND v.is_current=true AND v.status='ready'
          WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.status='approved'
         UNION ALL SELECT r.id FROM conversation_flows r JOIN knowledge_document_versions v
           ON v.tenant_id=r.tenant_id AND v.id=r.document_version_id AND v.is_current=true AND v.status='ready'
          WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.status='approved'
       ) approved_records`,
      [job.tenant_id, job.knowledge_base_id],
    );
    if (authoritative.rows[0].record_count !== records.length) {
      throw new AppError(409, 'PostgreSQL publication verification count changed', 'KNOWLEDGE_PUBLICATION_POSTGRES_UNVERIFIED');
    }
    await client.query(
      `UPDATE faq_entries SET qdrant_point_id = NULL
        WHERE tenant_id = $1 AND knowledge_base_id = $2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    await client.query(
      `UPDATE knowledge_chunks SET qdrant_point_id = NULL
        WHERE tenant_id = $1 AND knowledge_base_id = $2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    const faqIds = records.filter((record) => record.record_type === 'faq').map((record) => record.record_id);
    const chunkIds = records.filter((record) => record.record_type === 'knowledge_chunk').map((record) => record.record_id);
    if (faqIds.length) {
      await client.query(
        `UPDATE faq_entries SET qdrant_point_id = id
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, faqIds],
      );
    }
    if (chunkIds.length) {
      await client.query(
        `UPDATE knowledge_chunks SET qdrant_point_id = id
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, chunkIds],
      );
    }
    const versionIds = [...new Set(records.map((record) => record.document_version_id))];
    if (versionIds.length) {
      await client.query(
        `UPDATE knowledge_document_versions
            SET embedding_model = $3, embedding_dimensions = $4
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, versionIds, env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS],
      );
    }
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'completed', progress = 100, completed_at = now(),
              error_code = NULL, error_message = NULL,
              metadata = metadata || $2::jsonb
        WHERE id = $1`,
      [job.id, JSON.stringify({
        indexedRecordCount: records.length,
        collection: `tenant:${job.tenant_id}`,
        knowledgeMapCacheKey: artifacts.key,
        sparseIndexCacheKey: artifacts.keys.sparse,
        evidenceCacheKey: artifacts.keys.evidence,
        storageVerification: verification.storage,
        postgresVerification: verification.postgres,
        qdrantVerification: verification.qdrant,
        redisVerification: { verified: artifacts.verified, keys: artifacts.keys },
        documentTypes: [...new Set(records.map((record) => documentTypeByRecordType[record.record_type]))],
      })],
    );
    await client.query(
      `UPDATE knowledge_bases
          SET status='published', publication_revision=$3, pending_publication_revision=NULL,
              published_at=now(), published_by=$4
        WHERE tenant_id=$1 AND id=$2 AND pending_publication_revision=$3`,
      [job.tenant_id, job.knowledge_base_id, job.targetRevision, job.metadata?.requestedBy ?? null],
    );
    if (job.metadata?.workspaceId) {
      await client.query(
        `INSERT INTO audit_logs (
           tenant_id, workspace_id, actor_user_id, actor_type, action,
           entity_type, entity_id, after_data
         ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_BASE_PUBLISHED',
           'knowledge_base',$5,$6::jsonb)`,
        [
          job.tenant_id, job.metadata.workspaceId, job.metadata?.requestedBy ?? null,
          job.metadata?.actorType === 'api' ? 'api' : 'user', job.knowledge_base_id,
          JSON.stringify({
            publicationRevision: job.targetRevision,
            indexedRecordCount: records.length,
            verified: true,
          }),
        ],
      );
    }
    return {
      jobId: job.id,
      tenantId: job.tenant_id,
      knowledgeBaseId: job.knowledge_base_id,
      publicationRevision: job.targetRevision,
      indexedRecordCount: records.length,
      status: 'completed',
    };
  });
}

async function failIndexJob(job, error, contextRunner) {
  const code = error instanceof AppError ? error.code : 'KNOWLEDGE_INDEX_FAILED';
  const message = String(error.message ?? 'Semantic indexing failed').slice(0, 4000);
  const retryable = job.attempt_count < job.max_attempts && code !== 'KNOWLEDGE_INDEX_STALE';
  await contextRunner(null, async (client) => {
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = $4::knowledge_job_status,
              completed_at = CASE WHEN $4::knowledge_job_status='failed'::knowledge_job_status THEN now() ELSE NULL END,
              error_code = $2, error_message = $3
        WHERE id = $1 AND status <> 'completed'`,
      [job.id, code, message, retryable ? 'queued' : 'failed'],
    );
    if (!retryable && code !== 'KNOWLEDGE_INDEX_STALE') {
      await client.query(
        `UPDATE knowledge_bases
            SET status='ready', pending_publication_revision=NULL,
                published_at=NULL, published_by=NULL
          WHERE tenant_id=$1 AND id=$2 AND pending_publication_revision=$3
            AND status='processing'`,
        [job.tenant_id, job.knowledge_base_id, job.targetRevision],
      );
    }
  });
}

export async function processSemanticIndexJob(jobId, dependencies = defaultDependencies) {
  const runtime = { ...defaultDependencies, ...dependencies };
  const job = await claimIndexJob(jobId, runtime.contextRunner);
  if (job.alreadyCompleted) return { jobId, status: 'completed', skipped: true };
  if (job.stale) return { jobId, status: 'cancelled', stale: true };
  let qdrantMutated = false;
  let artifactsCached = false;
  let activated = false;
  try {
    const [records, versions] = await Promise.all([
      loadSemanticRecords(job, runtime.contextRunner),
      loadPublicationVersions(job, runtime.contextRunner),
    ]);
    await updateProgress(jobId, 15, runtime.contextRunner);
    const points = [];
    for (let start = 0; start < records.length; start += env.RAG_EMBEDDING_BATCH_SIZE) {
      const batch = records.slice(start, start + env.RAG_EMBEDDING_BATCH_SIZE);
      const vectors = await runtime.embed(batch.map((record) => embeddingText(record.content)));
      for (let index = 0; index < batch.length; index += 1) {
        const record = batch[index];
        points.push(buildSemanticPoint(job, record, vectors[index]));
      }
      const progress = 15 + Math.round(((start + batch.length) / Math.max(records.length, 1)) * 45);
      await updateProgress(jobId, progress, runtime.contextRunner);
    }

    const postgresVerification = validatePublicationMetadata(job, records, points, versions);
    const storageVerification = await verifyPublicationStorage(job, versions, runtime.verifyStorageObject);

    await runtime.ensureCollection(job.tenant_id);
    await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
      publicationRevision: job.targetRevision,
      revisionMode: 'equal',
    });
    qdrantMutated = true;
    for (let start = 0; start < points.length; start += env.QDRANT_UPSERT_BATCH_SIZE) {
      await runtime.upsertPoints(job.tenant_id, points.slice(start, start + env.QDRANT_UPSERT_BATCH_SIZE));
      const progress = 65 + Math.round(((start + Math.min(env.QDRANT_UPSERT_BATCH_SIZE, points.length - start))
        / Math.max(points.length, 1)) * 30);
      await updateProgress(jobId, progress, runtime.contextRunner);
    }
    const qdrantVerification = await runtime.countRevisionPoints(
      job.tenant_id, job.knowledge_base_id, job.targetRevision,
    );
    if (qdrantVerification.count !== points.length) {
      throw new AppError(503, 'Qdrant publication verification count does not match PostgreSQL',
        'KNOWLEDGE_PUBLICATION_QDRANT_UNVERIFIED');
    }
    const cachedMap = await runtime.cacheKnowledgeMap(job, records);
    if (cachedMap?.verified !== true) {
      throw new AppError(503, 'Redis publication artifacts could not be verified',
        'KNOWLEDGE_PUBLICATION_REDIS_UNVERIFIED');
    }
    artifactsCached = true;
    const result = await finishIndexJob(job, records, runtime.contextRunner, cachedMap, {
      storage: storageVerification,
      postgres: postgresVerification,
      qdrant: qdrantVerification,
    });
    activated = true;
    let runtimeCacheInvalidationPending = false;
    try {
      await runtime.invalidateCache(job.tenant_id);
    } catch {
      runtimeCacheInvalidationPending = true;
      try {
        await runtime.contextRunner(null, (client) => client.query(
          `UPDATE knowledge_processing_jobs
              SET metadata=metadata || $2::jsonb
            WHERE id=$1`,
          [job.id, JSON.stringify({ runtimeCacheInvalidationPending: true })],
        ));
      } catch {
        // Activation already committed. Cache keys are revision-filtered and
        // expire; reconciliation can retry invalidation without hiding data.
      }
    }
    // A completed index job is the atomic visibility marker used by runtime.
    // Older vectors are removed only after the new revision is fully usable.
    let staleVectorCleanupPending = false;
    try {
      await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
        publicationRevision: job.targetRevision,
        revisionMode: 'older',
      });
    } catch {
      // The new revision is already the only revision visible to retrieval.
      // Physical cleanup can be retried without rolling back usable vectors.
      staleVectorCleanupPending = true;
      try {
        await runtime.contextRunner(null, (client) => client.query(
          `UPDATE knowledge_processing_jobs
              SET metadata=metadata || $2::jsonb
            WHERE id=$1`,
          [job.id, JSON.stringify({ staleVectorCleanupPending: true })],
        ));
      } catch {
        // Cleanup is retryable; never roll back the now-active revision.
      }
    }
    return {
      ...result,
      knowledgeMapCacheKey: cachedMap.key,
      staleVectorCleanupPending,
      runtimeCacheInvalidationPending,
    };
  } catch (error) {
    if (activated) throw error;
    if (qdrantMutated) {
      try {
        await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
          publicationRevision: job.targetRevision,
          revisionMode: 'equal',
        });
      } catch (cleanupError) {
        error.qdrantCleanupError = cleanupError.message;
      }
    }
    if (artifactsCached) {
      try {
        await runtime.deleteKnowledgeArtifacts(job);
      } catch (cleanupError) {
        error.redisCleanupError = cleanupError.message;
      }
    }
    await failIndexJob(job, error, runtime.contextRunner);
    throw error;
  }
}
