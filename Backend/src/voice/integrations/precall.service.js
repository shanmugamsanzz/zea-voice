import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errors.js';

function entries(value) {
  return Array.isArray(value)
    ? value.map((item) => [item.key ?? item.name, item.value])
    : Object.entries(value ?? {});
}

function replaceVariables(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/[$][{]([a-zA-Z0-9_.-]+)[}]/g, (_match, key) => String(variables[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => replaceVariables(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceVariables(item, variables)]));
  }
  return value;
}

function requestBody(value, variables) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return replaceVariables(value, variables);
  const replaced = replaceVariables(value, variables);
  try { return JSON.parse(replaced); } catch { return replaced; }
}

function readPath(value, path) {
  return String(path ?? '').split('.').filter((key) => key && key !== '$')
    .reduce((current, key) => current?.[key], value);
}

function mappedContext(response, mappings) {
  const context = {};
  for (const mapping of mappings ?? []) {
    const source = mapping.source ?? mapping.from ?? mapping.path ?? mapping.responseField ?? mapping.response_field;
    const target = mapping.target ?? mapping.to ?? mapping.key ?? mapping.contextKey ?? mapping.context_key;
    if (!source || !target) continue;
    const value = readPath(response, source);
    if (value !== undefined) context[String(target)] = value;
    else if (mapping.default !== undefined) context[String(target)] = mapping.default;
  }
  return context;
}

function configuration(runtimeProfile, variables) {
  const integration = runtimeProfile?.integrations?.preCall ?? {};
  const api = integration.api ?? {};
  if (api.active !== true || !String(api.url ?? '').trim()) return null;
  const url = new URL(replaceVariables(String(api.url).trim(), variables));
  if (!['http:', 'https:'].includes(url.protocol)) throw new AppError(409, 'Pre-call endpoint must use HTTP or HTTPS', 'VOICE_PRECALL_URL_INVALID');
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new AppError(409, 'Pre-call endpoint must use HTTPS in production', 'VOICE_PRECALL_HTTPS_REQUIRED');
  }
  const method = String(api.method ?? 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new AppError(409, 'Pre-call method is unsupported', 'VOICE_PRECALL_METHOD_INVALID');
  const headers = Object.fromEntries(entries(api.headers)
    .map(([key, value]) => [String(key ?? '').trim(), replaceVariables(String(value ?? ''), variables)])
    .filter(([key]) => key));
  if (method !== 'GET' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  return {
    url: url.toString(), method, headers,
    body: requestBody(api.requestBody, variables),
    mappings: api.responseMappings ?? [],
    prompt: integration.prompt ?? '',
  };
}

async function boundedResponse(response) {
  const text = (await response.text()).slice(0, env.VOICE_PRECALL_MAX_RESPONSE_BYTES);
  try { return JSON.parse(text); } catch { return text || null; }
}

export async function executePreCall(runtimeProfile, call, dependencies = {}) {
  const variables = {
    caller: call.from,
    callee: call.to,
    call_uuid: call.providerCallId,
    callId: call.providerCallId,
    agent_id: runtimeProfile.agent.id,
    company_id: runtimeProfile.agent.tenantId,
    workspace_id: runtimeProfile.agent.workspaceId,
    direction: call.direction,
  };
  const startedAt = performance.now();
  let config;
  try { config = configuration(runtimeProfile, variables); } catch (error) {
    return {
      attempted: true, delivered: false, status: null, response: null, context: {},
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: error.message,
    };
  }
  if (!config) return { attempted: false, delivered: false, reason: 'not_configured', context: {}, durationMs: 0 };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.url, {
      method: config.method,
      headers: config.headers,
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? env.VOICE_PRECALL_TIMEOUT_MS),
      ...(config.method !== 'GET' && config.body !== null
        ? { body: typeof config.body === 'string' ? config.body : JSON.stringify(config.body) } : {}),
    });
    const responseBody = await boundedResponse(response);
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    return {
      attempted: true,
      delivered: response.ok,
      status: response.status,
      response: responseBody,
      context: response.ok ? mappedContext(responseBody, config.mappings) : {},
      durationMs,
      error: response.ok ? null : 'Pre-call endpoint returned HTTP ' + response.status,
    };
  } catch (error) {
    return {
      attempted: true, delivered: false, status: null, response: null, context: {},
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: error.message,
    };
  }
}
