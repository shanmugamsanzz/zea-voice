import { beginApiMeasurement, finishApiMeasurement } from './performance';
import { createCrossTabRefreshCoordinator } from './authRefreshCoordinator';
import { isAbortError } from './requestCancellation';
import {
  apiQueryKey,
  apiStaleTime,
  clearApiCache,
  invalidateApiResource,
  isLiveApiPath,
  queryClient,
} from './queryClient';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:1112').replace(/\/$/, '');
const TOKEN_KEY = 'zea_voice_access_token';
export const SESSION_EXPIRED_EVENT = 'zea:session-expired';
const AUTH_CHANNEL_NAME = 'zea_voice_auth';
const AUTH_REFRESH_LOCK_NAME = 'zea_voice_refresh';
// The first phone assignment provisions a Plivo subaccount and application
// before transferring the number, so allow enough time for provider calls.
const REQUEST_TIMEOUT_MS = 45_000;

type ApiRequestInit = RequestInit & { zeaCache?: 'default' | 'reload' | 'bypass' };

type ApiEnvelope<T> = { success: boolean; data: T; error?: { message?: unknown; details?: unknown } };

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

let sessionExpiryNotified = false;
let authLifecycleGeneration = 0;
const authChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL_NAME);

export { isAbortError } from './requestCancellation';

function apiErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    const messages = value.map(apiErrorMessage).filter((message): message is string => Boolean(message));
    return messages.length ? messages.join('; ') : null;
  }
  if (value && typeof value === 'object') {
    const messages = Object.entries(value).flatMap(([field, detail]) => {
      const details = Array.isArray(detail) ? detail : [detail];
      return details.map((item) => {
        const message = apiErrorMessage(item);
        return message ? `${field}: ${message}` : null;
      }).filter((message): message is string => Boolean(message));
    });
    return messages.length ? messages.join('; ') : null;
  }
  return value == null ? null : String(value);
}

export function getAccessToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string | null, resetCache = false) {
  if (resetCache) clearApiCache();
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionExpiryNotified = false;
  }
  else sessionStorage.removeItem(TOKEN_KEY);
}

function expireAuthenticatedSession() {
  authLifecycleGeneration += 1;
  setAccessToken(null, true);
  if (sessionExpiryNotified) return;
  sessionExpiryNotified = true;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  authChannel?.postMessage({ type: 'session-ended', reason: 'expired' });
}

authChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data as { type?: unknown; token?: unknown; reason?: unknown };
  if (message?.type === 'token-refreshed' && typeof message.token === 'string' && message.token.trim()) {
    setAccessToken(message.token.trim());
    return;
  }
  if (message?.type !== 'session-ended') return;
  authLifecycleGeneration += 1;
  setAccessToken(null, true);
  if (sessionExpiryNotified) return;
  sessionExpiryNotified = true;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, {
    detail: { reason: message.reason === 'logout' ? 'logout' : 'expired' },
  }));
});

async function responseBody<T>(response: Response): Promise<ApiEnvelope<T>> {
  const body = await response.json().catch(() => ({ success: false })) as ApiEnvelope<T>;
  if (!response.ok) {
    throw new ApiResponseError(
      apiErrorMessage(body.error?.message) || apiErrorMessage(body.error?.details) || `Request failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

async function request(url: string, init: RequestInit) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (init.signal?.aborted && !timedOut) throw new DOMException('Request aborted', 'AbortError');
    if (timedOut) throw new Error('The backend did not respond before the request timeout.');
    throw new Error('Could not connect to the Zea Voice backend.');
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

async function requestFreshAccessToken() {
  const refreshGeneration = authLifecycleGeneration;
  const response = await request(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await responseBody<{ accessToken: string }>(response);
  const token = String(body.data.accessToken ?? '').trim();
  if (!token) throw new Error('The backend did not return a new access token.');
  if (refreshGeneration !== authLifecycleGeneration) {
    throw new DOMException('Session ended while access was being refreshed', 'AbortError');
  }
  setAccessToken(token);
  authChannel?.postMessage({ type: 'token-refreshed', token });
  return token;
}

/**
 * Refresh-token rotation permits only one use of the current cookie. Keep one
 * in-flight refresh per browser tab so every request that receives a 401 waits
 * for the same rotation instead of racing with its own /auth/refresh request.
 */
const refreshCoordinator = createCrossTabRefreshCoordinator({
  performRefresh: requestFreshAccessToken,
  getCurrentToken: getAccessToken,
  runExclusive: (operation) => navigator.locks?.request
    ? navigator.locks.request(AUTH_REFRESH_LOCK_NAME, operation)
    : operation(),
  // BroadcastChannel delivery is asynchronous. Yield once after receiving the
  // browser lock so a token broadcast from the previous lock owner is applied.
  settlePeerUpdates: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
  isTerminalFailure: (error) => error instanceof ApiResponseError && [401, 403].includes(error.status),
  onTerminalFailure: () => {
    // A first-time visitor has no access token and should reach the login
    // screen silently. Established sessions receive one global event.
    if (getAccessToken()) expireAuthenticatedSession();
  },
});

function refreshAccessToken() {
  return refreshCoordinator.refresh();
}

async function networkApiRequest<T>(path: string, init: ApiRequestInit = {}, retry = true): Promise<T> {
  const measurement = beginApiMeasurement(path, init.method || 'GET');
  let measuredResponse: Response | null = null;
  let measurementFinished = false;
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  const { zeaCache: _zeaCache, ...requestInit } = init;
  const isMultipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (init.body && !isMultipart && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  try {
    const response = await request(`${API_BASE_URL}${path}`, { ...requestInit, headers, credentials: 'include' });
    measuredResponse = response;
    if (response.status === 401 && retry) {
      finishApiMeasurement(measurement, response);
      measurementFinished = true;
      await refreshAccessToken();
      return networkApiRequest<T>(path, init, false);
    }
    return (await responseBody<T>(response)).data;
  } finally {
    if (!measurementFinished) finishApiMeasurement(measurement, measuredResponse);
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}, retry = true): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const cacheMode = init.zeaCache ?? 'default';

  if (method === 'GET' && cacheMode !== 'bypass' && !isLiveApiPath(path)) {
    if (cacheMode === 'reload') {
      queryClient.removeQueries({ queryKey: apiQueryKey(path, headers), exact: true });
    }
    try {
      return await queryClient.ensureQueryData({
        queryKey: apiQueryKey(path, headers),
        queryFn: ({ signal }) => networkApiRequest<T>(path, { ...init, signal }, retry),
        staleTime: apiStaleTime(path),
        revalidateIfStale: true,
      });
    } catch (error) {
      // Cache invalidation can cancel a shared React Query request while the
      // component that requested it is still mounted. Retry that request once
      // outside the cache. Respect explicit component/tab cancellation and do
      // not restart requests after authentication has been cleared.
      if (isAbortError(error) && !init.signal?.aborted && getAccessToken()) {
        return networkApiRequest<T>(path, init, retry);
      }
      throw error;
    }
  }

  const data = await networkApiRequest<T>(path, init, retry);
  if (method !== 'GET') await invalidateApiResource(path);
  return data;
}

export async function apiBlobRequest(path: string, retry = true): Promise<Blob> {
  const token = getAccessToken();
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await request(`${API_BASE_URL}${path}`, { headers, credentials: 'include' });
  if (response.status === 401 && retry) {
    await refreshAccessToken();
    return apiBlobRequest(path, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ success: false })) as ApiEnvelope<never>;
    throw new Error(apiErrorMessage(body.error?.message) || apiErrorMessage(body.error?.details)
      || `Request failed (${response.status})`);
  }
  return response.blob();
}

function uploadApiFormDataAttempt<T>(
  path: string,
  body: FormData,
  onProgress: (percent: number) => void,
  retry: boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE_URL}${path}`);
    request.withCredentials = true;
    request.timeout = REQUEST_TIMEOUT_MS;
    const token = getAccessToken();
    if (token) request.setRequestHeader('authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
      }
    };
    request.onload = () => {
      if (request.status === 401 && retry) {
        void refreshAccessToken()
          .then(() => uploadApiFormDataAttempt<T>(path, body, onProgress, false))
          .then(resolve, reject);
        return;
      }
      let envelope: ApiEnvelope<T> | null = null;
      try { envelope = JSON.parse(request.responseText) as ApiEnvelope<T>; } catch { /* handled below */ }
      if (request.status < 200 || request.status >= 300 || !envelope?.success) {
        reject(new Error(apiErrorMessage(envelope?.error?.message) || apiErrorMessage(envelope?.error?.details)
          || `Request failed (${request.status})`));
        return;
      }
      onProgress(100);
      void invalidateApiResource(path).finally(() => resolve(envelope!.data));
    };
    request.onerror = () => reject(new Error('Could not connect to the Zea Voice backend.'));
    request.ontimeout = () => reject(new Error('The backend did not respond before the request timeout.'));
    request.onabort = () => reject(new DOMException('Request aborted', 'AbortError'));
    request.send(body);
  });
}

export function uploadApiFormData<T>(path: string, body: FormData, onProgress: (percent: number) => void) {
  return uploadApiFormDataAttempt<T>(path, body, onProgress, true);
}

export async function login(email: string, password: string) {
  authLifecycleGeneration += 1;
  const data = await apiRequest<{
    accessToken: string;
    accessExpiresAt: string;
    user: { id: string; email: string; firstName: string; lastName: string; role: string };
  }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
  setAccessToken(data.accessToken, true);
  authChannel?.postMessage({ type: 'token-refreshed', token: data.accessToken });
  return data;
}

export async function logout() {
  const logoutRequest = apiRequest<void>('/auth/logout', { method: 'POST', body: '{}' }, false);
  authLifecycleGeneration += 1;
  setAccessToken(null, true);
  authChannel?.postMessage({ type: 'session-ended', reason: 'logout' });
  try { await logoutRequest; } catch {
    // Local logout must still finish when the API is temporarily unreachable.
  }
}
