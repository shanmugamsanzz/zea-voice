import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { logger } from '../config/logger.js';
import { enqueueKnowledgeProcessingJob } from './knowledge-processing.queue.js';
import { invalidateTenantKnowledgeCache } from './knowledge-runtime.service.js';
import { normalizeConfiguredToolIdentifier, validateKnowledgeRecord } from './knowledge-record-validation.js';

const reviewSource = `
  WITH review_records AS (
    SELECT tenant_id, knowledge_base_id, document_id, status, true AS is_content, false AS is_container
      FROM faq_entries
    UNION ALL
    SELECT tenant_id, knowledge_base_id, document_id, status, false, true
      FROM structured_catalogs
    UNION ALL
    SELECT tenant_id, knowledge_base_id, document_id, status, true, false
      FROM structured_items
    UNION ALL
    SELECT tenant_id, knowledge_base_id, document_id, status, true, false
      FROM workflow_rules
    UNION ALL
    SELECT tenant_id, knowledge_base_id, document_id, status, true, false
      FROM conversation_flows
    UNION ALL
    SELECT tenant_id, knowledge_base_id, document_id, status, true, false
      FROM knowledge_chunks
  ), review_totals AS (
    SELECT tenant_id, knowledge_base_id, document_id,
      count(*)::int AS total_count,
      count(*) FILTER (WHERE status = 'draft')::int AS draft_count,
      count(*) FILTER (WHERE status = 'approved')::int AS approved_count,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
      count(*) FILTER (WHERE status = 'approved' AND is_content)::int AS approved_content_count,
      count(*) FILTER (WHERE status = 'approved' AND is_container)::int AS approved_container_count
    FROM review_records
    GROUP BY tenant_id, knowledge_base_id, document_id
  )`;

async function documentReviewRows(client, auth, knowledgeBaseId, documentId = null, lock = false) {
  if (lock) {
    const knowledgeBase = await client.query(
      `SELECT id, status, deleted_at FROM knowledge_bases
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        FOR UPDATE`,
      [auth.tenantId, auth.workspaceId, knowledgeBaseId],
    );
    if (!knowledgeBase.rowCount) {
      throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
    }
    if (knowledgeBase.rows[0].deleted_at
      || ['deleting', 'deleted'].includes(knowledgeBase.rows[0].status)) {
      throw new AppError(
        409,
        'Knowledge review cannot be changed while permanent deletion is running',
        'KNOWLEDGE_BASE_NOT_EDITABLE',
      );
    }
    await client.query(
      `SELECT d.id FROM knowledge_documents d
       JOIN knowledge_bases kb ON kb.tenant_id = d.tenant_id AND kb.id = d.knowledge_base_id
       WHERE d.tenant_id = $1 AND d.knowledge_base_id = $2 AND kb.workspace_id = $3
         AND d.deleted_at IS NULL AND d.status <> 'deleted'
         AND ($4::uuid IS NULL OR d.id = $4)
       FOR UPDATE OF d`,
      [auth.tenantId, knowledgeBaseId, auth.workspaceId, documentId],
    );
    await client.query(
      `SELECT v.id FROM knowledge_document_versions v
       JOIN knowledge_documents d ON d.tenant_id = v.tenant_id AND d.id = v.document_id
       WHERE v.tenant_id = $1 AND d.knowledge_base_id = $2
         AND v.is_current = true AND v.deleted_at IS NULL
         AND ($3::uuid IS NULL OR d.id = $3)
       FOR UPDATE OF v`,
      [auth.tenantId, knowledgeBaseId, documentId],
    );
  }
  const result = await client.query(`${reviewSource}
    SELECT d.id, d.document_type, d.display_name, d.status,
      v.id AS version_id, v.version_number, v.status AS version_status,
      COALESCE(v.extraction_metadata->'validationErrors', '[]'::jsonb) AS validation_errors,
      COALESCE(rt.total_count, 0) AS total_count,
      COALESCE(rt.draft_count, 0) AS draft_count,
      COALESCE(rt.approved_count, 0) AS approved_count,
      COALESCE(rt.rejected_count, 0) AS rejected_count,
      COALESCE(rt.approved_content_count, 0) AS approved_content_count,
      COALESCE(rt.approved_container_count, 0) AS approved_container_count
    FROM knowledge_documents d
    JOIN knowledge_bases kb
      ON kb.tenant_id = d.tenant_id AND kb.id = d.knowledge_base_id
    LEFT JOIN knowledge_document_versions v
      ON v.tenant_id = d.tenant_id AND v.document_id = d.id
     AND v.is_current = true AND v.deleted_at IS NULL
    LEFT JOIN review_totals rt
      ON rt.tenant_id = d.tenant_id AND rt.knowledge_base_id = d.knowledge_base_id
     AND rt.document_id = d.id
    WHERE d.tenant_id = $1 AND d.knowledge_base_id = $2
      AND kb.workspace_id = $3 AND kb.deleted_at IS NULL
      AND d.deleted_at IS NULL AND d.status <> 'deleted'
      AND ($4::uuid IS NULL OR d.id = $4)
    ORDER BY d.created_at, d.id`,
  [auth.tenantId, knowledgeBaseId, auth.workspaceId, documentId]);
  if (documentId && !result.rowCount) {
    throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  }
  return result.rows;
}

function mapSummary(row) {
  const requiresContainer = row.document_type === 'catalog';
  const validationErrors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
  const ready = ['ready'].includes(row.status)
    && row.draft_count === 0
    && row.approved_content_count > 0
    && (!requiresContainer || row.approved_container_count > 0)
    && validationErrors.length === 0;
  return {
    documentId: row.id,
    documentType: row.document_type,
    displayName: row.display_name,
    status: row.status,
    versionId: row.version_id,
    versionNumber: row.version_number,
    versionStatus: row.version_status,
    totalCount: row.total_count,
    draftCount: row.draft_count,
    approvedCount: row.approved_count,
    rejectedCount: row.rejected_count,
    approvedContentCount: row.approved_content_count,
    approvedContainerCount: row.approved_container_count,
    validationErrors,
    ready,
  };
}

function blockersForDocuments(rows) {
  const blockers = [];
  if (!rows.length) blockers.push({ code: 'NO_DOCUMENTS', message: 'Upload at least one document before publishing' });
  for (const row of rows) {
    if (['uploading', 'queued', 'processing'].includes(row.status)) {
      blockers.push({ code: 'DOCUMENT_PROCESSING', documentId: row.id, message: `${row.display_name} is still processing` });
    } else if (row.status === 'failed') {
      blockers.push({ code: 'DOCUMENT_FAILED', documentId: row.id, message: `${row.display_name} failed processing` });
    } else if (row.status !== 'ready') {
      blockers.push({ code: 'DOCUMENT_NOT_READY', documentId: row.id, message: `${row.display_name} is not ready to publish` });
    }
    if (row.total_count === 0) {
      blockers.push({ code: 'NO_REVIEW_RECORDS', documentId: row.id, message: `${row.display_name} has no reviewable content` });
    }
    if (row.draft_count > 0) {
      blockers.push({ code: 'DRAFT_RECORDS', documentId: row.id, message: `${row.display_name} still has draft records` });
    }
    if (row.approved_content_count === 0) {
      blockers.push({ code: 'NO_APPROVED_CONTENT', documentId: row.id, message: `${row.display_name} needs approved content` });
    }
    if (row.document_type === 'catalog' && row.approved_container_count === 0) {
      blockers.push({ code: 'CATALOG_NOT_APPROVED', documentId: row.id, message: `${row.display_name} catalog must be approved` });
    }
    const validationErrors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
    if (validationErrors.length) {
      blockers.push({
        code: 'STRUCTURED_VALIDATION_ERRORS', documentId: row.id,
        message: `${row.display_name} contains invalid structured records`,
        errors: validationErrors,
      });
    }
  }
  return blockers;
}

function commonRecord(row, kind) {
  return {
    id: row.id,
    kind,
    status: row.status,
    sourcePageStart: row.source_page_start,
    sourcePageEnd: row.source_page_end,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function reviewContent(client, auth, document) {
  const values = [auth.tenantId, document.version_id];
  if (document.document_type === 'faq') {
    const result = await client.query(
      `SELECT * FROM faq_entries WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY created_at, id`, values,
    );
    return { records: result.rows.map((row) => ({
      ...commonRecord(row, 'faq'), question: row.question, answer: row.answer,
      language: row.language, usageDirection: row.usage_direction,
    })) };
  }
  if (document.document_type === 'catalog') {
    const catalogs = await client.query(
      `SELECT * FROM structured_catalogs WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY created_at, id`, values,
    );
    const items = await client.query(
      `SELECT * FROM structured_items WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY display_order, created_at, id`, values,
    );
    return {
      catalogs: catalogs.rows.map((row) => ({
        ...commonRecord(row, 'catalog'), catalogType: row.catalog_type,
        name: row.name, description: row.description, defaultCurrency: row.default_currency,
      })),
      records: items.rows.map((row) => ({
        ...commonRecord(row, 'catalog_item'), catalogId: row.catalog_id,
        itemKey: row.item_key, name: row.name, category: row.category,
        categoryKey: row.category_key, parentCategoryKey: row.parent_category_key,
        categoryDescription: row.category_description,
        categorySelectionRules: row.category_selection_rules,
        categoryAliases: row.category_aliases, aliases: row.aliases,
        relationships: row.relationships, selectionRules: row.selection_rules,
        description: row.description, price: row.price === null ? null : Number(row.price),
        currency: row.currency, displayOrder: row.display_order, sourceText: row.source_text,
      })),
    };
  }
  if (document.document_type === 'workflow_rules') {
    const result = await client.query(
      `SELECT * FROM workflow_rules WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY priority, created_at, id`, values,
    );
    return { records: result.rows.map((row) => ({
      ...commonRecord(row, 'workflow_rule'), name: row.name, intent: row.intent,
      priority: row.priority, usageDirection: row.usage_direction, conditions: row.conditions,
      actionType: row.action_type, actionConfig: row.action_config,
      responseTemplate: row.response_template, sourceText: row.source_text,
    })) };
  }
  if (document.document_type === 'conversation_script') {
    const result = await client.query(
      `SELECT * FROM conversation_flows WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY sequence_order, created_at, id`, values,
    );
    return { records: result.rows.map((row) => ({
      ...commonRecord(row, 'conversation_node'), flowKey: row.flow_key, nodeKey: row.node_key,
      nodeType: row.node_type, language: row.language, sequenceOrder: row.sequence_order,
      isEntry: row.is_entry, content: row.content, variables: row.variables,
      transitions: row.transitions, usageDirection: row.usage_direction,
    })) };
  }
  const result = await client.query(
    `SELECT * FROM knowledge_chunks WHERE tenant_id = $1 AND document_version_id = $2 ORDER BY chunk_index`, values,
  );
  return { records: result.rows.map((row) => ({
    ...commonRecord(row, 'knowledge_chunk'), chunkIndex: row.chunk_index,
    content: row.content, tokenCount: row.token_count, usageDirection: row.usage_direction,
    sourceHeading: row.source_heading,
  })) };
}

async function locateRecord(client, auth, document, recordId, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const query = async (table, kind) => {
    const result = await client.query(
      `SELECT *, $4::text AS record_kind FROM ${table}
        WHERE tenant_id = $1 AND document_version_id = $2 AND id = $3${suffix}`,
      [auth.tenantId, document.version_id, recordId, kind],
    );
    return result.rows[0] ?? null;
  };
  if (document.document_type === 'faq') return query('faq_entries', 'faq');
  if (document.document_type === 'workflow_rules') return query('workflow_rules', 'workflow_rule');
  if (document.document_type === 'conversation_script') return query('conversation_flows', 'conversation_node');
  if (document.document_type === 'general_knowledge') return query('knowledge_chunks', 'knowledge_chunk');
  return await query('structured_catalogs', 'catalog') ?? query('structured_items', 'catalog_item');
}

const fieldDefinitions = {
  faq: {
    table: 'faq_entries', fields: {
      question: ['question'], answer: ['answer'], language: ['language'], usageDirection: ['usage_direction'],
    },
  },
  catalog: {
    table: 'structured_catalogs', fields: {
      catalogType: ['catalog_type'], name: ['name'], description: ['description'], defaultCurrency: ['default_currency'],
    },
  },
  catalog_item: {
    table: 'structured_items', fields: {
      itemKey: ['item_key'], name: ['name'], category: ['category'], categoryKey: ['category_key'],
      parentCategoryKey: ['parent_category_key'], categoryDescription: ['category_description'],
      categorySelectionRules: ['category_selection_rules', 'jsonb'],
      categoryAliases: ['category_aliases', 'jsonb'], aliases: ['aliases', 'jsonb'],
      relationships: ['relationships', 'jsonb'], selectionRules: ['selection_rules', 'jsonb'],
      description: ['description'],
      price: ['price'], currency: ['currency'], displayOrder: ['display_order'],
    },
  },
  workflow_rule: {
    table: 'workflow_rules', fields: {
      name: ['name'], intent: ['intent'], priority: ['priority'], usageDirection: ['usage_direction'],
      conditions: ['conditions', 'jsonb'], actionConfig: ['action_config', 'jsonb'],
      responseTemplate: ['response_template'],
    },
  },
  conversation_node: {
    table: 'conversation_flows', fields: {
      flowKey: ['flow_key'], nodeKey: ['node_key'], nodeType: ['node_type'], language: ['language'],
      sequenceOrder: ['sequence_order'], isEntry: ['is_entry'], content: ['content'],
      variables: ['variables', 'jsonb'], transitions: ['transitions', 'jsonb'], usageDirection: ['usage_direction'],
    },
  },
  knowledge_chunk: {
    table: 'knowledge_chunks', fields: { content: ['content'], usageDirection: ['usage_direction'] },
  },
};

export function assertKnowledgeRecordReviewable(record) {
  const issues = validateKnowledgeRecord(record.record_kind, record);
  if (issues.length) {
    throw new AppError(409, 'Structured record must be corrected before approval', 'REVIEW_RECORD_INVALID', {
      recordId: record.id,
      recordKind: record.record_kind,
      issues,
    });
  }
}

export function assertStructuredDocumentReviewable(document) {
  const issues = Array.isArray(document.validation_errors) ? document.validation_errors : [];
  if (issues.length) {
    throw new AppError(409, 'Structured document must be corrected and re-uploaded before approval',
      'STRUCTURED_VALIDATION_ERRORS', { documentId: document.id, issues });
  }
}

async function syncReviewStatus(client, auth, knowledgeBaseId, documentId) {
  const [row] = await documentReviewRows(client, auth, knowledgeBaseId, documentId, true);
  const publishable = row.draft_count === 0 && row.approved_content_count > 0
    && (row.document_type !== 'catalog' || row.approved_container_count > 0)
    && (!Array.isArray(row.validation_errors) || row.validation_errors.length === 0);
  const status = publishable ? 'ready' : 'review_required';
  await client.query(
    `UPDATE knowledge_documents SET status = $3 WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, documentId, status],
  );
  await client.query(
    `UPDATE knowledge_document_versions SET status = $3 WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, row.version_id, status],
  );
  await client.query(
    `UPDATE knowledge_bases kb SET
       status = CASE
         WHEN EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id = kb.tenant_id
           AND d.knowledge_base_id = kb.id AND d.deleted_at IS NULL AND d.status = 'failed')
           THEN 'partially_failed'::knowledge_base_status
         WHEN EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id = kb.tenant_id
           AND d.knowledge_base_id = kb.id AND d.deleted_at IS NULL
           AND d.status IN ('uploading', 'queued', 'processing'))
           THEN 'processing'::knowledge_base_status
         WHEN NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id = kb.tenant_id
           AND d.knowledge_base_id = kb.id AND d.deleted_at IS NULL)
           THEN 'draft'::knowledge_base_status
         WHEN NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id = kb.tenant_id
           AND d.knowledge_base_id = kb.id AND d.deleted_at IS NULL AND d.status <> 'ready')
           THEN 'ready'::knowledge_base_status
         ELSE 'draft'::knowledge_base_status
       END,
       published_at = NULL, published_by = NULL
     WHERE kb.tenant_id = $1 AND kb.workspace_id = $2 AND kb.id = $3`,
    [auth.tenantId, auth.workspaceId, knowledgeBaseId],
  );
  return { status, summary: mapSummary({ ...row, status }) };
}

async function audit(client, auth, action, entityId, data) {
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, workspace_id, actor_user_id, actor_type, action,
       entity_type, entity_id, after_data
     ) VALUES ($1, $2, $3, $4, $5, 'knowledge_review_record', $6, $7::jsonb)`,
    [
      auth.tenantId, auth.workspaceId, auth.userId,
      auth.authType === 'api_key' ? 'api' : 'user', action, entityId, JSON.stringify(data),
    ],
  );
}

export function getDocumentReview(auth, knowledgeBaseId, documentId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const [document] = await documentReviewRows(client, auth, knowledgeBaseId, documentId);
    return {
      document: mapSummary(document),
      ...await reviewContent(client, auth, document),
    };
  });
}

export function updateReviewRecord(auth, knowledgeBaseId, documentId, recordId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const [document] = await documentReviewRows(client, auth, knowledgeBaseId, documentId, true);
    if (!['review_required', 'ready'].includes(document.status)) {
      throw new AppError(409, 'Document is not available for review', 'DOCUMENT_NOT_REVIEWABLE');
    }
    const record = await locateRecord(client, auth, document, recordId, true);
    if (!record) throw new AppError(404, 'Review record was not found', 'REVIEW_RECORD_NOT_FOUND');
    const definition = fieldDefinitions[record.record_kind];
    const values = [auth.tenantId, document.version_id, recordId];
    const sets = [];
    let normalizedInput = input;
    if (record.record_kind === 'workflow_rule' && Object.hasOwn(input, 'actionConfig')) {
      const actionConfig = input.actionConfig ?? {};
      const toolIdentifier = normalizeConfiguredToolIdentifier(
        actionConfig.toolIdentifier ?? actionConfig.actionKey,
      );
      normalizedInput = {
        ...input,
        actionConfig: {
          ...actionConfig,
          ...(toolIdentifier ? { toolIdentifier, actionKey: toolIdentifier } : {}),
        },
      };
    }
    for (const [field, value] of Object.entries(normalizedInput)) {
      const fieldDefinition = definition.fields[field];
      if (!fieldDefinition) {
        throw new AppError(400, `${field} cannot be edited for ${record.record_kind}`, 'REVIEW_FIELD_NOT_ALLOWED');
      }
      const [column, type] = fieldDefinition;
      values.push(type === 'jsonb' ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${type === 'jsonb' ? '::jsonb' : ''}`);
    }
    if (record.record_kind === 'knowledge_chunk' && Object.hasOwn(input, 'content')) {
      values.push(input.content.split(/\s+/u).filter(Boolean).length);
      sets.push(`token_count = $${values.length}`);
    }
    if (record.record_kind === 'workflow_rule' && Object.hasOwn(normalizedInput, 'actionConfig')) {
      const config = normalizedInput.actionConfig;
      const toolIdentifier = normalizeConfiguredToolIdentifier(config.toolIdentifier ?? config.actionKey);
      values.push(toolIdentifier ? 'configured_tool' : 'respond');
      sets.push(`action_type = $${values.length}`);
    }
    sets.push("status = 'draft'", 'approved_by = NULL', 'approved_at = NULL');
    try {
      await client.query(
        `UPDATE ${definition.table} SET ${sets.join(', ')}
          WHERE tenant_id = $1 AND document_version_id = $2 AND id = $3`,
        values,
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Review edit conflicts with another record', 'REVIEW_RECORD_CONFLICT');
      }
      throw error;
    }
    const synced = await syncReviewStatus(client, auth, knowledgeBaseId, documentId);
    await audit(client, auth, 'KNOWLEDGE_REVIEW_EDITED', recordId, { documentId, fields: Object.keys(input) });
    return { recordId, recordKind: record.record_kind, status: 'draft', documentStatus: synced.status };
  });
}

export function decideReviewRecord(auth, knowledgeBaseId, documentId, recordId, decision, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const [document] = await documentReviewRows(client, auth, knowledgeBaseId, documentId, true);
    if (!['review_required', 'ready'].includes(document.status)) {
      throw new AppError(409, 'Document is not available for review', 'DOCUMENT_NOT_REVIEWABLE');
    }
    const record = await locateRecord(client, auth, document, recordId, true);
    if (!record) throw new AppError(404, 'Review record was not found', 'REVIEW_RECORD_NOT_FOUND');
    const definition = fieldDefinitions[record.record_kind];
    if (decision === 'approve') {
      assertStructuredDocumentReviewable(document);
      assertKnowledgeRecordReviewable(record);
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'draft';
    try {
      await client.query(
        `UPDATE ${definition.table}
            SET status = $4::knowledge_record_status,
                approved_by = CASE WHEN $4::knowledge_record_status = 'approved'::knowledge_record_status
                  THEN $5::uuid ELSE NULL END,
                approved_at = CASE WHEN $4::knowledge_record_status = 'approved'::knowledge_record_status
                  THEN now() ELSE NULL END
          WHERE tenant_id = $1 AND document_version_id = $2 AND id = $3`,
        [auth.tenantId, document.version_id, recordId, status, auth.userId],
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Approval conflicts with another approved record', 'REVIEW_APPROVAL_CONFLICT');
      }
      throw error;
    }
    const synced = await syncReviewStatus(client, auth, knowledgeBaseId, documentId);
    const actionByDecision = {
      approve: 'KNOWLEDGE_REVIEW_APPROVED',
      reject: 'KNOWLEDGE_REVIEW_REJECTED',
      reset: 'KNOWLEDGE_REVIEW_RESET',
    };
    await audit(client, auth, actionByDecision[decision], recordId, { documentId, status });
    return { recordId, recordKind: record.record_kind, status, documentStatus: synced.status };
  });
}

export function approveAllDraftReviewRecords(
  auth, knowledgeBaseId, documentId, contextRunner = withTenantContext,
) {
  return contextRunner(auth, async (client) => {
    const [document] = await documentReviewRows(client, auth, knowledgeBaseId, documentId, true);
    if (!['review_required', 'ready'].includes(document.status)) {
      throw new AppError(409, 'Document is not available for review', 'DOCUMENT_NOT_REVIEWABLE');
    }
    assertStructuredDocumentReviewable(document);

    const tablesByDocumentType = {
      faq: [['faq_entries', 'faq']],
      catalog: [['structured_catalogs', 'catalog'], ['structured_items', 'catalog_item']],
      workflow_rules: [['workflow_rules', 'workflow_rule']],
      conversation_script: [['conversation_flows', 'conversation_node']],
      general_knowledge: [['knowledge_chunks', 'knowledge_chunk']],
    };
    const tables = tablesByDocumentType[document.document_type];
    if (!tables) {
      throw new AppError(400, 'Document type cannot be reviewed', 'DOCUMENT_TYPE_NOT_REVIEWABLE');
    }

    let approvedCount = 0;
    try {
      for (const [table, kind] of tables) {
        const drafts = await client.query(
          `SELECT *, $3::text AS record_kind FROM ${table}
            WHERE tenant_id = $1 AND document_version_id = $2 AND status = 'draft'
            FOR UPDATE`,
          [auth.tenantId, document.version_id, kind],
        );
        for (const record of drafts.rows) assertKnowledgeRecordReviewable(record);
        const result = await client.query(
          `UPDATE ${table}
              SET status = 'approved', approved_by = $3, approved_at = now()
            WHERE tenant_id = $1 AND document_version_id = $2 AND status = 'draft'`,
          [auth.tenantId, document.version_id, auth.userId],
        );
        approvedCount += result.rowCount;
      }
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Bulk approval conflicts with another approved record', 'REVIEW_APPROVAL_CONFLICT');
      }
      throw error;
    }

    const synced = await syncReviewStatus(client, auth, knowledgeBaseId, documentId);
    await audit(client, auth, 'KNOWLEDGE_REVIEW_BULK_APPROVED', documentId, {
      documentId, approvedCount,
    });
    return { documentId, approvedCount, documentStatus: synced.status, summary: synced.summary };
  });
}

export function getKnowledgeBaseReviewSummary(auth, knowledgeBaseId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const knowledgeBase = await client.query(
      `SELECT id, name, status, publication_revision, pending_publication_revision, published_at
         FROM knowledge_bases
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
          AND deleted_at IS NULL AND status <> 'deleted'`,
      [auth.tenantId, auth.workspaceId, knowledgeBaseId],
    );
    if (!knowledgeBase.rowCount) throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
    const rows = await documentReviewRows(client, auth, knowledgeBaseId);
    const blockers = blockersForDocuments(rows);
    if (knowledgeBase.rows[0].status === 'published') {
      blockers.push({ code: 'ALREADY_PUBLISHED', message: 'Knowledge Base is already published' });
    }
    return {
      knowledgeBase: {
        id: knowledgeBase.rows[0].id,
        name: knowledgeBase.rows[0].name,
        status: knowledgeBase.rows[0].status,
        publicationRevision: knowledgeBase.rows[0].publication_revision,
        pendingPublicationRevision: knowledgeBase.rows[0].pending_publication_revision,
        publishedAt: knowledgeBase.rows[0].published_at,
      },
      documents: rows.map(mapSummary),
      blockers,
      canPublish: blockers.length === 0,
    };
  });
}

export async function publishKnowledgeBase(
  auth,
  knowledgeBaseId,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
) {
  const published = await contextRunner(auth, async (client) => {
    const knowledgeBase = await client.query(
      `SELECT * FROM knowledge_bases
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
          AND deleted_at IS NULL AND status <> 'deleted'
        FOR UPDATE`,
      [auth.tenantId, auth.workspaceId, knowledgeBaseId],
    );
    if (!knowledgeBase.rowCount) throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
    if (['deleting', 'deleted'].includes(knowledgeBase.rows[0].status)) {
      throw new AppError(
        409,
        'Knowledge Base cannot be published while permanent deletion is running',
        'KNOWLEDGE_BASE_NOT_EDITABLE',
      );
    }
    if (knowledgeBase.rows[0].status === 'published') {
      throw new AppError(409, 'Knowledge Base is already published', 'KNOWLEDGE_BASE_ALREADY_PUBLISHED');
    }
    const rows = await documentReviewRows(client, auth, knowledgeBaseId, null, true);
    const blockers = blockersForDocuments(rows);
    if (blockers.length) {
      throw new AppError(409, 'Knowledge Base cannot be published until review is complete', 'KNOWLEDGE_BASE_REVIEW_INCOMPLETE', { blockers });
    }
    const targetRevision = Number(knowledgeBase.rows[0].publication_revision) + 1;
    const updated = await client.query(
      `UPDATE knowledge_bases
          SET status = 'processing', pending_publication_revision = $5,
              published_at = NULL, published_by = NULL, updated_by = $4
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
        RETURNING id, status, publication_revision, pending_publication_revision`,
      [auth.tenantId, auth.workspaceId, knowledgeBaseId, auth.userId, targetRevision],
    );
    const indexJob = await client.query(
      `INSERT INTO knowledge_processing_jobs (
         tenant_id, knowledge_base_id, job_type, status, queue_name, metadata
       ) VALUES ($1, $2, 'index', 'queued', 'knowledge-processing', $3::jsonb)
       RETURNING id, max_attempts`,
      [
        auth.tenantId,
        knowledgeBaseId,
        JSON.stringify({
          publicationRevision: targetRevision,
          requestedBy: auth.userId,
          actorType: auth.authType === 'api_key' ? 'api' : 'user',
          workspaceId: auth.workspaceId,
          documentIds: rows.map((row) => row.id),
          documentVersionIds: rows.map((row) => row.version_id),
        }),
      ],
    );
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, after_data
       ) VALUES ($1, $2, $3, $4, 'KNOWLEDGE_BASE_PUBLICATION_QUEUED',
         'knowledge_base', $5, $6::jsonb)`,
      [
        auth.tenantId, auth.workspaceId, auth.userId,
        auth.authType === 'api_key' ? 'api' : 'user', knowledgeBaseId,
        JSON.stringify({ publicationRevision: targetRevision, documentCount: rows.length }),
      ],
    );
    return {
      id: updated.rows[0].id,
      status: updated.rows[0].status,
      publicationRevision: updated.rows[0].publication_revision,
      pendingPublicationRevision: targetRevision,
      publishedAt: null,
      publishedBy: null,
      documentCount: rows.length,
      semanticIndex: {
        jobId: indexJob.rows[0].id,
        status: 'queued',
      },
      maxAttempts: indexJob.rows[0].max_attempts,
    };
  });

  // A profile may have been cached before this revision was published. Clear
  // tenant-scoped RAG caches so newly approved structured rules are available
  // to the next caller instead of waiting for the profile TTL.
  await invalidateTenantKnowledgeCache(auth.tenantId);

  try {
    const queued = await queueAdapter({
      processingJobId: published.semanticIndex.jobId,
      maxAttempts: published.maxAttempts,
    });
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id = $3,
          error_code = NULL, error_message = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [auth.tenantId, published.semanticIndex.jobId, queued.id],
    ));
  } catch (error) {
    logger.warn({ err: error, processingJobId: published.semanticIndex.jobId }, 'Semantic index job remains queued for reconciliation');
    try {
      await contextRunner(auth, (client) => client.query(
        `UPDATE knowledge_processing_jobs
            SET error_code = 'QUEUE_UNAVAILABLE', error_message = $3
          WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
        [auth.tenantId, published.semanticIndex.jobId, String(error.message).slice(0, 4000)],
      ));
    } catch (updateError) {
      logger.warn({ err: updateError, processingJobId: published.semanticIndex.jobId }, 'Could not record semantic queue failure');
    }
  }

  const { maxAttempts: _maxAttempts, ...response } = published;
  return response;
}
