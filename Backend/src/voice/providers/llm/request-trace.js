import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';

// Observe the serialized wire body only. Never change the request or expose
// endpoint query strings, provider configuration, or authentication headers.
export function traceSelectedCallEvent({ stage, data, traceId, input = {}, providerConfig = {}, runtimeContext = {} }, options = {}) {
  try {
    const settings = options.settings ?? env;
    if (settings.LLM_REQUEST_TRACE_ENABLED !== true) return;
    const callId = runtimeContext.callId;
    let fileIds = '';
    if (settings.LLM_REQUEST_TRACE_CALL_IDS_FILE) {
      try { fileIds = readFileSync(settings.LLM_REQUEST_TRACE_CALL_IDS_FILE, 'utf8'); } catch { /* No file means no extra calls. */ }
    }
    const allowed = `${settings.LLM_REQUEST_TRACE_CALL_IDS ?? ''},${fileIds}`
      .split(/[,\s]+/u).map((value) => value.trim()).filter(Boolean);
    if (!callId || !allowed.includes(callId)) return;
    const secrets = Object.values(providerConfig.parameters ?? {})
      .map((value) => String(value ?? '')).filter(Boolean).sort((a, b) => b.length - a.length);
    const scrub = (value) => {
      if (typeof value === 'string') {
        let result = value;
        for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
        return result.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
          .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|AIza[a-zA-Z0-9_-]{20,})\b/g, '[REDACTED]');
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, /^(?:headers|authorization|x[-_]?api[-_]?key|api[-_]?key|password|secret|secretConfiguration|access[-_]?token|refresh[-_]?token)$/i.test(key)
          ? '[REDACTED]' : scrub(item)]));
      return value;
    };
    const identity = input.traceContext ?? runtimeContext.llmTraceContext?.() ?? {};
    (options.log ?? logger).info({
      stage, traceId: traceId ?? randomUUID(), callId,
      turnEpoch: identity.turnEpoch ?? null,
      providerId: providerConfig.providerId, modelId: providerConfig.modelId,
      modelKey: providerConfig.modelKey,
      ...scrub(data),
      credentialsRedacted: true,
    }, 'Selected call diagnostic trace (sensitive caller content)');
    return true;
  } catch {
    // Diagnostics must never fail, retry, or otherwise affect a voice request.
  }
}

export function traceLlmRequest(args, options = {}) {
  try {
    if ((options.settings ?? env).LLM_REQUEST_TRACE_ENABLED !== true) return null;
    const traceId = randomUUID();
    if (!traceSelectedCallEvent({ ...args, stage: 'llm.request_trace', traceId,
      data: { request: JSON.parse(args.body) } }, options)) return null;
    const identity = args.input.traceContext ?? args.runtimeContext.llmTraceContext?.() ?? {};
    const scope = { ...args, input: { traceContext: { ...identity } } };
    // Bounded diagnostic buffer; no accumulation when tracing is disabled.
    const providerEvents = [];
    let size = 0;
    let truncated = false;
    let finished = false;
    return {
      record(payload) {
        try {
          const serialized = JSON.stringify(payload);
          if (size + serialized.length > 1_000_000) { truncated = true; return; }
          providerEvents.push(JSON.parse(serialized));
          size += serialized.length;
        } catch { /* Diagnostics never change streaming. */ }
      },
      finish(status, metadata = {}) {
        if (finished) return;
        finished = true;
        traceSelectedCallEvent({ ...scope, traceId, stage: 'llm.response_trace',
          data: { status, providerEvents, truncated, ...metadata } }, options);
      },
    };
  } catch { return null; }
}
