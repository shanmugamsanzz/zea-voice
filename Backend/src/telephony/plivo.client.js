import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { measureExternalProvider } from '../performance/performance-context.js';

function authorization(authId, authToken) {
  return `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`;
}

async function plivoRequest(authId, authToken, path, options = {}, fetchImpl = fetch,
  baseUrl = env.PLIVO_API_BASE_URL, operationName = 'request', timeoutMs = env.PROVIDER_REQUEST_TIMEOUT_MS) {
  return measureExternalProvider('plivo', operationName, async () => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        ...options,
        headers: {
          authorization: authorization(authId, authToken), accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppError(502, 'Could not connect to Plivo', 'PLIVO_CONNECTION_FAILED', { cause: error.message });
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new AppError(502, payload?.error || 'Plivo rejected the request', 'PLIVO_REQUEST_FAILED', {
        providerStatus: response.status,
      });
    }
    return payload;
  });
}

export function getPlivoAccountDetails(authId, authToken, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return plivoRequest(authId, authToken, `/Account/${encodeURIComponent(authId)}/`, {
    method: 'GET',
  }, fetchImpl, baseUrl, 'get-account-details', env.PLIVO_BALANCE_REQUEST_TIMEOUT_MS);
}

export function createPlivoSubaccount(authId, authToken, name, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return plivoRequest(authId, authToken, `/Account/${encodeURIComponent(authId)}/Subaccount/`, {
    method: 'POST', body: JSON.stringify({ name, enabled: true }),
  }, fetchImpl, baseUrl, 'create-subaccount');
}

export function deletePlivoSubaccount(authId, authToken, subaccountAuthId, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return plivoRequest(authId, authToken,
    `/Account/${encodeURIComponent(authId)}/Subaccount/${encodeURIComponent(subaccountAuthId)}/?cascade=false`,
    { method: 'DELETE' }, fetchImpl, baseUrl, 'delete-subaccount');
}

export function createPlivoApplication(authId, authToken, input, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return plivoRequest(authId, authToken, `/Account/${encodeURIComponent(authId)}/Application/`, {
    method: 'POST', body: JSON.stringify({
      app_name: input.name, answer_url: input.answerUrl, answer_method: 'POST',
      hangup_url: input.hangupUrl, hangup_method: 'POST', subaccount: input.subaccountAuthId,
    }),
  }, fetchImpl, baseUrl, 'create-application');
}

export function updatePlivoNumber(authId, authToken, number, input, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  const body = {};
  if ('subaccountAuthId' in input) body.subaccount = input.subaccountAuthId;
  if (input.applicationId) body.app_id = input.applicationId;
  if (input.alias) body.alias = input.alias;
  return plivoRequest(authId, authToken,
    `/Account/${encodeURIComponent(authId)}/Number/${encodeURIComponent(String(number).replace(/^\+/, ''))}/`,
    { method: 'POST', body: JSON.stringify(body) }, fetchImpl, baseUrl, 'update-number');
}

export async function listPlivoNumbers(authId, authToken, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return measureExternalProvider('plivo', 'list-numbers', async () => {
    const numbers = [];
    let offset = 0;
    const limit = 20;
    const authHeader = authorization(authId, authToken);

    while (true) {
      const url = `${baseUrl.replace(/\/$/, '')}/Account/${encodeURIComponent(authId)}/Number/?limit=${limit}&offset=${offset}`;
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { authorization: authHeader, accept: 'application/json' },
          signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AppError(502, 'Could not connect to Plivo', 'PLIVO_CONNECTION_FAILED', { cause: error.message });
      }
      if (!response.ok) {
        throw new AppError(502, 'Plivo rejected the number synchronization request', 'PLIVO_SYNC_FAILED', {
          providerStatus: response.status,
        });
      }
      const payload = await response.json();
      const objects = Array.isArray(payload.objects) ? payload.objects : [];
      numbers.push(...objects);
      const total = Number(payload.meta?.total_count ?? numbers.length);
      if (objects.length === 0 || numbers.length >= total) break;
      offset += objects.length;
    }
    return numbers;
  });
}

export async function hangupPlivoCall(authId, authToken, callUuid, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return measureExternalProvider('plivo', 'hangup-call', async () => {
    const authorization = `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`;
    let response;
    try {
      response = await fetchImpl(
      `${baseUrl.replace(/\/$/, '')}/Account/${encodeURIComponent(authId)}/Call/${encodeURIComponent(callUuid)}/`,
      {
        method: 'DELETE',
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    } catch (error) {
      throw new AppError(502, 'Could not connect to Plivo', 'PLIVO_CONNECTION_FAILED', { cause: error.message });
    }
    if (!response.ok) {
      throw new AppError(502, 'Plivo rejected the hangup request', 'PLIVO_HANGUP_FAILED', {
        providerStatus: response.status,
      });
    }
    return { providerStatus: response.status };
  });
}

export async function makePlivoCall(authId, authToken, input, fetchImpl = fetch, baseUrl = env.PLIVO_API_BASE_URL) {
  return measureExternalProvider('plivo', 'make-call', async () => {
    const authorization = `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/Account/${encodeURIComponent(authId)}/Call/`, {
      method: 'POST',
      headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        answer_url: input.answerUrl,
        answer_method: 'POST',
        ring_url: input.ringUrl,
        ring_method: 'POST',
        hangup_url: input.hangupUrl,
        hangup_method: 'POST',
      }),
      signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
    });
    } catch (error) {
      throw new AppError(502, 'Could not connect to Plivo', 'PLIVO_CONNECTION_FAILED', { cause: error.message });
    }
    if (!response.ok) {
      throw new AppError(502, 'Plivo rejected the outbound call', 'PLIVO_CALL_FAILED', {
        providerStatus: response.status,
      });
    }
    const payload = await response.json();
    const requestUuid = payload.request_uuid ?? payload.requestUuid;
    if (!requestUuid) throw new AppError(502, 'Plivo did not return a call identifier', 'PLIVO_RESPONSE_INVALID');
    return { requestUuid, apiId: payload.api_id ?? null, message: payload.message ?? null };
  });
}
