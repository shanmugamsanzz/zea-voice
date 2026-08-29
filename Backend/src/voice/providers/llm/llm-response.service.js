import { env } from '../../../config/env.js';
import { buildAgentSystemPrompt } from '../../../agents/agent-runtime.service.js';
import { AppError } from '../../../middleware/errors.js';
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

function initializationFailure(error, stage) {
  if (error instanceof AppError) return error;
  const failure = new AppError(500,
    'The grounded LLM request could not be initialized',
    'LLM_GROUNDED_INITIALIZATION_FAILED', {
      initializationStage: stage,
      errorName: String(error?.name ?? 'Error').slice(0, 120),
      errorMessage: String(error?.message ?? 'Unknown initialization error').slice(0, 1_000),
    });
  failure.cause = error;
  return failure;
}

function initialize(stage, operation) {
  try {
    return operation();
  } catch (error) {
    throw initializationFailure(error, stage);
  }
}

function configuredArray(value, field) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new AppError(500,
    `The grounded LLM ${field} configuration must be an array`,
    'LLM_GROUNDED_INPUT_INVALID', {
      initializationStage: 'input_contract', field, receivedType: typeof value,
    });
}

const truncatedFinishReasons = new Set([
  'length', 'max_tokens', 'max_output_tokens', 'max_tokens_reached', 'incomplete',
]);

export function assertGroundedStructuredCompletion(completion, output) {
  const finishReason = String(completion?.finishReason ?? '').trim().toLocaleLowerCase();
  if (completion?.type !== 'completed') {
    throw new AppError(502, 'The grounded LLM stream ended without a completion event',
      'LLM_STRUCTURED_OUTPUT_INCOMPLETE', { finishReason: finishReason || null });
  }
  if (truncatedFinishReasons.has(finishReason)) {
    throw new AppError(502, 'The grounded LLM structured response was truncated',
      'LLM_STRUCTURED_OUTPUT_TRUNCATED', { finishReason });
  }
  const serialized = String(output ?? '').trim();
  if (!serialized) {
    throw new AppError(502, 'The grounded LLM returned no structured response',
      'LLM_STRUCTURED_OUTPUT_EMPTY', { finishReason: finishReason || null });
  }
  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError();
  } catch {
    throw new AppError(502, 'The grounded LLM returned malformed JSON',
      'LLM_STRUCTURED_OUTPUT_INVALID_JSON', { finishReason: finishReason || null });
  }
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
    ? Math.min(env.VOICE_LLM_PROMPT_BUDGET_CHARS, env.LLM_SYSTEM_PROMPT_MAX_CHARS)
    : env.VOICE_LLM_PROMPT_BUDGET_CHARS;
}

export function estimateLlmPromptTokens(messages = []) {
  const content = messages.map((message) => String(message?.content ?? '')).join('\n');
  const codePoints = Array.from(content).length;
  const lexicalUnits = content.match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)?.length ?? 0;
  // Provider tokenizers differ. This conservative provider-independent
  // estimate protects multilingual prompts without adding a model-specific
  // tokenizer to the universal runtime.
  return Math.max(Math.ceil(codePoints / 3), Math.ceil(lexicalUnits * 1.25));
}

function assertPromptBudget(messages, characterBudget, tokenBudget) {
  const characters = messages.reduce((total, message) => (
    total + Array.from(String(message?.content ?? '')).length
  ), 0);
  const estimatedTokens = estimateLlmPromptTokens(messages);
  if (characters <= characterBudget && estimatedTokens <= tokenBudget) {
    return Object.freeze({ characters, estimatedTokens });
  }
  throw new AppError(413, 'The grounded LLM request exceeds the configured prompt budget',
    'LLM_GROUNDED_PROMPT_BUDGET_EXCEEDED', {
      characters, characterBudget, estimatedTokens, tokenBudget,
    });
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
  return configuredArray(tools, 'assigned tools').map((tool, index) => {
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
  const assignedTools = initialize('assigned_tools', () => runtimeTools(runtimeProfile.tools));
  const groundedResponseMode = input.context?.groundedResponseMode === true;
  const decisionTools = groundedResponseMode
    ? (input.context?.groundedDecisionInput?.toolSchemas
      ?? input.context?.authorizedToolSchemas
      ?? [])
    : assignedTools;
  const validatedDecisionTools = configuredArray(decisionTools, 'authorized tool schemas');
  const configuredFields = configuredArray(
    input.context?.configuredInformationFields, 'information fields',
  );
  // Every grounded live decision uses the compact voice contract. Callers
  // cannot accidentally opt back into the larger non-voice prompt path.
  const compactGrounding = groundedResponseMode;
  // The orchestrator constructs the final evidence envelope once. Reuse that
  // exact immutable object for the prompt contract and post-LLM validation so
  // a second filtering/mapping pass cannot drift from the LLM input.
  const groundingEnvelope = input.context?.groundingEnvelope
    ?? initialize('grounding_envelope', () => buildGroundingEnvelope(
      input.knowledge ?? { found: false, route: 'none' },
      compactGrounding ? { includePublishedMap: false, maximumSources: 5 } : {},
    ));
  const decisionRuntime = {
    fieldSchemas: configuredFields,
    toolSchemas: validatedDecisionTools,
    zeroEvidenceResponse: input.context?.zeroEvidenceResponse
      ?? input.context?.groundedDecisionInput?.zeroEvidencePolicy
        ?.informationUnavailableResponse ?? '',
  };
  const providerQuery = groundedResponseMode
    ? String(input.context?.groundedDecisionInput?.currentQuestion ?? input.query ?? '').slice(0, 2_000)
    : input.query;
  const characterBudget = selectedLlmPromptBudget(compactGrounding);
  const systemCharacterBudget = Math.max(4_000,
    characterBudget - Array.from(String(providerQuery ?? '')).length);
  const systemPrompt = initialize('system_prompt', () => buildAgentSystemPrompt(runtimeProfile.agent, {
    usageDirection: input.usageDirection,
    context: {
      ...(input.context ?? {}),
      compactGrounding,
      configuredToolSchemas: validatedDecisionTools,
    },
    knowledge: input.knowledge ?? { found: false, route: 'none' },
    maxPromptChars: systemCharacterBudget,
  }));
  const historyLimit = groundedResponseMode
    ? 0
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
    { role: 'user', content: providerQuery },
  ];
  const budget = assertPromptBudget(
    messages,
    characterBudget,
    env.VOICE_LLM_PROMPT_BUDGET_TOKENS,
  );
  const responseSchema = groundedResponseMode
    ? initialize('response_schema', () => groundedDecisionJsonSchema(
      groundingEnvelope, decisionRuntime,
    )) : null;
  const events = initialize('provider_stream', () => llm.stream({
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
          type: 'json_schema', name: 'grounded_voice_decision', strict: true,
          schema: responseSchema,
        },
      } : {}),
    }));
  if (!events || typeof events[Symbol.asyncIterator] !== 'function') {
    throw new AppError(500,
      'The selected LLM adapter did not create an asynchronous response stream',
      'LLM_GROUNDED_STREAM_INVALID', { initializationStage: 'provider_stream' });
  }
  return {
    events,
    promptCharacters: budget.characters,
    estimatedPromptTokens: budget.estimatedTokens,
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
  if (input.context?.groundedResponseMode === true) {
    assertGroundedStructuredCompletion(completion, completion.answer);
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
