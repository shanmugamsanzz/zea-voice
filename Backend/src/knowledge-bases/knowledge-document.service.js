import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { deleteAllB2ObjectVersions, deleteB2Object, putB2Object } from '../rag/b2.client.js';
import { deleteTenantPointsByDocumentVersion } from '../rag/qdrant.client.js';
import { invalidateTenantKnowledgeCache } from './knowledge-runtime.service.js';
import { enqueueKnowledgeProcessingJob } from './knowledge-processing.queue.js';

const storage = {
  putObject: putB2Object,
  deleteObject: deleteB2Object,
  deleteAllVersions: deleteAllB2ObjectVersions,
};

function mapDocument(row) {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    documentType: row.document_type,
    displayName: row.display_name,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    metadata: row.metadata,
    currentVersion: row.version_id ? {
      id: row.version_id,
      versionNumber: row.version_number,
      status: row.version_status,
      checksumSha256: row.content_sha256,
      pageCount: row.page_count,
      chunkCount: row.chunk_count,
      createdAt: row.version_created_at,
    } : null,
    processingJob: row.processing_job_id ? {
      id: row.processing_job_id,
      type: row.processing_job_type,
      status: row.processing_job_status,
      progress: row.processing_job_progress,
      attemptCount: row.processing_job_attempt_count,
      maxAttempts: row.processing_job_max_attempts,
      errorCode: row.processing_job_error_code,
      errorMessage: row.processing_job_error_message,
      createdAt: row.processing_job_created_at,
      completedAt: row.processing_job_completed_at,
    } : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const documentSelect = `
  SELECT d.*, v.id AS version_id, v.version_number, v.status AS version_status,
    v.content_sha256, v.page_count, v.chunk_count, v.created_at AS version_created_at,
    latest_job.*
  FROM knowledge_documents d
  LEFT JOIN knowledge_document_versions v
    ON v.tenant_id = d.tenant_id AND v.document_id = d.id
   AND v.is_current = true AND v.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT j.id AS processing_job_id, j.job_type AS processing_job_type,
      j.status AS processing_job_status, j.progress AS processing_job_progress,
      j.attempt_count AS processing_job_attempt_count, j.max_attempts AS processing_job_max_attempts,
      j.error_code AS processing_job_error_code, j.error_message AS processing_job_error_message,
      j.created_at AS processing_job_created_at, j.completed_at AS processing_job_completed_at
    FROM knowledge_processing_jobs j
    WHERE j.tenant_id = d.tenant_id AND j.document_id = d.id
      AND j.document_version_id = v.id
    ORDER BY j.created_at DESC
    LIMIT 1
  ) latest_job ON true`;

async function ensureKnowledgeBase(client, auth, knowledgeBaseId) {
  const result = await client.query(
    `SELECT id, status FROM knowledge_bases
      WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
        AND deleted_at IS NULL AND status <> 'deleted'`,
    [auth.tenantId, auth.workspaceId, knowledgeBaseId],
  );
  if (!result.rowCount) throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
  if (result.rows[0].status === 'deleting') {
    throw new AppError(409, 'Documents cannot be uploaded while the Knowledge Base is being deleted', 'KNOWLEDGE_BASE_NOT_EDITABLE');
  }
}

async function documentRow(client, auth, knowledgeBaseId, documentId) {
  const result = await client.query(`${documentSelect}
    WHERE d.tenant_id = $1 AND d.knowledge_base_id = $2 AND d.id = $3
      AND d.deleted_at IS NULL AND d.status <> 'deleted'`,
  [auth.tenantId, knowledgeBaseId, documentId]);
  if (!result.rowCount) throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  return result.rows[0];
}

export function knowledgeDocumentObjectKey({ tenantId, knowledgeBaseId, documentId, versionNumber }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const [name, value] of Object.entries({ tenantId, knowledgeBaseId, documentId })) {
    if (!uuid.test(value)) throw new TypeError(`${name} must be a UUID`);
  }
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new TypeError('versionNumber must be positive');
  return `tenants/${tenantId}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/${versionNumber}/source.pdf`;
}

export function validatePdfFile(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    throw new AppError(400, 'A PDF file is required in the file field', 'PDF_FILE_REQUIRED');
  }
  if (file.mimetype?.toLowerCase() !== 'application/pdf') {
    throw new AppError(400, 'Only application/pdf files are supported', 'PDF_TYPE_INVALID');
  }
  if (path.extname(file.originalname ?? '').toLowerCase() !== '.pdf') {
    throw new AppError(400, 'The uploaded filename must end with .pdf', 'PDF_EXTENSION_INVALID');
  }
  if (file.size < 5 || file.size > env.KNOWLEDGE_PDF_MAX_BYTES) {
    throw new AppError(400, `PDF size must be between 5 and ${env.KNOWLEDGE_PDF_MAX_BYTES} bytes`, 'PDF_SIZE_INVALID');
  }
  if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new AppError(400, 'The uploaded file does not contain a valid PDF signature', 'PDF_SIGNATURE_INVALID');
  }
}

export function listKnowledgeDocuments(auth, knowledgeBaseId, filters, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await ensureKnowledgeBase(client, auth, knowledgeBaseId);
    const values = [auth.tenantId, knowledgeBaseId, filters.documentType ?? null, filters.status ?? null];
    const where = `WHERE d.tenant_id = $1 AND d.knowledge_base_id = $2
      AND d.deleted_at IS NULL AND d.status <> 'deleted'
      AND ($3::knowledge_document_type IS NULL OR d.document_type = $3)
      AND ($4::knowledge_document_status IS NULL OR d.status = $4)`;
    const total = await client.query(`SELECT count(*)::int AS total FROM knowledge_documents d ${where}`, values);
    const result = await client.query(`${documentSelect} ${where}
      ORDER BY d.created_at DESC, d.id LIMIT $5 OFFSET $6`, [
      ...values, filters.pageSize, (filters.page - 1) * filters.pageSize,
    ]);
    return {
      items: result.rows.map(mapDocument),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: total.rows[0].total,
        totalPages: Math.ceil(total.rows[0].total / filters.pageSize),
      },
    };
  });
}

export function getKnowledgeDocument(auth, knowledgeBaseId, documentId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => mapDocument(
    await documentRow(client, auth, knowledgeBaseId, documentId),
  ));
}

export async function uploadKnowledgeDocument(
  auth,
  knowledgeBaseId,
  input,
  file,
  storageAdapter = storage,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
) {
  validatePdfFile(file);
  await contextRunner(auth, (client) => ensureKnowledgeBase(client, auth, knowledgeBaseId));

  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const versionNumber = 1;
  const objectKey = knowledgeDocumentObjectKey({
    tenantId: auth.tenantId,
    knowledgeBaseId,
    documentId,
    versionNumber,
  });
  const checksumSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  let uploaded = false;
  let storedObject;
  let saved;

  try {
    storedObject = await storageAdapter.putObject({
      key: objectKey,
      body: file.buffer,
      contentType: 'application/pdf',
      metadata: {
        tenant_id: auth.tenantId,
        knowledge_base_id: knowledgeBaseId,
        document_id: documentId,
        checksum_sha256: checksumSha256,
      },
    });
    uploaded = true;

    saved = await contextRunner(auth, async (client) => {
      await ensureKnowledgeBase(client, auth, knowledgeBaseId);
      const inferredDisplayName = path.basename(file.originalname, path.extname(file.originalname)).trim();
      const displayName = (input.displayName ?? inferredDisplayName) || 'PDF document';
      await client.query(
        `INSERT INTO knowledge_documents (
           id, tenant_id, knowledge_base_id, document_type, display_name,
           original_filename, mime_type, size_bytes, status, metadata, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, 'queued', $8::jsonb, $9, $9)`,
        [
          documentId, auth.tenantId, knowledgeBaseId, input.documentType, displayName,
          file.originalname.slice(0, 500), file.size, JSON.stringify(input.metadata), auth.userId,
        ],
      );
      await client.query(
        `INSERT INTO knowledge_document_versions (
           id, tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
           b2_bucket, b2_object_key, content_sha256, size_bytes, extraction_metadata, created_by
         ) VALUES ($1, $2, $3, $4, $5, 'queued', true, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          versionId, auth.tenantId, knowledgeBaseId, documentId, versionNumber,
          storedObject.bucket, objectKey, checksumSha256, file.size,
          JSON.stringify({ source: { etag: storedObject.etag, storageVersionId: storedObject.storageVersionId } }), auth.userId,
        ],
      );
      const processingJob = await client.query(
        `INSERT INTO knowledge_processing_jobs (
           tenant_id, knowledge_base_id, document_id, document_version_id,
           job_type, status, queue_name, metadata
         ) VALUES ($1, $2, $3, $4, 'extract', 'queued', 'knowledge-processing', $5::jsonb)
         RETURNING id, max_attempts`,
        [auth.tenantId, knowledgeBaseId, documentId, versionId, JSON.stringify({ documentType: input.documentType })],
      );
      await client.query(
        `UPDATE knowledge_bases
            SET status = 'processing', published_at = NULL, published_by = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, knowledgeBaseId],
      );
      await client.query(
        `INSERT INTO audit_logs (
           tenant_id, workspace_id, actor_user_id, actor_type, action,
           entity_type, entity_id, after_data
         ) VALUES ($1, $2, $3, $4, 'KNOWLEDGE_DOCUMENT_UPLOADED',
           'knowledge_document', $5, $6::jsonb)`,
        [
          auth.tenantId, auth.workspaceId, auth.userId,
          auth.authType === 'api_key' ? 'api' : 'user', documentId,
          JSON.stringify({ knowledgeBaseId, documentType: input.documentType, sizeBytes: file.size, checksumSha256 }),
        ],
      );
      return {
        document: mapDocument(await documentRow(client, auth, knowledgeBaseId, documentId)),
        processingJobId: processingJob.rows[0].id,
        maxAttempts: processingJob.rows[0].max_attempts,
      };
    });
  } catch (error) {
    if (uploaded) {
      try {
        await storageAdapter.deleteObject({ key: objectKey, versionId: storedObject?.storageVersionId });
      } catch (cleanupError) {
        error.cleanupError = cleanupError.message;
      }
    }
    if (error instanceof AppError) throw error;
    if (!uploaded) {
      throw new AppError(502, 'The PDF could not be stored in Backblaze B2', 'B2_UPLOAD_FAILED');
    }
    throw new AppError(500, 'PDF metadata could not be saved; the B2 upload was removed', 'KNOWLEDGE_DOCUMENT_SAVE_FAILED');
  }

  try {
    const queued = await queueAdapter({
      processingJobId: saved.processingJobId,
      maxAttempts: saved.maxAttempts,
    });
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id = $2,
          error_code = NULL, error_message = NULL
        WHERE tenant_id = $1 AND id = $3`,
      [auth.tenantId, queued.id, saved.processingJobId],
    ));
  } catch (error) {
    logger.warn({ err: error, processingJobId: saved.processingJobId }, 'Knowledge job remains queued for reconciliation');
    try {
      await contextRunner(auth, (client) => client.query(
        `UPDATE knowledge_processing_jobs
            SET error_code = 'QUEUE_UNAVAILABLE', error_message = $3
          WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
        [auth.tenantId, saved.processingJobId, String(error.message).slice(0, 4000)],
      ));
    } catch (updateError) {
      logger.warn({ err: updateError, processingJobId: saved.processingJobId }, 'Could not record knowledge queue failure');
    }
  }

  return { ...saved.document, processingJobId: saved.processingJobId };
}

function mapVersion(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    status: row.status,
    isCurrent: row.is_current,
    checksumSha256: row.content_sha256,
    sizeBytes: Number(row.size_bytes),
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    processedAt: row.processed_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
  };
}

export function listKnowledgeDocumentVersions(
  auth,
  knowledgeBaseId,
  documentId,
  contextRunner = withTenantContext,
) {
  return contextRunner(auth, async (client) => {
    await documentRow(client, auth, knowledgeBaseId, documentId);
    const result = await client.query(
      `SELECT * FROM knowledge_document_versions
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
          AND deleted_at IS NULL AND status <> 'deleted'
        ORDER BY version_number DESC`,
      [auth.tenantId, knowledgeBaseId, documentId],
    );
    return result.rows.map(mapVersion);
  });
}

async function enqueueSavedJob(auth, saved, contextRunner, queueAdapter) {
  try {
    const queued = await queueAdapter({
      processingJobId: saved.processingJobId,
      maxAttempts: saved.maxAttempts,
    });
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id=$2,
          error_code=NULL, error_message=NULL WHERE tenant_id=$1 AND id=$3`,
      [auth.tenantId, queued.id, saved.processingJobId],
    ));
  } catch (error) {
    logger.warn({ err: error, processingJobId: saved.processingJobId }, 'Knowledge version job remains queued for reconciliation');
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET error_code='QUEUE_UNAVAILABLE', error_message=$3
        WHERE tenant_id=$1 AND id=$2 AND status='queued'`,
      [auth.tenantId, saved.processingJobId, String(error.message).slice(0, 4000)],
    )).catch((updateError) => logger.warn({ err: updateError }, 'Could not record version queue failure'));
  }
}

export async function uploadKnowledgeDocumentVersion(
  auth,
  knowledgeBaseId,
  documentId,
  input,
  file,
  storageAdapter = storage,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
) {
  validatePdfFile(file);
  if (!env.B2_BUCKET) throw new AppError(503, 'B2 storage is not configured', 'B2_NOT_CONFIGURED');
  const checksumSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const reserved = await contextRunner(auth, async (client) => {
    const document = await client.query(
      `SELECT d.*, v.content_sha256 AS current_checksum
         FROM knowledge_documents d
         LEFT JOIN knowledge_document_versions v
           ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.is_current=true AND v.deleted_at IS NULL
        WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3
          AND d.deleted_at IS NULL AND d.status <> 'deleted'
        FOR UPDATE OF d`,
      [auth.tenantId, knowledgeBaseId, documentId],
    );
    if (!document.rowCount) throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    if (['uploading', 'queued', 'processing', 'deleting'].includes(document.rows[0].status)) {
      throw new AppError(409, 'Knowledge document is busy', 'KNOWLEDGE_DOCUMENT_BUSY');
    }
    if (document.rows[0].current_checksum === checksumSha256) {
      throw new AppError(409, 'Uploaded PDF is identical to the current version', 'KNOWLEDGE_VERSION_UNCHANGED');
    }
    const versionNumber = (await client.query(
      `SELECT COALESCE(max(version_number),0)::int + 1 AS next_version
         FROM knowledge_document_versions WHERE tenant_id=$1 AND document_id=$2`,
      [auth.tenantId, documentId],
    )).rows[0].next_version;
    const versionId = crypto.randomUUID();
    const objectKey = knowledgeDocumentObjectKey({
      tenantId: auth.tenantId, knowledgeBaseId, documentId, versionNumber,
    });
    await client.query(
      `INSERT INTO knowledge_document_versions (
         id, tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
         b2_bucket, b2_object_key, content_sha256, size_bytes, extraction_metadata, created_by
       ) VALUES ($1,$2,$3,$4,$5,'uploaded',false,$6,$7,$8,$9,'{}'::jsonb,$10)`,
      [
        versionId, auth.tenantId, knowledgeBaseId, documentId, versionNumber,
        env.B2_BUCKET, objectKey, checksumSha256, file.size, auth.userId,
      ],
    );
    return {
      versionId, versionNumber, objectKey, documentType: document.rows[0].document_type,
    };
  });

  let storedObject;
  try {
    storedObject = await storageAdapter.putObject({
      key: reserved.objectKey,
      body: file.buffer,
      contentType: 'application/pdf',
      metadata: {
        tenant_id: auth.tenantId,
        knowledge_base_id: knowledgeBaseId,
        document_id: documentId,
        document_version_id: reserved.versionId,
        checksum_sha256: checksumSha256,
      },
    });
  } catch (error) {
    await contextRunner(auth, (client) => client.query(
      'DELETE FROM knowledge_document_versions WHERE tenant_id=$1 AND id=$2 AND is_current=false',
      [auth.tenantId, reserved.versionId],
    )).catch(() => {});
    throw new AppError(502, 'The replacement PDF could not be stored in Backblaze B2', 'B2_UPLOAD_FAILED');
  }

  let saved;
  try {
    saved = await contextRunner(auth, async (client) => {
      const locked = await client.query(
        `SELECT id FROM knowledge_document_versions
          WHERE tenant_id=$1 AND id=$2 AND is_current=false AND status='uploaded' FOR UPDATE`,
        [auth.tenantId, reserved.versionId],
      );
      if (!locked.rowCount) throw new AppError(409, 'Reserved document version changed', 'KNOWLEDGE_VERSION_STATE_CHANGED');
      await client.query(
        `UPDATE knowledge_document_versions
            SET is_current=false, status=CASE WHEN status='deleted' THEN status ELSE 'archived' END
          WHERE tenant_id=$1 AND document_id=$2 AND is_current=true`,
        [auth.tenantId, documentId],
      );
      await client.query(
        `UPDATE knowledge_document_versions
            SET is_current=true, status='queued', extraction_metadata=$3::jsonb
          WHERE tenant_id=$1 AND id=$2`,
        [auth.tenantId, reserved.versionId, JSON.stringify({
          source: { etag: storedObject.etag, storageVersionId: storedObject.storageVersionId },
        })],
      );
      const displayName = input.displayName ?? null;
      await client.query(
        `UPDATE knowledge_documents SET status='queued', original_filename=$4, size_bytes=$5,
            metadata=metadata || $6::jsonb, updated_by=$7,
            display_name=COALESCE($8, display_name)
          WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3`,
        [
          auth.tenantId, knowledgeBaseId, documentId, file.originalname.slice(0, 500), file.size,
          JSON.stringify(input.metadata), auth.userId, displayName,
        ],
      );
      const job = await client.query(
        `INSERT INTO knowledge_processing_jobs (
           tenant_id, knowledge_base_id, document_id, document_version_id,
           job_type, status, queue_name, metadata
         ) VALUES ($1,$2,$3,$4,'extract','queued','knowledge-processing',$5::jsonb)
         RETURNING id, max_attempts`,
        [
          auth.tenantId, knowledgeBaseId, documentId, reserved.versionId,
          JSON.stringify({ documentType: reserved.documentType, versionNumber: reserved.versionNumber }),
        ],
      );
      await client.query(
        `UPDATE knowledge_bases SET status='processing', published_at=NULL, published_by=NULL
          WHERE tenant_id=$1 AND id=$2`,
        [auth.tenantId, knowledgeBaseId],
      );
      await client.query(
        `INSERT INTO audit_logs (
           tenant_id, workspace_id, actor_user_id, actor_type, action,
           entity_type, entity_id, after_data
         ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_DOCUMENT_VERSION_UPLOADED',
           'knowledge_document_version',$5,$6::jsonb)`,
        [
          auth.tenantId, auth.workspaceId, auth.userId,
          auth.authType === 'api_key' ? 'api' : 'user', reserved.versionId,
          JSON.stringify({ documentId, knowledgeBaseId, versionNumber: reserved.versionNumber, checksumSha256 }),
        ],
      );
      return {
        processingJobId: job.rows[0].id,
        maxAttempts: job.rows[0].max_attempts,
      };
    });
  } catch (error) {
    await storageAdapter.deleteAllVersions({ key: reserved.objectKey }).catch(() => {});
    await contextRunner(auth, (client) => client.query(
      'DELETE FROM knowledge_document_versions WHERE tenant_id=$1 AND id=$2 AND is_current=false',
      [auth.tenantId, reserved.versionId],
    )).catch(() => {});
    throw error;
  }

  await enqueueSavedJob(auth, saved, contextRunner, queueAdapter);
  await invalidateTenantKnowledgeCache(auth.tenantId);
  return {
    document: await getKnowledgeDocument(auth, knowledgeBaseId, documentId, contextRunner),
    version: {
      id: reserved.versionId,
      versionNumber: reserved.versionNumber,
      status: 'queued',
      isCurrent: true,
    },
    processingJobId: saved.processingJobId,
  };
}

export async function deleteKnowledgeDocumentVersion(
  auth,
  knowledgeBaseId,
  documentId,
  versionId,
  storageAdapter = storage,
  contextRunner = withTenantContext,
  vectorDelete = deleteTenantPointsByDocumentVersion,
) {
  const version = await contextRunner(auth, async (client) => {
    await documentRow(client, auth, knowledgeBaseId, documentId);
    const result = await client.query(
      `SELECT * FROM knowledge_document_versions
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3 AND id=$4
          AND deleted_at IS NULL AND status <> 'deleted' FOR UPDATE`,
      [auth.tenantId, knowledgeBaseId, documentId, versionId],
    );
    if (!result.rowCount) throw new AppError(404, 'Document version was not found', 'KNOWLEDGE_VERSION_NOT_FOUND');
    if (result.rows[0].is_current) {
      throw new AppError(409, 'Current version cannot be deleted separately', 'KNOWLEDGE_CURRENT_VERSION_DELETE_FORBIDDEN');
    }
    await client.query(
      `UPDATE knowledge_document_versions SET status='deleting' WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, versionId],
    );
    return result.rows[0];
  });
  await vectorDelete(auth.tenantId, versionId);
  await storageAdapter.deleteAllVersions({ key: version.b2_object_key });
  if (version.extracted_text_object_key) {
    await storageAdapter.deleteAllVersions({ key: version.extracted_text_object_key });
  }
  await contextRunner(auth, async (client) => {
    await client.query(
      `DELETE FROM knowledge_document_versions
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3 AND id=$4 AND is_current=false`,
      [auth.tenantId, knowledgeBaseId, documentId, versionId],
    );
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, before_data
       ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_DOCUMENT_VERSION_DELETED',
         'knowledge_document_version',$5,$6::jsonb)`,
      [
        auth.tenantId, auth.workspaceId, auth.userId,
        auth.authType === 'api_key' ? 'api' : 'user', versionId,
        JSON.stringify({ documentId, knowledgeBaseId, versionNumber: version.version_number }),
      ],
    );
  });
  await invalidateTenantKnowledgeCache(auth.tenantId);
  return { id: versionId, versionNumber: version.version_number, deleted: true };
}

export async function activateKnowledgeDocumentVersion(
  auth,
  knowledgeBaseId,
  documentId,
  versionId,
  contextRunner = withTenantContext,
) {
  const activated = await contextRunner(auth, async (client) => {
    const document = await client.query(
      `SELECT id FROM knowledge_documents
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3
          AND deleted_at IS NULL AND status <> 'deleted' FOR UPDATE`,
      [auth.tenantId, knowledgeBaseId, documentId],
    );
    if (!document.rowCount) throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    const target = await client.query(
      `SELECT * FROM knowledge_document_versions
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3 AND id=$4
          AND deleted_at IS NULL AND status IN ('ready','archived') FOR UPDATE`,
      [auth.tenantId, knowledgeBaseId, documentId, versionId],
    );
    if (!target.rowCount) {
      throw new AppError(409, 'Only a processed ready or archived version can be activated', 'KNOWLEDGE_VERSION_NOT_ACTIVATABLE');
    }
    if (target.rows[0].is_current) return mapVersion(target.rows[0]);
    if (!target.rows[0].processed_at) {
      throw new AppError(409, 'Unprocessed version cannot be activated', 'KNOWLEDGE_VERSION_NOT_PROCESSED');
    }
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='cancelled', completed_at=now(),
          error_code='KNOWLEDGE_VERSION_REPLACED', error_message='Another document version was activated'
        WHERE tenant_id=$1 AND document_id=$2 AND status IN ('queued','running')`,
      [auth.tenantId, documentId],
    );
    await client.query(
      `UPDATE knowledge_document_versions SET is_current=false,
          status=CASE WHEN status='deleted' THEN status ELSE 'archived' END
        WHERE tenant_id=$1 AND document_id=$2 AND is_current=true`,
      [auth.tenantId, documentId],
    );
    const updated = await client.query(
      `UPDATE knowledge_document_versions SET is_current=true, status='ready', activated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [auth.tenantId, versionId],
    );
    await client.query(
      `UPDATE knowledge_documents SET status='ready', updated_by=$3
        WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, documentId, auth.userId],
    );
    await client.query(
      `UPDATE knowledge_bases SET status='ready', published_at=NULL, published_by=NULL, updated_by=$3
        WHERE tenant_id=$1 AND id=$2 AND status <> 'deleted'`,
      [auth.tenantId, knowledgeBaseId, auth.userId],
    );
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, after_data
       ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_DOCUMENT_VERSION_ACTIVATED',
         'knowledge_document_version',$5,$6::jsonb)`,
      [
        auth.tenantId, auth.workspaceId, auth.userId,
        auth.authType === 'api_key' ? 'api' : 'user', versionId,
        JSON.stringify({ documentId, knowledgeBaseId, versionNumber: target.rows[0].version_number }),
      ],
    );
    return mapVersion(updated.rows[0]);
  });
  await invalidateTenantKnowledgeCache(auth.tenantId);
  return activated;
}
