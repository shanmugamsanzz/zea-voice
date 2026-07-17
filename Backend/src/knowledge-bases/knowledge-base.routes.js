import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  createKnowledgeBaseSchema,
  knowledgeBaseIdSchema,
  listKnowledgeBasesSchema,
  parseKnowledgeBaseInput,
  updateKnowledgeBaseSchema,
} from './knowledge-base.schemas.js';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from './knowledge-base.service.js';
import { knowledgeDocumentRouter } from './knowledge-document.routes.js';
import { getKnowledgeBaseReviewSummary, publishKnowledgeBase } from './knowledge-review.service.js';
import { runtimeKnowledgeQuerySchema } from './knowledge-runtime.schemas.js';
import { routeKnowledgeQuery } from './knowledge-runtime.service.js';

function valid(schema, value) {
  const parsed = parseKnowledgeBaseInput(schema, value);
  if (!parsed.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  }
  return parsed.data;
}

function auth(request) {
  return {
    ...request.auth,
    tenantId: request.tenant.tenantId,
    workspaceId: request.tenant.workspaceId,
  };
}

const canManageKnowledgeBases = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');

export const knowledgeBaseRouter = Router();
knowledgeBaseRouter.use(authenticateRequest, requireTenantContext);
knowledgeBaseRouter.use('/:knowledgeBaseId/documents', knowledgeDocumentRouter);

knowledgeBaseRouter.post('/runtime/query', async (request, response) => {
  const input = valid(runtimeKnowledgeQuerySchema, request.body);
  response.json({ success: true, data: await routeKnowledgeQuery(auth(request), input) });
});

knowledgeBaseRouter.get('/', async (request, response) => {
  const filters = valid(listKnowledgeBasesSchema, request.query);
  response.json({ success: true, data: await listKnowledgeBases(auth(request), filters) });
});

knowledgeBaseRouter.get('/:knowledgeBaseId', async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  response.json({ success: true, data: await getKnowledgeBase(auth(request), knowledgeBaseId) });
});

knowledgeBaseRouter.get('/:knowledgeBaseId/review-summary', async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  response.json({ success: true, data: await getKnowledgeBaseReviewSummary(auth(request), knowledgeBaseId) });
});

knowledgeBaseRouter.post('/:knowledgeBaseId/publish', canManageKnowledgeBases, async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  response.json({ success: true, data: await publishKnowledgeBase(auth(request), knowledgeBaseId) });
});

knowledgeBaseRouter.post('/', canManageKnowledgeBases, async (request, response) => {
  const input = valid(createKnowledgeBaseSchema, request.body);
  response.status(201).json({ success: true, data: await createKnowledgeBase(auth(request), input) });
});

knowledgeBaseRouter.patch('/:knowledgeBaseId', canManageKnowledgeBases, async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  const input = valid(updateKnowledgeBaseSchema, request.body);
  response.json({ success: true, data: await updateKnowledgeBase(auth(request), knowledgeBaseId, input) });
});

knowledgeBaseRouter.put('/:knowledgeBaseId', canManageKnowledgeBases, async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  const input = valid(updateKnowledgeBaseSchema, request.body);
  response.json({ success: true, data: await updateKnowledgeBase(auth(request), knowledgeBaseId, input) });
});

knowledgeBaseRouter.delete('/:knowledgeBaseId', canManageKnowledgeBases, async (request, response) => {
  const { knowledgeBaseId } = valid(knowledgeBaseIdSchema, request.params);
  response.json({ success: true, data: await deleteKnowledgeBase(auth(request), knowledgeBaseId) });
});
