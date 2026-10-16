import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { attachPlivoMediaWebSocket } = await import('../src/voice/plivo-media.socket.js');
const { ActiveCallSessionStore } = await import('../src/voice/call-session-store.js');
const { createVoiceMediaToken } = await import('../src/voice/plivo-answer.service.js');
const call = { id: '11111111-1111-4111-8111-111111111111', tenantId: 'tenant-a',
  providerCallId: '22222222-2222-4222-8222-222222222222' };
const secret = 'test-only-signing-secret-at-least-32-characters';
const sessionStore = new ActiveCallSessionStore({ ttlSeconds: 300 });
const server = createServer(); let session; let claimed = 0; let released = 0;
const media = attachPlivoMediaWebSocket(server, {
  sessionStore, loadCallSession: async () => call, tokenOptions: { secret },
  ownership: { claimMedia: async () => { claimed++; }, heartbeat: async () => true,
    release: async () => { released++; } },
  logger: { child() { return this; }, info() {}, warn() {}, error() {}, debug() {} },
  onSession: value => { session = value; },
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `ws://127.0.0.1:${server.address().port}/webhooks/plivo/media?call_id=${call.id}&token=${createVoiceMediaToken(call, { secret })}`;
try {
  const first = new WebSocket(url, 'audio.drachtio.org'); await once(first, 'open');
  session.transferPending = true;
  const firstClosed = once(first, 'close'); session.close(); await firstClosed;
  assert.equal(sessionStore.get(call.id, { touch: false }), null);
  assert.equal(released, 0, 'Handoff stream closure must preserve the call capacity lease');
  const second = new WebSocket(url, 'audio.drachtio.org'); await once(second, 'open');
  assert.equal(claimed, 2, 'The resumed media claims the same existing call lease');
  assert.equal(session.transferPending, undefined);
  const secondClosed = once(second, 'close'); session.close(); await secondClosed;
  assert.equal(released, 1, 'Normal call stream closure still releases ownership');
} finally { await media.close(); await new Promise(resolve => server.close(resolve)); }
console.log('Plivo WebSocket ownership regression passed: handoff retains capacity, old socket is removed, replacement connects, ordinary close still releases. Local WebSocket transport is real; DB and Redis are mocked.');
