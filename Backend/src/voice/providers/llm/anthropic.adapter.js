import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { normalizeLlmEvent, normalizeLlmUsage } from './llm.interface.js';
import {
  createLlmRequestState, errorEvent, parameter, parseJson, parseSse, providerFailure,
  requireStreamingResponse, setting,
} from './streaming-runtime.js';

function configuration(providerConfig) {
  const apiKey = parameter(providerConfig.parameters, 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'API_KEY', 'TOKEN');
  if (!apiKey) throw new AppError(503, 'Selected Anthropic provider has no API key', 'LLM_API_KEY_MISSING');
  const configured = parameter(providerConfig.parameters, 'ANTHROPIC_API_URL', 'CLAUDE_API_URL', 'API_URL', 'ENDPOINT')
    ?? providerConfig.baseUrl;
  if (!configured) throw new AppError(503, 'Selected Anthropic provider has no API URL', 'LLM_API_URL_MISSING');
  let url;
  try { url = new URL(configured); } catch {
    throw new AppError(503, 'Selected Anthropic provider API URL is invalid', 'LLM_API_URL_INVALID');
  }
  if (!/\/v1\/messages\/?$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/messages`;
  const version = parameter(providerConfig.parameters, 'ANTHROPIC_VERSION')
    ?? setting(providerConfig.effectiveSettings ?? providerConfig.modelSettings, 'anthropicVersion')
    ?? '2023-06-01';
  return { apiKey, url: url.toString(), version, model: providerConfig.modelKey };
}

function requestBody(input, model) {
  const system = input.messages.filter((message) => message.role === 'system')
    .map((message) => String(message.content)).join('\n\n');
  const messages = input.messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content ?? ''),
  }));
  return {
    model,
    system,
    messages,
    max_tokens: input.maxOutputTokens ?? env.LLM_MAX_OUTPUT_TOKENS,
    temperature: input.temperature,
    stream: true,
    ...(input.tools?.length ? { tools: input.tools.map((tool) => ({
      name: tool.name, description: tool.description, input_schema: tool.inputSchema,
    })) } : {}),
  };
}

export function createAnthropicLlmAdapter({ providerConfig, runtimeContext = {} }) {
  const resolved = configuration(providerConfig);
  const state = createLlmRequestState(providerConfig, runtimeContext);
  const context = { providerId: providerConfig.providerId, modelId: providerConfig.modelId };
  async function* stream(input) {
    const request = state.begin();
    const startedAt = performance.now();
    let providerRequestId = null;
    let finishReason = null;
    let usage = normalizeLlmUsage();
    const blocks = new Map();
    const completedTools = [];
    try {
      const response = await (runtimeContext.fetchImpl ?? fetch)(resolved.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': resolved.apiKey,
          'anthropic-version': resolved.version,
        },
        body: JSON.stringify(requestBody(input, resolved.model)),
        signal: request.controller.signal,
      });
      await requireStreamingResponse(response, providerConfig);
      providerRequestId = response.headers.get('request-id');
      yield normalizeLlmEvent({ type: 'response_started', providerRequestId }, context);
      for await (const data of parseSse(response.body)) {
        const payload = parseJson(data);
        if (payload.type === 'error') throw Object.assign(new Error(payload.error?.message), { code: payload.error?.type });
        if (payload.type === 'message_start') {
          providerRequestId ??= payload.message?.id ?? null;
          usage = normalizeLlmUsage({ inputTokens: payload.message?.usage?.input_tokens });
        }
        if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
          blocks.set(payload.index, {
            id: payload.content_block.id, name: payload.content_block.name, argumentsText: '',
          });
        }
        if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta' && payload.delta.text) {
          yield normalizeLlmEvent({ type: 'text_delta', delta: payload.delta.text, providerRequestId }, context);
        }
        if (payload.type === 'content_block_delta' && payload.delta?.type === 'input_json_delta') {
          const block = blocks.get(payload.index);
          if (block) block.argumentsText += payload.delta.partial_json ?? '';
          yield normalizeLlmEvent({
            type: 'tool_call_delta', index: payload.index, id: block?.id, name: block?.name,
            argumentsDelta: payload.delta.partial_json ?? '', providerRequestId,
          }, context);
        }
        if (payload.type === 'content_block_stop' && blocks.has(payload.index)) {
          const block = blocks.get(payload.index);
          let args;
          try { args = JSON.parse(block.argumentsText || '{}'); } catch { args = { _raw: block.argumentsText }; }
          const normalized = normalizeLlmEvent({
            type: 'tool_call', id: block.id, name: block.name, arguments: args, providerRequestId,
          }, context);
          completedTools.push({ id: normalized.id, name: normalized.name, arguments: normalized.arguments });
          yield normalized;
        }
        if (payload.type === 'message_delta') {
          finishReason = payload.delta?.stop_reason ?? finishReason;
          usage = normalizeLlmUsage({
            inputTokens: usage.inputTokens,
            outputTokens: payload.usage?.output_tokens,
            cachedInputTokens: payload.usage?.cache_read_input_tokens,
          });
          yield normalizeLlmEvent({ type: 'usage', usage, providerRequestId }, context);
        }
      }
      state.breaker.success();
      yield normalizeLlmEvent({
        type: 'completed', finishReason: finishReason ?? 'end_turn', usage,
        toolCalls: completedTools, providerRequestId,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }, context);
    } catch (error) {
      const failure = providerFailure(error, request, providerConfig);
      if (!failure) {
        yield normalizeLlmEvent({ type: 'cancelled', reason: 'barge-in', providerRequestId }, context);
        return;
      }
      if (failure.details?.status >= 500 || !failure.details?.status) state.breaker.failure();
      yield errorEvent(failure, providerConfig);
      throw failure;
    } finally { request.finish(); }
  }
  return {
    configuration: { ...resolved, apiKey: undefined, providerId: providerConfig.providerId, modelId: providerConfig.modelId },
    stream,
    cancel: (reason) => state.cancel(reason),
    close: () => state.close(),
  };
}

export function registerAnthropicLlmAdapter(registry) {
  if (registry.has('llm', 'anthropic')) return;
  registry.register('llm', 'anthropic', createAnthropicLlmAdapter, {
    aliases: ['claude', 'anthropic-claude', 'claude ai'],
  });
}
