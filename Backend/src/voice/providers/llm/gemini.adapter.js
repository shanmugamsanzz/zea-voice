import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { normalizeLlmEvent, normalizeLlmUsage } from './llm.interface.js';
import {
  createLlmRequestState, errorEvent, parameter, parseJson, parseSse, providerFailure,
  requireStreamingResponse,
} from './streaming-runtime.js';

function configuration(providerConfig) {
  const apiKey = parameter(providerConfig.parameters, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'API_KEY', 'TOKEN');
  if (!apiKey) throw new AppError(503, 'Selected Gemini provider has no API key', 'LLM_API_KEY_MISSING');
  const configured = parameter(providerConfig.parameters, 'GEMINI_API_URL', 'GOOGLE_API_URL', 'API_URL', 'ENDPOINT')
    ?? providerConfig.baseUrl;
  if (!configured) throw new AppError(503, 'Selected Gemini provider has no API URL', 'LLM_API_URL_MISSING');
  let url;
  try { url = new URL(configured); } catch {
    throw new AppError(503, 'Selected Gemini provider API URL is invalid', 'LLM_API_URL_INVALID');
  }
  const model = String(providerConfig.modelKey).replace(/^models\//, '');
  if (!/:streamGenerateContent$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent`;
  }
  url.searchParams.set('alt', 'sse');
  return { apiKey, url: url.toString(), model };
}

function requestBody(input) {
  const system = input.messages.filter((message) => message.role === 'system')
    .map((message) => String(message.content)).join('\n\n');
  const contents = input.messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(message.content ?? '') }],
  }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens ?? env.LLM_MAX_OUTPUT_TOKENS,
    },
    ...(input.tools?.length ? { tools: [{ functionDeclarations: input.tools.map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    })) }] } : {}),
  };
}

export function createGeminiLlmAdapter({ providerConfig, runtimeContext = {} }) {
  const resolved = configuration(providerConfig);
  const state = createLlmRequestState(providerConfig, runtimeContext);
  const context = { providerId: providerConfig.providerId, modelId: providerConfig.modelId };
  async function* stream(input) {
    const request = state.begin();
    const startedAt = performance.now();
    let usage = normalizeLlmUsage();
    let finishReason = null;
    let providerRequestId = null;
    const toolCalls = [];
    try {
      const response = await (runtimeContext.fetchImpl ?? fetch)(resolved.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': resolved.apiKey },
        body: JSON.stringify(requestBody(input)),
        signal: request.controller.signal,
      });
      await requireStreamingResponse(response, providerConfig);
      providerRequestId = response.headers.get('x-request-id');
      yield normalizeLlmEvent({ type: 'response_started', providerRequestId }, context);
      for await (const data of parseSse(response.body)) {
        const payload = parseJson(data);
        providerRequestId ??= payload.responseId ?? null;
        if (payload.error) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
        for (const candidate of payload.candidates ?? []) {
          finishReason = candidate.finishReason ?? finishReason;
          for (const part of candidate.content?.parts ?? []) {
            if (part.text) yield normalizeLlmEvent({ type: 'text_delta', delta: part.text, providerRequestId }, context);
            if (part.functionCall) {
              const normalized = normalizeLlmEvent({
                type: 'tool_call',
                id: part.functionCall.id ?? `${providerRequestId ?? 'gemini'}-tool-${toolCalls.length}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {}, providerRequestId,
              }, context);
              toolCalls.push({ id: normalized.id, name: normalized.name, arguments: normalized.arguments });
              yield normalized;
            }
          }
        }
        if (payload.usageMetadata) {
          usage = normalizeLlmUsage({
            inputTokens: payload.usageMetadata.promptTokenCount,
            outputTokens: payload.usageMetadata.candidatesTokenCount,
            totalTokens: payload.usageMetadata.totalTokenCount,
            cachedInputTokens: payload.usageMetadata.cachedContentTokenCount,
          });
          yield normalizeLlmEvent({ type: 'usage', usage, providerRequestId }, context);
        }
      }
      state.breaker.success();
      yield normalizeLlmEvent({
        type: 'completed', finishReason: finishReason ?? 'STOP', usage, toolCalls, providerRequestId,
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

export function registerGeminiLlmAdapter(registry) {
  if (registry.has('llm', 'gemini')) return;
  registry.register('llm', 'gemini', createGeminiLlmAdapter, {
    aliases: ['google', 'google-gemini', 'google ai', 'gemini ai'],
  });
}
