import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  createPronunciationGroupSchema,
  createPronunciationRuleSchema,
  listPronunciationGroupsSchema,
  parsePronunciationInput,
  pronunciationGroupIdSchema,
  pronunciationRuleIdSchema,
  updatePronunciationGroupSchema,
  updatePronunciationRuleSchema,
} from './pronunciation.schemas.js';
import {
  createPronunciationGroup,
  createPronunciationRule,
  deletePronunciationGroup,
  deletePronunciationRule,
  getPronunciationGroup,
  listPronunciationGroups,
  updatePronunciationGroup,
  updatePronunciationRule,
} from './pronunciation.service.js';

function valid(schema, value) {
  const parsed = parsePronunciationInput(schema, value);
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

const writers = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');

export const pronunciationRouter = Router();
pronunciationRouter.use(authenticateRequest, requireTenantContext);

pronunciationRouter.get('/', async (request, response) => {
  response.json({
    success: true,
    data: await listPronunciationGroups(auth(request), valid(listPronunciationGroupsSchema, request.query)),
  });
});

pronunciationRouter.post('/', writers, async (request, response) => {
  const data = await createPronunciationGroup(auth(request), valid(createPronunciationGroupSchema, request.body));
  response.status(201).json({ success: true, data });
});

pronunciationRouter.get('/:groupId', async (request, response) => {
  const { groupId } = valid(pronunciationGroupIdSchema, request.params);
  response.json({ success: true, data: await getPronunciationGroup(auth(request), groupId) });
});

pronunciationRouter.patch('/:groupId', writers, async (request, response) => {
  const { groupId } = valid(pronunciationGroupIdSchema, request.params);
  const input = valid(updatePronunciationGroupSchema, request.body);
  response.json({ success: true, data: await updatePronunciationGroup(auth(request), groupId, input) });
});

pronunciationRouter.delete('/:groupId', writers, async (request, response) => {
  const { groupId } = valid(pronunciationGroupIdSchema, request.params);
  response.json({ success: true, data: await deletePronunciationGroup(auth(request), groupId) });
});

pronunciationRouter.post('/:groupId/rules', writers, async (request, response) => {
  const { groupId } = valid(pronunciationGroupIdSchema, request.params);
  const input = valid(createPronunciationRuleSchema, request.body);
  response.status(201).json({ success: true, data: await createPronunciationRule(auth(request), groupId, input) });
});

pronunciationRouter.patch('/:groupId/rules/:ruleId', writers, async (request, response) => {
  const { groupId, ruleId } = valid(pronunciationRuleIdSchema, request.params);
  const input = valid(updatePronunciationRuleSchema, request.body);
  response.json({
    success: true,
    data: await updatePronunciationRule(auth(request), groupId, ruleId, input),
  });
});

pronunciationRouter.delete('/:groupId/rules/:ruleId', writers, async (request, response) => {
  const { groupId, ruleId } = valid(pronunciationRuleIdSchema, request.params);
  response.json({ success: true, data: await deletePronunciationRule(auth(request), groupId, ruleId) });
});
