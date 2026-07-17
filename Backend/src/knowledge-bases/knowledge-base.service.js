import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { requestDeleteKnowledgeBase } from './knowledge-deletion.service.js';

const knowledgeBaseSelect = `
  SELECT kb.*,
    COALESCE(count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL), 0)::int AS document_count,
    COALESCE(count(DISTINCT d.id) FILTER (
      WHERE d.deleted_at IS NULL AND d.status IN ('queued', 'processing', 'uploading')
    ), 0)::int AS processing_document_count,
    COALESCE(count(DISTINCT d.id) FILTER (
      WHERE d.deleted_at IS NULL AND d.status = 'failed'
    ), 0)::int AS failed_document_count,
    COALESCE(count(DISTINCT akb.agent_id), 0)::int AS assigned_agent_count
    ,(
      SELECT jsonb_build_object(
        'id', j.id,
        'status', j.status,
        'progress', j.progress,
        'attemptCount', j.attempt_count,
        'maxAttempts', j.max_attempts,
        'errorCode', j.error_code,
        'errorMessage', j.error_message,
        'publicationRevision', j.metadata->'publicationRevision',
        'createdAt', j.created_at,
        'completedAt', j.completed_at
      )
      FROM knowledge_processing_jobs j
      WHERE j.tenant_id = kb.tenant_id AND j.knowledge_base_id = kb.id
        AND j.job_type = 'index'
      ORDER BY j.created_at DESC
      LIMIT 1
    ) AS semantic_index
  FROM knowledge_bases kb
  LEFT JOIN knowledge_documents d
    ON d.tenant_id = kb.tenant_id AND d.knowledge_base_id = kb.id
  LEFT JOIN agent_knowledge_bases akb
    ON akb.tenant_id = kb.tenant_id AND akb.knowledge_base_id = kb.id`;

function mapKnowledgeBase(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    usageDirection: row.usage_direction,
    settings: row.settings,
    publicationRevision: row.publication_revision,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    documentCount: row.document_count,
    processingDocumentCount: row.processing_document_count,
    failedDocumentCount: row.failed_document_count,
    assignedAgentCount: row.assigned_agent_count,
    semanticIndex: row.semantic_index,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getKnowledgeBaseRow(client, tenantId, workspaceId, knowledgeBaseId, lock = false) {
  if (lock) {
    const locked = await client.query(
      `SELECT id FROM knowledge_bases
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
          AND deleted_at IS NULL AND status <> 'deleted'
        FOR UPDATE`,
      [tenantId, workspaceId, knowledgeBaseId],
    );
    if (!locked.rowCount) {
      throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
    }
  }
  const result = await client.query(`${knowledgeBaseSelect}
    WHERE kb.tenant_id = $1 AND kb.workspace_id = $2 AND kb.id = $3
      AND kb.deleted_at IS NULL AND kb.status <> 'deleted'
    GROUP BY kb.id`, [tenantId, workspaceId, knowledgeBaseId]);
  if (!result.rowCount) {
    throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
  }
  return result.rows[0];
}

async function writeAuditLog(client, auth, action, knowledgeBaseId, before, after) {
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, workspace_id, actor_user_id, actor_type, action,
       entity_type, entity_id, before_data, after_data
     ) VALUES ($1, $2, $3, $4, $5, 'knowledge_base', $6, $7::jsonb, $8::jsonb)`,
    [
      auth.tenantId,
      auth.workspaceId,
      auth.userId,
      auth.authType === 'api_key' ? 'api' : 'user',
      action,
      knowledgeBaseId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}

export function listKnowledgeBases(auth, filters, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const values = [
      auth.tenantId,
      auth.workspaceId,
      filters.search ?? null,
      filters.status ?? null,
      filters.usageDirection ?? null,
    ];
    const where = `WHERE kb.tenant_id = $1 AND kb.workspace_id = $2
      AND kb.deleted_at IS NULL AND kb.status <> 'deleted'
      AND ($3::text IS NULL OR kb.name ILIKE '%' || $3 || '%'
        OR COALESCE(kb.description, '') ILIKE '%' || $3 || '%')
      AND ($4::knowledge_base_status IS NULL OR kb.status = $4)
      AND ($5::agent_usage_direction IS NULL OR kb.usage_direction = $5)`;

    const total = await client.query(`SELECT count(*)::int AS total FROM knowledge_bases kb ${where}`, values);
    const result = await client.query(`${knowledgeBaseSelect}
      ${where}
      GROUP BY kb.id
      ORDER BY kb.updated_at DESC, kb.id
      LIMIT $6 OFFSET $7`, [
      ...values,
      filters.pageSize,
      (filters.page - 1) * filters.pageSize,
    ]);

    return {
      items: result.rows.map(mapKnowledgeBase),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: total.rows[0].total,
        totalPages: Math.ceil(total.rows[0].total / filters.pageSize),
      },
    };
  });
}

export function getKnowledgeBase(auth, knowledgeBaseId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => mapKnowledgeBase(
    await getKnowledgeBaseRow(client, auth.tenantId, auth.workspaceId, knowledgeBaseId),
  ));
}

export function createKnowledgeBase(auth, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    try {
      const result = await client.query(
        `INSERT INTO knowledge_bases (
           tenant_id, workspace_id, name, description, usage_direction,
           settings, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
         RETURNING id`,
        [
          auth.tenantId,
          auth.workspaceId,
          input.name,
          input.description ?? null,
          input.usageDirection,
          JSON.stringify(input.settings),
          auth.userId,
        ],
      );
      const created = mapKnowledgeBase(await getKnowledgeBaseRow(
        client, auth.tenantId, auth.workspaceId, result.rows[0].id,
      ));
      await writeAuditLog(client, auth, 'KNOWLEDGE_BASE_CREATED', created.id, null, created);
      return created;
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Knowledge Base name already exists in this workspace', 'KNOWLEDGE_BASE_EXISTS');
      }
      throw error;
    }
  });
}

export function updateKnowledgeBase(auth, knowledgeBaseId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const existingRow = await getKnowledgeBaseRow(
      client, auth.tenantId, auth.workspaceId, knowledgeBaseId, true,
    );
    if (['deleting', 'deleted'].includes(existingRow.status)) {
      throw new AppError(409, 'Knowledge Base cannot be edited while it is being deleted', 'KNOWLEDGE_BASE_NOT_EDITABLE');
    }
    const before = mapKnowledgeBase(existingRow);
    const name = input.name ?? existingRow.name;
    const description = Object.hasOwn(input, 'description') ? input.description : existingRow.description;
    const usageDirection = input.usageDirection ?? existingRow.usage_direction;
    const settings = input.settings ?? existingRow.settings;

    try {
      await client.query(
        `UPDATE knowledge_bases
            SET name = $4, description = $5, usage_direction = $6,
                settings = $7::jsonb, updated_by = $8
          WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [
          auth.tenantId,
          auth.workspaceId,
          knowledgeBaseId,
          name,
          description,
          usageDirection,
          JSON.stringify(settings),
          auth.userId,
        ],
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Knowledge Base name already exists in this workspace', 'KNOWLEDGE_BASE_EXISTS');
      }
      throw error;
    }

    const updated = mapKnowledgeBase(await getKnowledgeBaseRow(
      client, auth.tenantId, auth.workspaceId, knowledgeBaseId,
    ));
    await writeAuditLog(client, auth, 'KNOWLEDGE_BASE_UPDATED', knowledgeBaseId, before, updated);
    return updated;
  });
}

export function deleteKnowledgeBase(auth, knowledgeBaseId, contextRunner = withTenantContext) {
  return requestDeleteKnowledgeBase(auth, knowledgeBaseId, contextRunner);
}
