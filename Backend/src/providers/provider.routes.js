import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  createModelSchema, createProviderSchema, listProvidersSchema, modelIdSchema,
  modelStatusSchema, parseProviderInput, providerIdSchema, providerStatusSchema,
  updateModelSchema, updateProviderSchema,
} from './provider.schemas.js';
import {
  createProvider, createProviderModel, deleteProvider, getProviderCatalog, listProviderModels, listProviders,
  updateProviderModel, updateModelStatus, updateProvider, updateProviderStatus,
} from './provider.service.js';

function valid(schema, value) {
  const parsed = parseProviderInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const providerRouter = Router();
providerRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
providerRouter.get('/', async (req, res) => res.json({ success: true, data: await listProviders(req.auth.userId, valid(listProvidersSchema, req.query)) }));
providerRouter.post('/', async (req, res) => res.status(201).json({ success: true, data: await createProvider(req.auth.userId, valid(createProviderSchema, req.body)) }));
providerRouter.patch('/:providerId', async (req, res) => {
  const { providerId } = valid(providerIdSchema, req.params);
  res.json({ success: true, data: await updateProvider(req.auth.userId, providerId, valid(updateProviderSchema, req.body)) });
});
providerRouter.delete('/:providerId', async (req, res) => {
  const { providerId } = valid(providerIdSchema, req.params);
  res.json({ success: true, data: await deleteProvider(req.auth.userId, providerId) });
});
providerRouter.patch('/:providerId/status', async (req, res) => {
  const { providerId } = valid(providerIdSchema, req.params);
  const { status } = valid(providerStatusSchema, req.body);
  res.json({ success: true, data: await updateProviderStatus(req.auth.userId, providerId, status) });
});
providerRouter.post('/:providerId/models', async (req, res) => {
  const { providerId } = valid(providerIdSchema, req.params);
  res.status(201).json({ success: true, data: await createProviderModel(req.auth.userId, providerId, valid(createModelSchema, req.body)) });
});
providerRouter.get('/:providerId/models', async (req, res) => {
  const { providerId } = valid(providerIdSchema, req.params);
  res.json({ success: true, data: await listProviderModels(req.auth.userId, providerId) });
});
providerRouter.patch('/models/:modelId', async (req, res) => {
  const { modelId } = valid(modelIdSchema, req.params);
  res.json({ success: true, data: await updateProviderModel(req.auth.userId, modelId, valid(updateModelSchema, req.body)) });
});
providerRouter.patch('/models/:modelId/status', async (req, res) => {
  const { modelId } = valid(modelIdSchema, req.params);
  const { status } = valid(modelStatusSchema, req.body);
  res.json({ success: true, data: await updateModelStatus(req.auth.userId, modelId, status) });
});

export const catalogRouter = Router();
catalogRouter.use(authenticateRequest);
catalogRouter.get('/providers', async (req, res) => {
  const { type } = valid(listProvidersSchema.pick({ type: true }), req.query);
  res.json({ success: true, data: await getProviderCatalog(req.auth, type) });
});
