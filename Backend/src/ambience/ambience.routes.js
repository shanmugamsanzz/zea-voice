import { Router } from 'express';
import multer from 'multer';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import {
  ambienceAssetIdSchema,
  createAmbienceAssetSchema,
  listAmbienceAssetsSchema,
  parseAmbienceInput,
  updateAmbienceAssetSchema,
} from './ambience.schemas.js';
import {
  createAmbienceAsset,
  deleteAmbienceAsset,
  getAmbienceAsset,
  listAmbienceAssets,
  updateAmbienceAsset,
} from './ambience.service.js';
import { getAmbienceAudio, uploadAmbienceAudio } from './ambience-storage.service.js';

function valid(schema, value) {
  const parsed = parseAmbienceInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

function auth(request) {
  return { ...request.auth, tenantId: request.tenant.tenantId, workspaceId: request.tenant.workspaceId };
}

export const ambienceRouter = Router();
ambienceRouter.use(authenticateRequest, requireTenantContext, requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'));

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: env.AMBIENCE_AUDIO_MAX_BYTES, fields: 2, fieldSize: 1024 },
});

function receiveAudio(request, response, next) {
  multipart.single('file')(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `Ambience audio must not exceed ${env.AMBIENCE_AUDIO_MAX_BYTES} bytes`
        : 'The ambience audio multipart request is invalid';
      next(new AppError(400, message, 'AMBIENCE_MULTIPART_INVALID'));
      return;
    }
    next(error);
  });
}

ambienceRouter.get('/', async (request, response) => {
  response.json({ success: true, data: await listAmbienceAssets(auth(request), valid(listAmbienceAssetsSchema, request.query)) });
});

ambienceRouter.post('/', async (request, response) => {
  const data = await createAmbienceAsset(auth(request), valid(createAmbienceAssetSchema, request.body));
  response.status(201).json({ success: true, data });
});

ambienceRouter.post('/:assetId/audio', receiveAudio, async (request, response) => {
  const { assetId } = valid(ambienceAssetIdSchema, request.params);
  response.json({ success: true, data: await uploadAmbienceAudio(auth(request), assetId, request.file) });
});

ambienceRouter.get('/:assetId/audio', async (request, response) => {
  const { assetId } = valid(ambienceAssetIdSchema, request.params);
  const audio = await getAmbienceAudio(auth(request), assetId);
  response.setHeader('content-type', audio.mimeType);
  response.setHeader('content-length', audio.body.length);
  response.setHeader('cache-control', 'private, max-age=300');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(audio.fileName || 'ambience-audio')}`);
  response.end(audio.body);
});

ambienceRouter.get('/:assetId', async (request, response) => {
  const { assetId } = valid(ambienceAssetIdSchema, request.params);
  response.json({ success: true, data: await getAmbienceAsset(auth(request), assetId) });
});

ambienceRouter.patch('/:assetId', async (request, response) => {
  const { assetId } = valid(ambienceAssetIdSchema, request.params);
  response.json({ success: true, data: await updateAmbienceAsset(auth(request), assetId, valid(updateAmbienceAssetSchema, request.body)) });
});

ambienceRouter.delete('/:assetId', async (request, response) => {
  const { assetId } = valid(ambienceAssetIdSchema, request.params);
  response.json({ success: true, data: await deleteAmbienceAsset(auth(request), assetId) });
});
