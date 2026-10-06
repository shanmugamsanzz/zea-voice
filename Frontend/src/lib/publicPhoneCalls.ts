export interface SharedPhoneAgent { agentName: string; expiresAt: string | null; permanent: boolean; }
export interface SharedPhoneRequest { id: string; status: 'queued' | 'dispatching' | 'initiated' | 'failed' | 'canceled'; reason?: string; }
export class PublicPhoneApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds = 0) { super(message); }
}
export function sharedPhoneToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function sharedPhonePath(path: string) { return /^\/shared\/phone-call\/?$/.test(path); }
export function unavailablePhoneLink(error: unknown) {
  return error instanceof PublicPhoneApiError && [403, 404, 409].includes(error.status);
}
export function sharedPhoneStatus(request: SharedPhoneRequest): string {
  if (request.status === 'initiated') return 'Your call is starting. Please answer your phone.';
  if (request.status === 'dispatching') return 'Your call is being prepared.';
  if (request.status === 'failed') return 'We could not place this call. Please contact the person who shared the link.';
  if (request.status === 'canceled') return 'This waiting call was canceled.';
  if (request.reason === 'waiting_credits') return 'Your request is saved. Calling is temporarily paused.';
  if (request.reason === 'coordination_unavailable') return 'Your request is saved. Waiting for the calling service.';
  return 'Your call is queued. It will dial automatically when a call slot is available.';
}

// Public calling never imports the authenticated API client, sends its cookies,
// reads dashboard tokens, refreshes sessions, or stores secrets in query caches.
export function createPublicPhoneClient(token: string, options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const base = (options.baseUrl ?? import.meta.env?.VITE_API_BASE_URL ?? 'http://localhost:1112').replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const request = async <T>(path: string, init: RequestInit = {}, receipt?: string): Promise<T> => {
    const timeout = AbortSignal.timeout(45000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetcher(`${base}/public/phone-test-links${path}`, {
      ...init, signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'x-phone-test-share-token': token, ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(receipt ? { 'x-phone-test-request-key': receipt } : {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      const delay = Number(response.headers.get('retry-after') ?? body?.error?.details?.retryAfterSeconds ?? 0);
      throw new PublicPhoneApiError(body?.error?.message || 'Calling is temporarily unavailable. Please try again.', response.status,
        Number.isFinite(delay) && delay > 0 ? delay : 0);
    }
    return body.data as T;
  };
  return {
    metadata: (signal?: AbortSignal) => request<SharedPhoneAgent>('', { signal }),
    call: (phone: string, requestId: string, consent: boolean, website = '', signal?: AbortSignal) =>
      request<SharedPhoneRequest>('/calls', { method: 'POST', body: JSON.stringify({ phone, requestId, consent, website }), signal }),
    status: (id: string, receipt: string, signal?: AbortSignal) =>
      request<SharedPhoneRequest>(`/calls/${encodeURIComponent(id)}`, { signal }, receipt),
  };
}
