import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { callIdSchema, forceHangupSchema, listCallsSchema, parseCallInput } from './call.schemas.js';
import { forceHangup, getCall, listCalls } from './call.service.js';
import { tenantProviderHealth } from '../voice/provider-health.service.js';
import { loadStoredCallRecording } from '../telephony/plivo-recording.service.js';

function valid(schema, value) {
  const parsed = parseCallInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const callAdminRouter = Router();
callAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
callAdminRouter.get('/', async (req, res) => res.json({ success: true, data: await listCalls(req.auth, valid(listCallsSchema, req.query)) }));
callAdminRouter.get('/:callId', async (req, res) => {
  const { callId } = valid(callIdSchema, req.params);
  res.json({ success: true, data: await getCall(req.auth, callId) });
});
callAdminRouter.get('/:callId/recording', async (req, res) => {
  const { callId } = valid(callIdSchema, req.params);
  const recording = await loadStoredCallRecording(req.auth, callId);
  res.set({
    'Content-Type': recording.contentType || 'audio/mpeg',
    'Content-Length': String(recording.body.length),
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `inline; filename="call-${callId}.mp3"`,
    'X-Content-Type-Options': 'nosniff',
  }).send(recording.body);
});
callAdminRouter.post('/:callId/hangup', async (req, res) => {
  const { callId } = valid(callIdSchema, req.params);
  const { reason } = valid(forceHangupSchema, req.body);
  res.json({ success: true, data: await forceHangup(req.auth.userId, callId, reason) });
});

export const tenantCallRouter = Router();
tenantCallRouter.use(authenticateRequest, requireTenantContext);
tenantCallRouter.get('/runtime/provider-health', async (req, res) => res.json({
  success: true,
  data: tenantProviderHealth.snapshot(req.tenant.tenantId),
}));
tenantCallRouter.get('/', async (req, res) => res.json({ success: true, data: await listCalls(req.auth, valid(listCallsSchema.omit({ companyId: true }), req.query)) }));
tenantCallRouter.get('/:callId', async (req, res) => {
  const { callId } = valid(callIdSchema, req.params);
  res.json({ success: true, data: await getCall(req.auth, callId) });
});
tenantCallRouter.get('/:callId/recording', async (req, res) => {
  const { callId } = valid(callIdSchema, req.params);
  const recording = await loadStoredCallRecording(req.auth, callId);
  res.set({
    'Content-Type': recording.contentType || 'audio/mpeg',
    'Content-Length': String(recording.body.length),
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `inline; filename="call-${callId}.mp3"`,
    'X-Content-Type-Options': 'nosniff',
  }).send(recording.body);
});
