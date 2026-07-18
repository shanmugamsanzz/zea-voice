import { env } from '../../config/env.js';

function configuration(runtimeProfile) {
  const settings = runtimeProfile?.agent?.settings ?? {};
  const active = settings.postCallEndpointDetailsActive === true;
  const url = String(settings.postCallApiUrl ?? '').trim();
  if (!active || !url) return null;
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new TypeError('Post-call endpoint must use HTTP or HTTPS');
  const method = String(settings.postCallApiMethod ?? 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw new TypeError('Post-call endpoint method must be POST, PUT, or PATCH');
  const configuredHeaders = settings.postCallApiHeaders ?? [];
  const entries = Array.isArray(configuredHeaders)
    ? configuredHeaders.map((item) => [item.key, item.value])
    : Object.entries(configuredHeaders);
  const headers = Object.fromEntries(entries
    .map(([name, value]) => [String(name ?? '').trim(), String(value ?? '').trim()])
    .filter(([name]) => name));
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  return { url: parsedUrl.toString(), method, headers };
}

async function boundedResponse(response) {
  const text = (await response.text()).slice(0, env.VOICE_POSTCALL_MAX_RESPONSE_BYTES);
  try { return JSON.parse(text); } catch { return text || null; }
}

export async function reportPostCall(runtimeProfile, payload, dependencies = {}) {
  const config = configuration(runtimeProfile);
  if (!config) return { attempted: false, delivered: false, reason: 'not_configured' };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? env.VOICE_POSTCALL_TIMEOUT_MS;
  try {
    const response = await fetchImpl(config.url, {
      method: config.method,
      headers: config.headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseBody = await boundedResponse(response);
    return {
      attempted: true,
      delivered: response.ok,
      status: response.status,
      response: responseBody,
      error: response.ok ? null : `Post-call endpoint returned HTTP ${response.status}`,
    };
  } catch (error) {
    return { attempted: true, delivered: false, status: null, response: null, error: error.message };
  }
}
