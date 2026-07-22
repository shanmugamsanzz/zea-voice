import { Router } from 'express';
import { AppError } from '../middleware/errors.js';
import { buildPlivoStreamXml, validateIncomingPlivoCall } from './plivo-answer.service.js';
import { resolvePhoneNumberAgent } from './agent-resolver.service.js';
import { createVoiceCallSession, saveVoiceCallPreCallResult } from './call-session-store.js';
import { plivoAnswerPayloadSchema } from './voice.schemas.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';
import { assertRuntimeAdapterCompatibility } from './providers/registry.js';
import { registerImplementedProviderAdapters } from './providers/defaults.js';
import { executePreCall } from './integrations/precall.service.js';
import { voiceCallOwnership } from './call-ownership.service.js';

export const voiceRouter = Router();

function maskedPhone(value) {
  const phone = String(value ?? '');
  return phone.length > 4 ? `${phone.slice(0, 3)}***${phone.slice(-4)}` : '[unknown]';
}

function providerLog(request, icon, stage, callId, provider) {
  request.log.info({
    icon,
    stage,
    callId,
    providerId: provider.providerId,
    providerName: provider.providerName,
    modelId: provider.modelId,
    modelKey: provider.modelKey,
    runtimeStatus: 'configured_not_started',
  }, `${icon} ${stage.toUpperCase()} provider selected (audio runtime not started)`);
}

voiceRouter.post('/answer', async (request, response) => {
  const parsed = plivoAnswerPayloadSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'Invalid Plivo answer payload', 'VALIDATION_ERROR', parsed.error.issues);
  }
  request.log.info({
    icon: '📞',
    stage: 'call.received',
    direction: parsed.data.Direction ?? 'inbound',
    providerCallId: parsed.data.CallUUID,
    from: maskedPhone(parsed.data.From),
    to: maskedPhone(parsed.data.To),
  }, `📞 ${(parsed.data.Direction ?? 'inbound').toUpperCase()} call received from Plivo`);
  const call = await validateIncomingPlivoCall({
    payload: parsed.data,
    rawPayload: request.body ?? {},
    signature: request.get('x-plivo-signature-v3'),
    mainSignature: request.get('x-plivo-signature-ma-v3'),
    nonce: request.get('x-plivo-signature-v3-nonce'),
  });
  request.log.info({
    icon: '🔐', stage: 'plivo.verified', providerCallId: call.providerCallId,
    phoneNumberId: call.phoneNumberId, direction: call.direction,
  }, '🔐 Plivo signature verified and phone account resolved');
  const runtimeAgent = await resolvePhoneNumberAgent(call);
  request.log.info({
    icon: '🏢', stage: 'agent.resolved', providerCallId: call.providerCallId,
    tenantId: runtimeAgent.tenantId, agentId: runtimeAgent.agentId, agentName: runtimeAgent.agentName,
  }, '🏢 Company and active voice agent resolved');
  const runtimeProfile = await loadAgentRuntimeProfile(runtimeAgent);
  registerImplementedProviderAdapters();
  const adapterCompatibility = assertRuntimeAdapterCompatibility(runtimeProfile);
  request.log.info({
    icon: '📝', stage: 'prompt.loaded', providerCallId: call.providerCallId,
    agentId: runtimeAgent.agentId, promptCharacters: runtimeProfile.agent.prompt?.length ?? 0,
    promptConfigured: Boolean(runtimeProfile.agent.prompt?.trim()),
    runtimeAdapters: adapterCompatibility.adapters,
  }, '📝 Agent system prompt loaded (content hidden)');
  providerLog(request, '🎙️', 'stt', call.providerCallId, runtimeProfile.providers.stt);
  providerLog(request, '🧠', 'llm', call.providerCallId, runtimeProfile.providers.llm);
  providerLog(request, '🔊', 'tts', call.providerCallId, runtimeProfile.providers.tts);
  await voiceCallOwnership.acquire({
    tenantId: runtimeAgent.tenantId,
    providerCallId: call.providerCallId,
    limit: runtimeAgent.concurrencyLimit,
  });
  let callSession = await createVoiceCallSession({ call, runtimeProfile });
  if (callSession.created) {
    const preCall = await executePreCall(runtimeProfile, call);
    callSession = await saveVoiceCallPreCallResult(callSession.id, preCall);
    request.log.info({
      icon: '🔗', stage: 'precall.completed', callId: callSession.id,
      attempted: preCall.attempted, delivered: preCall.delivered,
      status: preCall.status ?? null, durationMs: preCall.durationMs,
      mappedContextKeys: Object.keys(preCall.context ?? {}),
    }, '🔗 Pre-call integration completed');
  }
  request.log.info({
    providerCallId: call.providerCallId,
    phoneNumberId: call.phoneNumberId,
    tenantId: runtimeAgent.tenantId,
    agentId: runtimeAgent.agentId,
    callId: callSession.id,
    sttProviderId: runtimeProfile.providers.stt.providerId,
    llmProviderId: runtimeProfile.providers.llm.providerId,
    ttsProviderId: runtimeProfile.providers.tts.providerId,
    direction: call.direction,
  }, '💾 Call session created; returning Plivo stream XML');
  request.log.warn({
    icon: '⚠️', stage: 'media.awaiting_runtime', callId: callSession.id,
    providerCallId: call.providerCallId, mediaPath: '/webhooks/plivo/media',
  }, '⚠️ Waiting for authenticated Plivo media WebSocket');
  response.type('application/xml').send(buildPlivoStreamXml(callSession));
});

voiceRouter.get('/media', (request, response) => {
  request.log.warn({
    icon: '⚠️',
    stage: 'media.upgrade_required',
    callId: request.query.call_id ?? null,
    upgradeRequested: request.get('upgrade')?.toLowerCase() === 'websocket',
  }, '⚠️ Plivo media endpoint requires a WebSocket upgrade');
  response.set('Upgrade', 'websocket').status(426).json({
    success: false,
    error: {
      code: 'VOICE_MEDIA_WEBSOCKET_REQUIRED',
      message: 'Use a WebSocket upgrade for the Plivo media endpoint',
    },
    requestId: request.id,
  });
});
