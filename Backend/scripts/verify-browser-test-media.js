import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createBrowserTestMediaToken, validateBrowserTestMediaToken } =
  await import('../src/voice/browser-test-token.js');
const { ActiveCallSessionStore } = await import('../src/voice/call-session-store.js');
const { attachBrowserTestMediaWebSocket } = await import('../src/voice/browser-test-media.socket.js');

const secret = 'browser-test-signing-secret-at-least-32-characters';
const now = Date.now();
const identity = {
  callId: '10000000-0000-4000-8000-000000000001',
  testCallId: '10000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000002',
  workspaceId: '10000000-0000-4000-8000-000000000003',
  agentId: '10000000-0000-4000-8000-000000000004',
  userId: '10000000-0000-4000-8000-000000000005',
  nonce: 'single-use-browser-test-nonce',
};
const call = {
  id: identity.callId,
  tenantId: identity.tenantId,
  workspaceId: identity.workspaceId,
  providerCallId: `browser-test-${identity.callId}`,
  agentId: identity.agentId,
  from: '+10000000000', to: '+10000000001', direction: 'inbound', status: 'connected',
  providerMetadata: { source: 'browser_test' },
};
const token = createBrowserTestMediaToken(identity, { secret, now });
const claims = validateBrowserTestMediaToken(token, identity.callId, { secret, now });
assert.equal(claims.tenantId, identity.tenantId);
assert.equal(claims.agentId, identity.agentId);
assert.throws(() => validateBrowserTestMediaToken(`${token.slice(0, -1)}x`, identity.callId,
  { secret, now }), (error) => error.code === 'BROWSER_TEST_TOKEN_INVALID');
assert.throws(() => validateBrowserTestMediaToken(token, identity.callId,
  { secret, now: now + 121_000 }), (error) => error.code === 'BROWSER_TEST_TOKEN_EXPIRED');

const server = createServer((_request, response) => response.writeHead(404).end());
const sessionStore = new ActiveCallSessionStore({ ttlSeconds: 300 });
let mediaSession;
const claimedCalls = new Set();
let runtimeExceptions = 0;
let audioExceptions = 0;
const sessionReady = new Promise((resolve) => {
  const attachOrchestrator = (session) => { mediaSession = session; resolve(session); };
  const runtime = attachBrowserTestMediaWebSocket(server, {
    sessionStore,
    tokenOptions: { secret, now },
    attachOrchestrator,
    claimSession: async (callId, supplied) => {
      assert.equal(callId, identity.callId);
      for (const key of ['tenantId', 'workspaceId', 'agentId', 'userId']) {
        if (supplied[key] !== identity[key]) throw Object.assign(new Error('scope mismatch'), {
          statusCode: 403, code: 'BROWSER_TEST_SCOPE_MISMATCH',
        });
      }
      if (claimedCalls.has(callId)) throw Object.assign(new Error('session already claimed'), {
        statusCode: 409, code: 'BROWSER_TEST_SESSION_UNAVAILABLE',
      });
      claimedCalls.add(callId);
      return call;
    },
    logger: { child() { return this; }, info() {}, warn() {}, error() { runtimeExceptions += 1; }, debug() {} },
    maximumSessionMs: 30_000,
  });
  server.browserRuntime = runtime;
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const client = new WebSocket(
  `ws://127.0.0.1:${port}/voice/browser-test/media?call_id=${identity.callId}&token=${encodeURIComponent(token)}`,
  'zea.browser-voice.v1',
);
const firstMessage = once(client, 'message');
await once(client, 'open');
await sessionReady;
mediaSession.on('failure', () => { audioExceptions += 1; });
const [readyData] = await firstMessage;
assert.equal(JSON.parse(readyData.toString()).event, 'ready');
assert.equal(client.protocol, 'zea.browser-voice.v1');
assert.equal(mediaSession.transport, 'browser_test');
assert.equal(sessionStore.get(identity.callId), mediaSession);

const inbound = Buffer.alloc(160, 0xff);
const mediaReceived = once(mediaSession, 'media');
client.send(JSON.stringify({ event: 'media', media: {
  contentType: 'audio/x-mulaw', sampleRate: 8000, payload: inbound.toString('base64'),
} }));
assert.deepEqual((await mediaReceived)[0].audio, inbound);
assert.equal(inbound.length, 160, '20 ms of 8 kHz mu-law microphone audio must remain intact');

const outbound = [];
client.on('message', (data) => outbound.push(JSON.parse(data.toString())));
await mediaSession.sendAudio(Buffer.alloc(160, 0x7f));
mediaSession.checkpoint('answer-1');
mediaSession.clearAudio('caller_barge_in');
await mediaSession.sendDiagnostic('latency', { totalFirstAudioMs: 740 });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(outbound.map((event) => event.event),
  ['audio', 'checkpoint', 'clearAudio', 'diagnostic']);
assert.equal(outbound[3].diagnostic.totalFirstAudioMs, 740);

const closed = once(client, 'close');
client.send(JSON.stringify({ event: 'stop' }));
await closed;
assert.equal(sessionStore.get(identity.callId, { touch: false }), null);
assert.equal(server.browserRuntime.sessionCount, 0);
assert.equal(audioExceptions, 0);

const replay = new WebSocket(
  `ws://127.0.0.1:${port}/voice/browser-test/media?call_id=${identity.callId}&token=${encodeURIComponent(token)}`,
  'zea.browser-voice.v1',
);
const [, replayResponse] = await once(replay, 'unexpected-response');
assert.equal(replayResponse.statusCode, 409);
replayResponse.destroy();

const crossTenantIdentity = { ...identity,
  tenantId: '20000000-0000-4000-8000-000000000002', nonce: 'foreign-tenant-nonce' };
const crossTenantToken = createBrowserTestMediaToken(crossTenantIdentity, { secret, now });
const unauthorized = new WebSocket(
  `ws://127.0.0.1:${port}/voice/browser-test/media?call_id=${identity.callId}&token=${encodeURIComponent(crossTenantToken)}`,
  'zea.browser-voice.v1',
);
const [, response] = await once(unauthorized, 'unexpected-response');
assert.equal(response.statusCode, 403);
response.destroy();

const missingToken = new WebSocket(
  `ws://127.0.0.1:${port}/voice/browser-test/media?call_id=${identity.callId}`,
  'zea.browser-voice.v1',
);
const [, missingTokenResponse] = await once(missingToken, 'unexpected-response');
assert.equal(missingTokenResponse.statusCode, 401);
missingTokenResponse.destroy();

const wrongProtocol = new WebSocket(
  `ws://127.0.0.1:${port}/voice/browser-test/media?call_id=${identity.callId}&token=${encodeURIComponent(token)}`,
);
const [, wrongProtocolResponse] = await once(wrongProtocol, 'unexpected-response');
assert.equal(wrongProtocolResponse.statusCode, 426);
wrongProtocolResponse.destroy();

await server.browserRuntime.close();
await new Promise((resolve) => server.close(resolve));
console.log(JSON.stringify({ success: true, task: 'isolated browser test media transport',
  sameOrchestratorContract: true, crossTenantRejected: true, tokenReplayRejected: true,
  missingTokenRejected: true, wrongProtocolRejected: true, disconnectCleanup: true,
  microphoneMulawPreserved: true, interruptionClearVerified: true,
  runtimeExceptions, audioExceptions }));
