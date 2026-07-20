import { beginApiMeasurement, finishApiMeasurement } from './performance';
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
// The first phone assignment provisions a Plivo subaccount and application
// before transferring the number, so allow enough time for provider calls.
const REQUEST_TIMEOUT_MS = 45_000;

type ApiRequestInit = RequestInit & { zeaCache?: 'default' | 'reload' | 'bypass' };

type ApiEnvelope<T> = { success: boolean; data: T; error?: { message?: string } };

export function getAccessToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string | null, resetCache = false) {
  if (resetCache) clearApiCache();
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function responseBody<T>(response: Response): Promise<ApiEnvelope<T>> {
  const body = await response.json().catch(() => ({ success: false })) as ApiEnvelope<T>;
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
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

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function refreshAccessToken() {
  const response = await request(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await responseBody<{ accessToken: string }>(response);
  setAccessToken(body.data.accessToken);
  return body.data.accessToken;
}

function notifySessionExpired() {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
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
      try {
        await refreshAccessToken();
        return networkApiRequest<T>(path, init, false);
      } catch {
        setAccessToken(null, true);
        notifySessionExpired();
      }
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
    return queryClient.ensureQueryData({
      queryKey: apiQueryKey(path, headers),
      queryFn: ({ signal }) => networkApiRequest<T>(path, { ...init, signal }, retry),
      staleTime: apiStaleTime(path),
      revalidateIfStale: true,
    });
  }

  const data = await networkApiRequest<T>(path, init, retry);
  if (method !== 'GET') await invalidateApiResource(path);
  return data;
}

export function uploadApiFormData<T>(path: string, body: FormData, onProgress: (percent: number) => void) {
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
      let envelope: ApiEnvelope<T> | null = null;
      try { envelope = JSON.parse(request.responseText) as ApiEnvelope<T>; } catch { /* handled below */ }
      if (request.status < 200 || request.status >= 300 || !envelope?.success) {
        reject(new Error(envelope?.error?.message || `Request failed (${request.status})`));
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

export async function login(email: string, password: string) {
  const data = await apiRequest<{
    accessToken: string;
    accessExpiresAt: string;
    user: { id: string; email: string; firstName: string; lastName: string; role: string };
  }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
  setAccessToken(data.accessToken, true);
  return data;
}

export async function logout() {
  try { await apiRequest<void>('/auth/logout', { method: 'POST', body: '{}' }, false); } catch {
    // Local logout must still finish when the API is temporarily unreachable.
  } finally { setAccessToken(null, true); }
}
