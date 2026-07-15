import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  createDeveloperSchema,
  developerIdSchema,
  developerStatusSchema,
  listDevelopersSchema,
  parseDeveloperInput,
  updateDeveloperSchema,
} from './developer.schemas.js';
import {
  createDeveloper,
  deleteDeveloper,
  getDeveloper,
  listDevelopers,
  updateDeveloper,
  updateDeveloperStatus,
} from './developer.service.js';

export const developerRouter = Router();
developerRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));

function valid(schema, value) {
  const parsed = parseDeveloperInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

function metadata(request) {
  return {
    requestId: request.id,
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
  };
}

developerRouter.get('/', async (request, response) => {
  const filters = valid(listDevelopersSchema, request.query);
  response.json({ success: true, data: await listDevelopers(request.auth.userId, filters) });
});

developerRouter.post('/', async (request, response) => {
  const input = valid(createDeveloperSchema, request.body);
  const developer = await createDeveloper(request.auth.userId, input, metadata(request));
  response.status(201).json({ success: true, data: developer });
});

developerRouter.get('/:developerId', async (request, response) => {
  const { developerId } = valid(developerIdSchema, request.params);
  response.json({ success: true, data: await getDeveloper(request.auth.userId, developerId) });
});

developerRouter.patch('/:developerId', async (request, response) => {
  const { developerId } = valid(developerIdSchema, request.params);
  const input = valid(updateDeveloperSchema, request.body);
  response.json({
    success: true,
    data: await updateDeveloper(request.auth.userId, developerId, input, metadata(request)),
  });
});

developerRouter.patch('/:developerId/status', async (request, response) => {
  const { developerId } = valid(developerIdSchema, request.params);
  const { status } = valid(developerStatusSchema, request.body);
  response.json({
    success: true,
    data: await updateDeveloperStatus(request.auth.userId, developerId, status, metadata(request)),
  });
});

developerRouter.delete('/:developerId', async (request, response) => {
  const { developerId } = valid(developerIdSchema, request.params);
  response.json({
    success: true,
    data: await deleteDeveloper(request.auth.userId, developerId, metadata(request)),
  });
});
