import { env } from '../../../config/env.js';
import { buildAgentSystemPrompt } from '../../../agents/agent-runtime.service.js';
import { providerAdapterRegistry } from '../registry.js';
import { registerImplementedProviderAdapters } from '../defaults.js';

function ensureDefaultLlmAdapters(registry) {
  registerImplementedProviderAdapters(registry);
}

async function collectCompletion(stream) {
  let answer = '';
  let completion = {};
  const toolCalls = [];
  for await (const event of stream) {
    if (event?.type === 'text_delta') answer += String(event.delta ?? '');
    if (event?.type === 'tool_call') toolCalls.push({
      id: event.id, name: event.name, arguments: event.arguments,
    });
    if (event?.type === 'completed') completion = event;
  }
  return { ...completion, toolCalls: completion.toolCalls ?? toolCalls, answer: answer.trim() };
}

function safeToolName(tool, index) {
  const name = String(tool.name ?? `tool_${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return name || `tool_${index + 1}`;
}

function runtimeTools(tools = []) {
  return tools.map((tool, index) => {
    const configuration = tool.configuration ?? {};
    const inputSchema = configuration.inputSchema ?? configuration.input_schema
      ?? configuration.parametersSchema ?? configuration.parameters_schema
      ?? { type: 'object', properties: {}, additionalProperties: true };
    return {
      id: tool.id,
      name: safeToolName(tool, index),
      description: String(tool.description ?? `Execute ${tool.name}`).slice(0, 1024),
      inputSchema,
    };
  });
}

export async function createSelectedLlmStream(runtimeProfile, input, dependencies = {}) {
  const registry = dependencies.registry ?? providerAdapterRegistry;
  if (!dependencies.skipDefaultRegistration) ensureDefaultLlmAdapters(registry);
  const llm = dependencies.adapter ?? await registry.create('llm', runtimeProfile.providers.llm, {
    callId: input.callId,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
    breaker: dependencies.breaker,
  });
  const ownsAdapter = !dependencies.adapter;
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
  return {
    events: llm.stream({
      messages,
      tools: runtimeTools(runtimeProfile.tools),
      temperature: runtimeProfile.agent.temperature,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    }),
    cancel: (reason = 'barge-in') => llm.cancel(reason),
    close: () => ownsAdapter ? llm.close() : undefined,
  };
}

export async function generateSelectedLlmResponse(runtimeProfile, input, dependencies = {}) {
  const session = await createSelectedLlmStream(runtimeProfile, input, dependencies);
  let completion;
  try {
    completion = await collectCompletion(session.events);
  } finally {
    await session.close();
  }
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
    toolCalls: completion.toolCalls ?? [],
  };
}
