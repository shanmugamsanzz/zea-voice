import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { normalizeLlmEvent } from './llm.interface.js';

export class LlmCircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? env.LLM_CIRCUIT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? env.LLM_CIRCUIT_RESET_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.failures = 0;
    this.openedAt = null;
    this.probeActive = false;
  }

  assertAvailable(details = {}) {
    if (this.openedAt === null) return;
    if (this.now() - this.openedAt < this.resetTimeoutMs || this.probeActive) {
      throw new AppError(503, 'Selected LLM provider circuit breaker is open', 'LLM_CIRCUIT_OPEN', details);
    }
    this.probeActive = true;
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.probeActive = false;
  }

  failure() {
    this.probeActive = false;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }
}

const breakers = new Map();

export function getLlmCircuitBreaker(providerConfig, options = {}) {
  if (options.breaker) return options.breaker;
  const key = `${providerConfig.providerId ?? providerConfig.providerSlug ?? providerConfig.providerName}:${providerConfig.modelId ?? providerConfig.modelKey}`;
  if (!breakers.has(key)) breakers.set(key, new LlmCircuitBreaker(options));
  return breakers.get(key);
}

export async function* parseSse(body) {
  if (!body?.getReader) throw new AppError(502, 'LLM provider returned no streaming body', 'LLM_STREAM_MISSING');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parameter(parameters, ...names) {
  const wanted = new Set(names.map((name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  return Object.entries(parameters ?? {}).find(([key]) => (
    wanted.has(key.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  ))?.[1] ?? null;
}

export function setting(settings, ...names) {
  const wanted = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(settings ?? {})) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.some((name) => normalized === name || normalized.endsWith(name))) return value;
  }
  return null;
}

export function createLlmRequestState(providerConfig, runtimeContext = {}) {
  const breaker = getLlmCircuitBreaker(providerConfig, runtimeContext);
  let active = null;
  let closed = false;
  return {
    breaker,
    begin() {
      if (closed) throw new AppError(409, 'LLM adapter is closed', 'LLM_ADAPTER_CLOSED');
      active?.controller.abort('superseded');
      breaker.assertAvailable({ providerId: providerConfig.providerId, modelId: providerConfig.modelId });
      const controller = new AbortController();
      const request = { controller, timedOut: false, cancelled: false };
      const timer = setTimeout(() => {
        request.timedOut = true;
        controller.abort('timeout');
      }, runtimeContext.timeoutMs ?? env.LLM_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      request.finish = () => {
        clearTimeout(timer);
        if (active === request) active = null;
      };
      active = request;
      return request;
    },
    cancel(reason = 'barge-in') {
      if (!active) return false;
      active.cancelled = true;
      active.controller.abort(reason);
      return true;
    },
    close() {
      closed = true;
      this.cancel('closed');
    },
  };
}

export function providerFailure(error, request, providerConfig) {
  if (request?.cancelled) return null;
  if (request?.timedOut) {
    return new AppError(504, 'Selected LLM provider timed out', 'LLM_PROVIDER_TIMEOUT', {
      providerId: providerConfig.providerId, modelId: providerConfig.modelId,
    });
  }
  if (error instanceof AppError) return error;
  return new AppError(502, 'Selected LLM provider is unavailable', 'LLM_PROVIDER_UNAVAILABLE', {
    providerId: providerConfig.providerId, modelId: providerConfig.modelId,
  });
}

export function errorEvent(error, providerConfig) {
  return normalizeLlmEvent({
    type: 'error', code: error.code, message: error.message,
    retryable: error.statusCode >= 500 && error.code !== 'LLM_CIRCUIT_OPEN',
  }, providerConfig);
}

export async function requireStreamingResponse(response, providerConfig) {
  if (response.ok) return response;
  const payload = await response.json().catch(() => null);
  const providerCode = payload?.error?.code ?? payload?.error?.type ?? `HTTP_${response.status}`;
  throw new AppError(502, 'Selected LLM provider request failed', 'LLM_PROVIDER_REQUEST_FAILED', {
    providerId: providerConfig.providerId, modelId: providerConfig.modelId,
    providerCode: String(providerCode), status: response.status,
  });
}

export function parseJson(data) {
  try { return JSON.parse(data); } catch {
    throw new AppError(502, 'LLM provider returned invalid streaming JSON', 'LLM_STREAM_JSON_INVALID');
  }
}
