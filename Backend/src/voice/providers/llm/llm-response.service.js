import { env } from '../../../config/env.js';
import { buildAgentSystemPrompt } from '../../../agents/agent-runtime.service.js';
import { providerAdapterRegistry } from '../registry.js';
import { registerOpenAiCompatibleLlmAdapter } from './openai-compatible.adapter.js';

function ensureDefaultLlmAdapters(registry) {
  registerOpenAiCompatibleLlmAdapter(registry);
}

export async function generateSelectedLlmResponse(runtimeProfile, input, dependencies = {}) {
  const registry = dependencies.registry ?? providerAdapterRegistry;
  if (!dependencies.skipDefaultRegistration) ensureDefaultLlmAdapters(registry);
  const llm = await registry.create('llm', runtimeProfile.providers.llm, {
    callId: input.callId,
    fetchImpl: dependencies.fetchImpl,
  });
  const systemPrompt = buildAgentSystemPrompt(runtimeProfile.agent, {
    usageDirection: input.usageDirection,
    context: input.context ?? {},
    knowledge: input.knowledge ?? { found: false, route: 'none' },
  });
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(input.history ?? []).slice(-env.LLM_MAX_HISTORY_MESSAGES),
    { role: 'user', content: input.query },
  ];
  const completion = await llm.generate({
    messages,
    temperature: runtimeProfile.agent.temperature,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
  });
  return {
    answer: completion.answer,
    providerId: runtimeProfile.providers.llm.providerId,
    providerName: runtimeProfile.providers.llm.providerName,
    modelId: runtimeProfile.providers.llm.modelId,
    model: runtimeProfile.providers.llm.modelKey,
    finishReason: completion.finishReason ?? null,
    usage: completion.usage ?? null,
    providerRequestId: completion.providerRequestId ?? null,
    durationMs: completion.durationMs ?? null,
  };
}
