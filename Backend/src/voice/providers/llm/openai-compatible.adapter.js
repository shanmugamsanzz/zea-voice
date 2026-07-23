import { env } from '../../../config/env.js';
import { resolveLlmConfiguration } from '../../../llm/llm.client.js';
import { normalizeLlmEvent, normalizeLlmUsage } from './llm.interface.js';
import {
  createLlmRequestState, errorEvent, parseJson, parseSse, providerFailure, requireStreamingResponse,
} from './streaming-runtime.js';

function parameters(config) {
  const values = Object.entries(config.parameters ?? {}).map(([key, value]) => ({ key, value }));
  if (String(config.providerName).toLowerCase().includes('azure')) {
    const apiKey = config.parameters?.AZURE_OPENAI_API_KEY ?? config.parameters?.OPENAI_API_KEY;
    if (apiKey && !config.parameters?.AZURE_OPENAI_API_KEY) values.push({ key: 'AZURE_OPENAI_API_KEY', value: apiKey });
  }
  return values;
}

function tools(input) {
  return (input ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function text(delta) {
  if (typeof delta === 'string') return delta;
  if (Array.isArray(delta)) return delta.map((part) => part?.text ?? '').join('');
  return '';
}

export function createOpenAiCompatibleLlmAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveLlmConfiguration({
    llm: {
      providerId: providerConfig.providerId,
      providerName: providerConfig.providerName,
      modelId: providerConfig.modelId,
      modelKey: providerConfig.modelKey,
      baseUrl: providerConfig.baseUrl,
      modelSettings: providerConfig.modelSettings ?? {},
      parameters: parameters(providerConfig),
    },
  });
  const state = createLlmRequestState(providerConfig, runtimeContext);
  const context = { providerId: providerConfig.providerId, modelId: providerConfig.modelId };

  async function* stream(input) {
    const request = state.begin();
    const startedAt = performance.now();
    let usage = normalizeLlmUsage();
    let finishReason = null;
    let providerRequestId = null;
    const toolCalls = new Map();
    try {
      const response = await (runtimeContext.fetchImpl ?? fetch)(configuration.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(configuration.azure
            ? { 'api-key': configuration.apiKey }
            : { authorization: `Bearer ${configuration.apiKey}` }),
        },
        body: JSON.stringify({
          model: configuration.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxOutputTokens ?? env.LLM_MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          ...(input.tools?.length ? { tools: tools(input.tools), tool_choice: 'auto' } : {}),
        }),
        signal: request.controller.signal,
      });
      await requireStreamingResponse(response, providerConfig);
      providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('apim-request-id');
      yield normalizeLlmEvent({ type: 'response_started', providerRequestId }, context);
      for await (const data of parseSse(response.body)) {
        if (data === '[DONE]') break;
        const payload = parseJson(data);
        providerRequestId ??= payload.id ?? null;
        if (payload.error) throw Object.assign(new Error(payload.error.message ?? 'LLM stream failed'), { code: payload.error.code });
        if (payload.usage) {
          usage = normalizeLlmUsage({
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
            cachedInputTokens: payload.usage.prompt_tokens_details?.cached_tokens,
          });
          yield normalizeLlmEvent({ type: 'usage', usage, providerRequestId }, context);
        }
        for (const choice of payload.choices ?? []) {
          const delta = choice.delta ?? {};
          const content = text(delta.content);
          if (content) yield normalizeLlmEvent({ type: 'text_delta', delta: content, providerRequestId }, context);
          for (const call of delta.tool_calls ?? []) {
            const index = Number(call.index ?? 0);
            const current = toolCalls.get(index) ?? { index, id: '', name: '', argumentsText: '' };
            current.id = call.id ?? current.id;
            current.name = call.function?.name ?? current.name;
            current.argumentsText += call.function?.arguments ?? '';
            toolCalls.set(index, current);
            yield normalizeLlmEvent({
              type: 'tool_call_delta', index, id: call.id, name: call.function?.name,
              argumentsDelta: call.function?.arguments ?? '', providerRequestId,
            }, context);
          }
          finishReason = choice.finish_reason ?? finishReason;
        }
      }
      const completedTools = [];
      for (const call of [...toolCalls.values()].sort((left, right) => left.index - right.index)) {
        let args;
        try { args = JSON.parse(call.argumentsText || '{}'); } catch { args = { _raw: call.argumentsText }; }
        const normalized = normalizeLlmEvent({
          type: 'tool_call', id: call.id || `tool-${call.index}`, name: call.name, arguments: args,
          providerRequestId,
        }, context);
        completedTools.push({ id: normalized.id, name: normalized.name, arguments: normalized.arguments });
        yield normalized;
      }
      state.breaker.success();
      yield normalizeLlmEvent({
        type: 'completed', finishReason: finishReason ?? 'stop', usage,
        toolCalls: completedTools, providerRequestId,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }, context);
    } catch (error) {
      const failure = providerFailure(error, request, providerConfig);
      if (!failure) {
        yield normalizeLlmEvent({ type: 'cancelled', reason: 'barge-in', providerRequestId }, context);
        return;
      }
      if (failure.code !== 'LLM_CIRCUIT_OPEN' && (failure.details?.status >= 500 || !failure.details?.status)) {
        state.breaker.failure();
      }
      yield errorEvent(failure, providerConfig);
      throw failure;
    } finally {
      request.finish();
    }
  }

  return {
    configuration: {
      providerId: configuration.providerId, providerName: configuration.providerName,
      modelId: configuration.modelId, model: configuration.model, azure: configuration.azure,
    },
    stream,
    cancel: (reason) => state.cancel(reason),
    close: () => state.close(),
  };
}

export function registerOpenAiCompatibleLlmAdapter(registry) {
  if (registry.has('llm', 'openai-compatible')) return;
  registry.register('llm', 'openai-compatible', createOpenAiCompatibleLlmAdapter, {
    aliases: ['openai', 'azure', 'azure-openai', 'openai compatible'],
  });
}
