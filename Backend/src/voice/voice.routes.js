import { Router } from 'express';
import { AppError } from '../middleware/errors.js';
import { buildPlivoStreamXml, validateIncomingPlivoCall } from './plivo-answer.service.js';
import { resolvePhoneNumberAgent } from './agent-resolver.service.js';
import { createVoiceCallSession } from './call-session-store.js';
import { plivoAnswerPayloadSchema } from './voice.schemas.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';

export const voiceRouter = Router();

voiceRouter.post('/answer', async (request, response) => {
  const parsed = plivoAnswerPayloadSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'Invalid Plivo answer payload', 'VALIDATION_ERROR', parsed.error.issues);
  }
  const call = await validateIncomingPlivoCall({
    payload: parsed.data,
    rawPayload: request.body ?? {},
    signature: request.get('x-plivo-signature-v3'),
    mainSignature: request.get('x-plivo-signature-ma-v3'),
    nonce: request.get('x-plivo-signature-v3-nonce'),
  });
  const runtimeAgent = await resolvePhoneNumberAgent(call);
  const runtimeProfile = await loadAgentRuntimeProfile(runtimeAgent);
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
  }, 'Validated incoming Plivo call and resolved active agent');
  response.type('application/xml').send(buildPlivoStreamXml(callSession));
});
