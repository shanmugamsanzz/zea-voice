import { Router } from 'express';
import multer from 'multer';
import { requireRoles } from '../auth/auth.middleware.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import {
  knowledgeDocumentParamsSchema,
  knowledgeVersionParamsSchema,
  listKnowledgeDocumentsSchema,
  parseKnowledgeDocumentInput,
  uploadKnowledgeDocumentSchema,
  uploadKnowledgeDocumentVersionSchema,
} from './knowledge-document.schemas.js';
import {
  getKnowledgeDocument,
  activateKnowledgeDocumentVersion,
  deleteKnowledgeDocumentVersion,
  listKnowledgeDocuments,
  listKnowledgeDocumentVersions,
  uploadKnowledgeDocument,
  uploadKnowledgeDocumentVersion,
} from './knowledge-document.service.js';
import {
  parseKnowledgeReviewInput,
  reviewDecisionSchema,
  reviewParamsSchema,
  updateReviewRecordSchema,
} from './knowledge-review.schemas.js';
import {
  decideReviewRecord,
  getDocumentReview,
  updateReviewRecord,
} from './knowledge-review.service.js';
import { requestDeleteKnowledgeDocument } from './knowledge-deletion.service.js';

function valid(schema, value) {
  const parsed = parseKnowledgeDocumentInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

function auth(request) {
  return {
    ...request.auth,
    tenantId: request.tenant.tenantId,
    workspaceId: request.tenant.workspaceId,
  };
}

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: env.KNOWLEDGE_PDF_MAX_BYTES, fields: 10 },
});

function receivePdf(request, response, next) {
  multipart.single('file')(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `PDF must not exceed ${env.KNOWLEDGE_PDF_MAX_BYTES} bytes`
        : error.message;
      next(new AppError(400, message, 'PDF_MULTIPART_INVALID'));
      return;
    }
    next(error);
  });
}

const canUpload = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');
const canReview = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');
export const knowledgeDocumentRouter = Router({ mergeParams: true });

knowledgeDocumentRouter.get('/', async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeDocumentParamsSchema, request.params);
  const filters = valid(listKnowledgeDocumentsSchema, request.query);
  response.json({ success: true, data: await listKnowledgeDocuments(auth(request), knowledgeBaseId, filters) });
});

knowledgeDocumentRouter.get('/:documentId', async (request, response) => {
  const { knowledgeBaseId, documentId } = valid(knowledgeDocumentParamsSchema, request.params);
  response.json({ success: true, data: await getKnowledgeDocument(auth(request), knowledgeBaseId, documentId) });
});

knowledgeDocumentRouter.get('/:documentId/versions', async (request, response) => {
  const { knowledgeBaseId, documentId } = valid(knowledgeVersionParamsSchema, request.params);
  response.json({
    success: true,
    data: await listKnowledgeDocumentVersions(auth(request), knowledgeBaseId, documentId),
  });
});

knowledgeDocumentRouter.post('/:documentId/versions', canUpload, receivePdf, async (request, response) => {
  const { knowledgeBaseId, documentId } = valid(knowledgeVersionParamsSchema, request.params);
  const input = valid(uploadKnowledgeDocumentVersionSchema, request.body);
  const data = await uploadKnowledgeDocumentVersion(
    auth(request), knowledgeBaseId, documentId, input, request.file,
  );
  response.status(201).json({ success: true, data });
});

knowledgeDocumentRouter.delete('/:documentId/versions/:versionId', canUpload, async (request, response) => {
  const { knowledgeBaseId, documentId, versionId } = valid(knowledgeVersionParamsSchema, request.params);
  response.json({
    success: true,
    data: await deleteKnowledgeDocumentVersion(
      auth(request), knowledgeBaseId, documentId, versionId,
    ),
  });
});

knowledgeDocumentRouter.post('/:documentId/versions/:versionId/activate', canUpload, async (request, response) => {
  const { knowledgeBaseId, documentId, versionId } = valid(knowledgeVersionParamsSchema, request.params);
  response.json({
    success: true,
    data: await activateKnowledgeDocumentVersion(
      auth(request), knowledgeBaseId, documentId, versionId,
    ),
  });
});

knowledgeDocumentRouter.delete('/:documentId', canUpload, async (request, response) => {
  const { knowledgeBaseId, documentId } = valid(knowledgeVersionParamsSchema, request.params);
  response.json({
    success: true,
    data: await requestDeleteKnowledgeDocument(auth(request), knowledgeBaseId, documentId),
  });
});

knowledgeDocumentRouter.get('/:documentId/review', async (request, response) => {
  const parsed = parseKnowledgeReviewInput(reviewParamsSchema, request.params);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  const { knowledgeBaseId, documentId } = parsed.data;
  response.json({ success: true, data: await getDocumentReview(auth(request), knowledgeBaseId, documentId) });
});

knowledgeDocumentRouter.patch('/:documentId/review/:recordId', canReview, async (request, response) => {
  const params = parseKnowledgeReviewInput(reviewParamsSchema, request.params);
  const body = parseKnowledgeReviewInput(updateReviewRecordSchema, request.body);
  if (!params.success || !body.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', [
      ...(params.issues ?? []), ...(body.issues ?? []),
    ]);
  }
  const { knowledgeBaseId, documentId, recordId } = params.data;
  response.json({
    success: true,
    data: await updateReviewRecord(auth(request), knowledgeBaseId, documentId, recordId, body.data),
  });
});

knowledgeDocumentRouter.post('/:documentId/review/:recordId/decision', canReview, async (request, response) => {
  const params = parseKnowledgeReviewInput(reviewParamsSchema, request.params);
  const body = parseKnowledgeReviewInput(reviewDecisionSchema, request.body);
  if (!params.success || !body.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', [
      ...(params.issues ?? []), ...(body.issues ?? []),
    ]);
  }
  const { knowledgeBaseId, documentId, recordId } = params.data;
  response.json({
    success: true,
    data: await decideReviewRecord(
      auth(request), knowledgeBaseId, documentId, recordId, body.data.decision,
    ),
  });
});

knowledgeDocumentRouter.post('/', canUpload, receivePdf, async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeDocumentParamsSchema, request.params);
  const input = valid(uploadKnowledgeDocumentSchema, request.body);
  const data = await uploadKnowledgeDocument(auth(request), knowledgeBaseId, input, request.file);
  response.status(201).json({ success: true, data });
});
