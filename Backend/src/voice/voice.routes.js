import { Router } from 'express';
import { AppError } from '../middleware/errors.js';
import { buildPlivoStreamXml, validateIncomingPlivoCall } from './plivo-answer.service.js';
import { resolvePhoneNumberAgent } from './agent-resolver.service.js';
import { createVoiceCallSession, saveVoiceCallContextResolution, saveVoiceCallPreCallResult } from './call-session-store.js';
import { plivoAnswerPayloadSchema } from './voice.schemas.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';
import { validateRuntimeAdapterConfiguration } from './providers/registry.js';
import { registerImplementedProviderAdapters } from './providers/defaults.js';
import { executePreCall } from './integrations/precall.service.js';
import { voiceCallOwnership } from './call-ownership.service.js';
import { resolveCallContextId } from './interaction/context-id-resolver.js';
import { admitAnsweredCall } from './call-capacity.service.js';
import { z } from 'zod';
import { inboundCallQueue, buildInboundQueueXml, createHoldMusic } from './inbound-call-queue.service.js';
import { shouldQueueInboundCall } from '../queues/company-queue-feature.js';

export const voiceRouter = Router();

const holdMusicClips = new Map();
voiceRouter.get('/hold-music.wav', (request, response) => {
  const parsed = z.coerce.number().int().min(1).max(10).safeParse(request.query.seconds ?? 4);
  if (!parsed.success) throw new AppError(400, 'Invalid hold music duration', 'VALIDATION_ERROR');
  if (!holdMusicClips.has(parsed.data)) holdMusicClips.set(parsed.data, createHoldMusic(parsed.data));
  response.set('Cache-Control', 'public, max-age=86400').type('audio/wav').send(holdMusicClips.get(parsed.data));
});

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
  const capacityQuery = z.object({ capacity_id: z.string().uuid().optional(), queue_poll: z.literal('1').optional() }).safeParse(request.query);
  if (!capacityQuery.success) throw new AppError(400, 'Invalid call capacity identifier', 'VALIDATION_ERROR');
  const reservationId = capacityQuery.data.capacity_id;
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
    reservationId,
    queuePoll: capacityQuery.data.queue_poll === '1',
    signature: request.get('x-plivo-signature-v3'),
    mainSignature: request.get('x-plivo-signature-ma-v3'),
    nonce: request.get('x-plivo-signature-v3-nonce'),
  });
  request.log.info({
    icon: '🔐', stage: 'plivo.verified', providerCallId: call.providerCallId,
    phoneNumberId: call.phoneNumberId, direction: call.direction,
  }, '🔐 Plivo signature verified and phone account resolved');
  const runtimeAgent = await resolvePhoneNumberAgent(call);
  let admission;
  if (shouldQueueInboundCall({ tenantId: runtimeAgent.tenantId, direction: call.direction,
    queuePoll: capacityQuery.data.queue_poll === '1' })) {
    admission = await inboundCallQueue.admit({ tenantId: runtimeAgent.tenantId,
      providerCallId: call.providerCallId, limit: runtimeAgent.concurrencyLimit,
      maxSize: runtimeAgent.inboundQueueMaxSize, maxWaitSeconds: runtimeAgent.inboundQueueMaxWaitSeconds,
      metadata: { phone: call.from, agentId: runtimeAgent.agentId, agentName: runtimeAgent.agentName,
        phoneNumberId: call.phoneNumberId } });
    if (admission.status !== 'admitted') {
      request.log.info({ stage: 'call.inbound_queue', tenantId: runtimeAgent.tenantId,
        providerCallId: call.providerCallId, status: admission.status, remainingMs: admission.remainingMs }, 'Inbound queue admission checked');
      response.type('application/xml').send(buildInboundQueueXml(admission, call.answerUrl));
      return;
    }
  }
  try {
    request.log.info({
      icon: '🏢', stage: 'agent.resolved', providerCallId: call.providerCallId,
      tenantId: runtimeAgent.tenantId, agentId: runtimeAgent.agentId, agentName: runtimeAgent.agentName,
    }, '🏢 Company and active voice agent resolved');
    const runtimeProfile = await loadAgentRuntimeProfile(runtimeAgent);
    request.log.info({
      stage: 'tools.assigned', providerCallId: call.providerCallId,
      tenantId: runtimeAgent.tenantId, agentId: runtimeAgent.agentId,
      activeToolCount: runtimeProfile.tools.length,
      toolTypes: [...new Set(runtimeProfile.tools.map((tool) => tool.type))],
    }, 'Active tenant-isolated tools loaded for the selected agent');
    registerImplementedProviderAdapters();
    const adapterCompatibility = await validateRuntimeAdapterConfiguration(runtimeProfile);
    request.log.info({
      icon: '📝', stage: 'prompt.loaded', providerCallId: call.providerCallId,
      agentId: runtimeAgent.agentId, promptCharacters: runtimeProfile.agent.prompt?.length ?? 0,
      promptConfigured: Boolean(runtimeProfile.agent.prompt?.trim()),
      runtimeAdapters: adapterCompatibility.adapters,
    }, '📝 Agent system prompt loaded (content hidden)');
    providerLog(request, '🎙️', 'stt', call.providerCallId, runtimeProfile.providers.stt);
    providerLog(request, '🧠', 'llm', call.providerCallId, runtimeProfile.providers.llm);
    providerLog(request, '🔊', 'tts', call.providerCallId, runtimeProfile.providers.tts);
    admission ??= await admitAnsweredCall({
      tenantId: runtimeAgent.tenantId,
      providerCallId: call.providerCallId,
      limit: runtimeAgent.concurrencyLimit,
      reservationId: call.direction === 'outbound' ? reservationId : undefined,
    });
    let callSession = await createVoiceCallSession({ call, runtimeProfile });
    const existingPreCall = callSession.providerMetadata?.preCall;
    const preCallRequired = callSession.created || !existingPreCall || existingPreCall.status === 'pending';
    if (preCallRequired) {
      const preCall = await executePreCall(runtimeProfile, call);
      callSession = await saveVoiceCallPreCallResult(callSession.id, preCall);
      request.log.info({
        icon: '🔗', stage: 'precall.completed', callId: callSession.id,
        attempted: preCall.attempted, delivered: preCall.delivered,
        status: preCall.status ?? null, durationMs: preCall.durationMs,
        mappedContextKeys: Object.keys(preCall.context ?? {}),
      }, '🔗 Pre-call integration completed');
    }
    const contextResolution = resolveCallContextId({ call: callSession, runtimeProfile });
    callSession = await saveVoiceCallContextResolution(callSession.id, contextResolution);
    request.log.info({
      stage: 'context.resolved', callId: callSession.id,
      source: contextResolution.source, direction: contextResolution.direction,
      namespaced: Boolean(contextResolution.namespace),
    }, 'Call Context ID resolved from validated source metadata');
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
    response.type('application/xml').send(buildPlivoStreamXml(callSession, {
      recordingEnabled: runtimeAgent.recordingEnabled,
      recordingCallbackUrl: call.recordingCallbackUrl,
      // This is only a provider safety ceiling. Plivo stops recording naturally
      // when the call ends, including when the agent's own duration limit fires.
      recordingMaxLengthSeconds: 86_400,
    }));
  } catch (error) {
    if (admission?.acquired) await voiceCallOwnership.release({ tenantId: runtimeAgent.tenantId, providerCallId: call.providerCallId })
      .catch((releaseError) => request.log.warn({ err: releaseError, stage: 'call.capacity_release_failed' }, 'Call capacity will recover on lease expiry'));
    throw error;
  }
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
