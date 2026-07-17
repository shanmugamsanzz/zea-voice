import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { measureExternalProvider } from '../performance/performance-context.js';

function parameterMap(parameters) {
  return new Map(parameters.map(({ key, value }) => [
    key.toUpperCase().replace(/[^A-Z0-9]/g, ''), String(value ?? '').trim(),
  ]));
}

function parameter(parameters, ...keys) {
  const values = parameterMap(parameters);
  for (const key of keys) {
    const value = values.get(key.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (value) return value;
  }
  return null;
}

function completionEndpoint(baseUrl, parameters, model) {
  const configured = parameter(parameters,
    'OPENAI_API_URL', 'AZURE_OPENAI_API_URL', 'CHAT_COMPLETIONS_URL', 'API_URL', 'ENDPOINT',
  ) ?? baseUrl;
  if (!configured) throw new AppError(503, 'Selected LLM provider has no API URL', 'LLM_API_URL_MISSING');
  let url;
  try { url = new URL(configured); } catch {
    throw new AppError(503, 'Selected LLM provider API URL is invalid', 'LLM_API_URL_INVALID');
  }
  const azure = url.hostname.endsWith('.openai.azure.com')
    || Boolean(parameter(parameters, 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION'));
  if (!/\/chat\/completions\/?$/i.test(url.pathname)) {
    const cleanPath = url.pathname.replace(/\/$/, '');
    if (azure && !/\/openai\/deployments\//i.test(cleanPath)) {
      const deployment = parameter(parameters, 'AZURE_OPENAI_DEPLOYMENT', 'OPENAI_DEPLOYMENT') ?? model;
      url.pathname = `${cleanPath}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
    } else {
      url.pathname = `${cleanPath}/chat/completions`;
    }
  }
  if (azure && !url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', parameter(parameters, 'AZURE_OPENAI_API_VERSION', 'OPENAI_API_VERSION') ?? '2024-10-21');
  }
  return { url: url.toString(), azure };
}

function contentFromChoice(choice) {
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === 'string' ? item : item?.text ?? '').join('').trim();
  }
  return '';
}

export function resolveLlmConfiguration(agent) {
  const modelSettings = Object.entries(agent.llm.modelSettings ?? {})
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => ({ key, value: String(value) }));
  const parameters = [...agent.llm.parameters, ...modelSettings];
  const model = agent.llm.modelKey;
  const apiKey = parameter(parameters,
    'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'API_KEY', 'TOKEN', 'AUTH_TOKEN',
  );
  if (!apiKey) throw new AppError(503, 'Selected LLM provider has no API key', 'LLM_API_KEY_MISSING');
  const endpoint = completionEndpoint(agent.llm.baseUrl, parameters, model);
  return {
    providerId: agent.llm.providerId,
    providerName: agent.llm.providerName,
    modelId: agent.llm.modelId,
    model,
    apiKey,
    ...endpoint,
  };
}

export async function invokeAgentLlm(configuration, {
  messages,
  temperature,
  maxOutputTokens = env.LLM_MAX_OUTPUT_TOKENS,
}, fetchImpl = fetch) {
  const startedAt = performance.now();
  let response;
  try {
    response = await measureExternalProvider(configuration.providerName, 'chat-completions', () => fetchImpl(
      configuration.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(configuration.azure
            ? { 'api-key': configuration.apiKey }
            : { authorization: `Bearer ${configuration.apiKey}` }),
        },
        body: JSON.stringify({
          model: configuration.model,
          messages,
          temperature,
          max_tokens: maxOutputTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(env.LLM_REQUEST_TIMEOUT_MS),
      },
    ));
  } catch (error) {
    if (error instanceof AppError) throw error;
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new AppError(
      timedOut ? 504 : 502,
      timedOut ? 'Selected LLM provider timed out' : 'Selected LLM provider is unavailable',
      timedOut ? 'LLM_PROVIDER_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE',
      { provider: configuration.providerName },
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const providerCode = payload?.error?.code ?? payload?.error?.type ?? `HTTP_${response.status}`;
    throw new AppError(502, 'Selected LLM provider request failed', 'LLM_PROVIDER_REQUEST_FAILED', {
      provider: configuration.providerName, providerCode: String(providerCode),
    });
  }
  const answer = contentFromChoice(payload?.choices?.[0]);
  if (!answer) throw new AppError(502, 'Selected LLM provider returned no answer', 'LLM_EMPTY_RESPONSE');
  return {
    answer,
    finishReason: payload.choices[0]?.finish_reason ?? null,
    usage: {
      inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
      outputTokens: Number(payload.usage?.completion_tokens ?? 0),
      totalTokens: Number(payload.usage?.total_tokens ?? 0),
    },
    providerRequestId: response.headers.get('x-request-id') ?? response.headers.get('apim-request-id'),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}
