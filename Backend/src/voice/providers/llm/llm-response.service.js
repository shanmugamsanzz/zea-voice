import { env } from '../../../config/env.js';
import { buildAgentSystemPrompt } from '../../../agents/agent-runtime.service.js';
import { groundedDecisionJsonSchema } from '../../interaction/grounded-llm-decision.js';
import { buildGroundingEnvelope } from '../../interaction/grounded-llm-response.js';
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

function toolIdentifiers(tool, runtimeName) {
  const configuration = tool.configuration ?? {};
  return [...new Set([
    runtimeName,
    tool.id,
    tool.name,
    configuration.identifier,
    configuration.toolIdentifier,
    configuration.actionKey,
    configuration.key,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function selectedLlmPromptBudget(compactGrounding = false) {
  return compactGrounding
    ? Math.min(env.VOICE_LLM_PROMPT_BUDGET_CHARS, 8_000)
    : env.VOICE_LLM_PROMPT_BUDGET_CHARS;
}

export function selectedVoiceHistoryLimit(requestedLimit) {
  const configured = Math.min(env.VOICE_LLM_MAX_HISTORY_MESSAGES, 4);
  return Math.max(0, Math.min(
    configured,
    Number.isInteger(requestedLimit) && requestedLimit >= 0 ? requestedLimit : configured,
  ));
}

export function selectedGroundedOutputTokenLimit() {
  return Math.min(env.VOICE_GROUNDED_MAX_OUTPUT_TOKENS, 384);
}

export function runtimeTools(tools = []) {
  return tools.map((tool, index) => {
    const configuration = tool.configuration ?? {};
    const name = safeToolName(tool, index);
    const inputSchema = configuration.inputSchema ?? configuration.input_schema
      ?? configuration.parametersSchema ?? configuration.parameters_schema
      ?? { type: 'object', properties: {}, additionalProperties: true };
    return {
      id: tool.id,
      name,
      identifiers: toolIdentifiers(tool, name),
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
  const assignedTools = runtimeTools(runtimeProfile.tools);
  const groundedResponseMode = input.context?.groundedResponseMode === true;
  // Every grounded live decision uses the compact voice contract. Callers
  // cannot accidentally opt back into the larger non-voice prompt path.
  const compactGrounding = groundedResponseMode;
  const groundingEnvelope = buildGroundingEnvelope(
    input.knowledge ?? { found: false, route: 'none' },
    compactGrounding ? { includePublishedMap: false, maximumSources: 4 } : {},
  );
  const decisionRuntime = {
    fieldSchemas: input.context?.configuredInformationFields ?? [],
    toolSchemas: assignedTools,
  };
  const systemPrompt = buildAgentSystemPrompt(runtimeProfile.agent, {
    usageDirection: input.usageDirection,
    context: {
      ...(input.context ?? {}),
      compactGrounding,
      configuredToolSchemas: assignedTools,
    },
    knowledge: input.knowledge ?? { found: false, route: 'none' },
    maxPromptChars: selectedLlmPromptBudget(compactGrounding),
  });
  const historyLimit = groundedResponseMode
    ? selectedVoiceHistoryLimit(input.historyLimit)
    : Math.min(
      env.LLM_MAX_HISTORY_MESSAGES,
      Number.isInteger(input.historyLimit) && input.historyLimit >= 0
        ? input.historyLimit : env.VOICE_LLM_MAX_HISTORY_MESSAGES,
    );
  const boundedHistory = historyLimit > 0
    ? (input.history ?? []).slice(-historyLimit) : [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...boundedHistory,
    { role: 'user', content: input.query },
  ];
  return {
    events: llm.stream({
      messages,
      tools: groundedResponseMode ? [] : assignedTools,
      // Evidence selection, state mutation and tool authorization are control
      // decisions. They must be reproducible for identical input; conversational
      // creativity remains available only outside the grounded JSON path.
      temperature: groundedResponseMode ? 0 : runtimeProfile.agent.temperature,
      maxOutputTokens: groundedResponseMode
        ? selectedGroundedOutputTokenLimit()
        : env.LLM_MAX_OUTPUT_TOKENS,
      ...(groundedResponseMode ? {
        responseFormat: {
          type: 'json_schema', name: 'grounded_voice_decision', strict: false,
          schema: groundedDecisionJsonSchema(groundingEnvelope, decisionRuntime),
        },
      } : {}),
    }),
    promptCharacters: systemPrompt.length,
    historyMessages: boundedHistory.length,
    maxOutputTokens: groundedResponseMode
      ? selectedGroundedOutputTokenLimit() : env.LLM_MAX_OUTPUT_TOKENS,
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
