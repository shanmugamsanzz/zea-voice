import { Router } from 'express';
import { AppError } from '../middleware/errors.js';
import { buildPlivoStreamXml, validateIncomingPlivoCall } from './plivo-answer.service.js';
import { resolvePhoneNumberAgent } from './agent-resolver.service.js';
import { createVoiceCallSession } from './call-session-store.js';
import { plivoAnswerPayloadSchema } from './voice.schemas.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';

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
  request.log.info({
    icon: '📝', stage: 'prompt.loaded', providerCallId: call.providerCallId,
    agentId: runtimeAgent.agentId, promptCharacters: runtimeProfile.agent.prompt?.length ?? 0,
    promptConfigured: Boolean(runtimeProfile.agent.prompt?.trim()),
  }, '📝 Agent system prompt loaded (content hidden)');
  providerLog(request, '🎙️', 'stt', call.providerCallId, runtimeProfile.providers.stt);
  providerLog(request, '🧠', 'llm', call.providerCallId, runtimeProfile.providers.llm);
  providerLog(request, '🔊', 'tts', call.providerCallId, runtimeProfile.providers.tts);
  const callSession = await createVoiceCallSession({ call, runtimeProfile });
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
  }, '⚠️ Waiting for Plivo media WebSocket; media runtime is not implemented');
  response.type('application/xml').send(buildPlivoStreamXml(callSession));
});

voiceRouter.get('/media', (request, response) => {
  request.log.error({
    icon: '❌',
    stage: 'media.unavailable',
    callId: request.query.call_id ?? null,
    upgradeRequested: request.get('upgrade')?.toLowerCase() === 'websocket',
  }, '❌ Plivo media WebSocket rejected: voice media runtime is not implemented');
  response.set('Upgrade', 'websocket').status(426).json({
    success: false,
    error: {
      code: 'VOICE_MEDIA_RUNTIME_NOT_IMPLEMENTED',
      message: 'Plivo media WebSocket runtime is not implemented',
    },
    requestId: request.id,
  });
});
