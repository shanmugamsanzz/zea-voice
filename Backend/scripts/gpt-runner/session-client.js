import { RunnerError, bounded } from './errors.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const identity = (value) => typeof value === 'string' && UUID.test(value);
export function validateSession(value, expectedAgentId) {
  if (!value || !identity(value.callId) || value.callId !== value.testCallId || !identity(value.agentId)
    || (expectedAgentId && value.agentId !== expectedAgentId)
    || !identity(value.tenantId) || !identity(value.workspaceId)
    || typeof value.token !== 'string' || value.token.length > 8192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.token)
    || value.mediaPath !== '/voice/browser-test/media' || value.protocol !== 'zea.browser-voice.v1') {
    throw new RunnerError('SESSION_INVALID', 'Test session contract is invalid.');
  }
  for (const format of [value.inputFormat, value.outputFormat]) {
    if (format?.encoding !== 'audio/x-mulaw' || format.sampleRate !== 8000 || format.channels !== 1) {
      throw new RunnerError('SESSION_FORMAT', 'Test session audio format is unsupported.');
    }
  }
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new RunnerError('SESSION_EXPIRED', 'Test session has expired.');
  }
  return Object.freeze(value);
}
export function mediaUrl(config, session) {
  const url = new URL(config.apiBaseUrl);
  url.pathname = url.pathname.replace(/\/$/u, '') + session.mediaPath;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('call_id', session.callId); url.searchParams.set('token', session.token);
  return url.toString();
}
export class SessionClient {
  constructor(config, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.config = config; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async request(method, suffix = '', body, signal) {
    try {
      return await bounded(async (timeoutSignal) => {
        const response = await this.fetch(this.config.apiBaseUrl + '/public/browser-test-links/'
          + encodeURIComponent(this.config.shareToken) + suffix, {
          method, redirect: 'error', signal: timeoutSignal,
          headers: { 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new RunnerError('HTTP_REJECTED', 'Test API rejected the request.', { status: response.status });
        const reader = response.body?.getReader();
        if (!reader) throw new RunnerError('HTTP_RESPONSE', 'Test API returned no response body.');
        const parts = []; let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 65536) throw new RunnerError('HTTP_RESPONSE', 'Test API response exceeded its bound.');
            parts.push(Buffer.from(chunk.value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        let envelope; try { envelope = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {
          throw new RunnerError('HTTP_RESPONSE', 'Test API returned invalid JSON.');
        }
        if (envelope?.success !== true || !envelope.data) throw new RunnerError('HTTP_RESPONSE', 'Test API response was unsuccessful.');
        return envelope.data;
      }, { timeoutMs: this.timeoutMs, signal });
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('HTTP_UNAVAILABLE', 'Test API request failed; private details omitted.');
    }
  }
  async lookup(signal) {
    const details = await this.request('GET', '', undefined, signal);
    if (!identity(details.agent?.id) || details.agent.status !== 'active'
      || !['inbound', 'outbound', 'both'].includes(details.agent.agentUsage)) {
      throw new RunnerError('AGENT_INVALID', 'Selected test agent is unavailable.');
    }
    return details;
  }
  async create(details, signal) {
    const direction = details.agent.agentUsage === 'outbound' ? 'outbound' : 'inbound';
    const value = await this.request('POST', '/sessions', { direction }, signal);
    try { return validateSession(value, details.agent.id); } catch (error) {
      // Creation may have succeeded even if the returned contract is invalid.
      if (identity(value?.testCallId)) await this.end(value.testCallId).catch(() => {});
      throw error;
    }
  }
  async end(callId) {
    if (!identity(callId)) throw new RunnerError('SESSION_ID', 'Cleanup requires a valid test call identifier.');
    return this.request('DELETE', '/sessions/' + callId);
  }
}
