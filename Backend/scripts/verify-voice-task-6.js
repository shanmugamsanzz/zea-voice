import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://api.voice.zeacrm.com';

const { createVoiceMediaToken, validateVoiceMediaToken } = await import('../src/voice/plivo-answer.service.js');
const { ActiveCallSessionStore } = await import('../src/voice/call-session-store.js');
const { attachPlivoMediaWebSocket } = await import('../src/voice/plivo-media.socket.js');

const secret = 'voice-task-6-signing-secret-at-least-32-characters';
const call = {
  id: '00000000-0000-4000-8000-000000000061', tenantId: 'tenant-1', workspaceId: 'workspace-1',
  providerCallId: '00000000-0000-4000-8000-000000000062', agentId: 'agent-1',
  from: '+919000000001', to: '+918000000001', direction: 'inbound', status: 'connected',
};
const now = Date.now();
const token = createVoiceMediaToken(call, { secret, now });
assert.equal(validateVoiceMediaToken(token, call.id, { secret, now }).providerCallId, call.providerCallId);
assert.throws(
  () => validateVoiceMediaToken(`${token.slice(0, -1)}x`, call.id, { secret, now }),
  (error) => error.code === 'VOICE_MEDIA_TOKEN_INVALID',
);
assert.throws(
  () => validateVoiceMediaToken(token, call.id, { secret, now: now + 121_000 }),
  (error) => error.code === 'VOICE_MEDIA_TOKEN_EXPIRED',
);

const httpServer = createServer((_request, response) => response.writeHead(404).end());
const sessionStore = new ActiveCallSessionStore({ ttlSeconds: 300 });
let mediaSession;
let resolveSession;
const sessionReady = new Promise((resolve) => { resolveSession = resolve; });
const quietLogger = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {} };
const ownershipEvents = [];
const ownership = {
  async claimMedia(input) { ownershipEvents.push(['claim', input]); return true; },
  async heartbeat(input) { ownershipEvents.push(['heartbeat', input]); return true; },
  async release(input) { ownershipEvents.push(['release', input]); return true; },
};
const runtime = attachPlivoMediaWebSocket(httpServer, {
  sessionStore,
  logger: quietLogger,
  tokenOptions: { secret, now },
  ownership,
  loadCallSession: async (callId) => {
    assert.equal(callId, call.id);
    return call;
  },
  onSession(session) { mediaSession = session; resolveSession(session); },
});
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const port = httpServer.address().port;

const client = new WebSocket(
  `ws://127.0.0.1:${port}/webhooks/plivo/media?call_id=${call.id}&token=${encodeURIComponent(token)}`,
  'audio.drachtio.org',
);
await once(client, 'open');
await sessionReady;
assert.equal(client.protocol, 'audio.drachtio.org');
assert.equal(sessionStore.get(call.id), mediaSession);
assert.equal(runtime.sessionCount, 1);

const duplicate = new WebSocket(
  `ws://127.0.0.1:${port}/webhooks/plivo/media?call_id=${call.id}&token=${encodeURIComponent(token)}`,
  'audio.drachtio.org',
);
const [, duplicateResponse] = await once(duplicate, 'unexpected-response');
assert.equal(duplicateResponse.statusCode, 409);
duplicateResponse.destroy();

const startReceived = once(mediaSession, 'start');
client.send(JSON.stringify({
  event: 'start', sequenceNumber: 1,
  start: {
    callId: call.providerCallId, streamId: '00000000-0000-4000-8000-000000000063', accountId: 'MA123',
    tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
  },
}));
await startReceived;

const callerAudio = Buffer.alloc(160, 0xff);
const mediaReceived = once(mediaSession, 'media');
client.send(JSON.stringify({
  event: 'media', sequenceNumber: 2, streamId: mediaSession.streamId,
  media: { track: 'inbound', timestamp: '100', chunk: 1, payload: callerAudio.toString('base64') },
}));
const [mediaEvent] = await mediaReceived;
assert.deepEqual(mediaEvent.audio, callerAudio);

const dtmfReceived = once(mediaSession, 'dtmf');
client.send(JSON.stringify({
  event: 'dtmf', sequenceNumber: 3, streamId: mediaSession.streamId,
  dtmf: { track: 'inbound', digit: '5', timestamp: '120' },
}));
assert.equal((await dtmfReceived)[0].digit, '5');

const outbound = [];
client.on('message', (data) => outbound.push(JSON.parse(data.toString('utf8'))));
mediaSession.sendAudio(Buffer.alloc(160, 0x7f));
mediaSession.checkpoint('response-1');
mediaSession.clearAudio('caller_barge_in');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(outbound.map((event) => event.event), ['playAudio', 'checkpoint', 'clearAudio']);
assert.equal(Buffer.from(outbound[0].media.payload, 'base64').length, 160);
assert.equal(outbound[2].streamId, mediaSession.streamId);

const closed = once(client, 'close');
client.send(JSON.stringify({ event: 'stop', sequenceNumber: 4, streamId: mediaSession.streamId }));
await closed;
assert.equal(sessionStore.get(call.id, { touch: false }), null);
assert.equal(runtime.sessionCount, 0);
assert.equal(ownershipEvents[0][0], 'claim');
assert.equal(ownershipEvents.some(([event]) => event === 'release'), true);

const unauthorized = new WebSocket(
  `ws://127.0.0.1:${port}/webhooks/plivo/media?call_id=${call.id}&token=invalid`,
  'audio.drachtio.org',
);
const [, response] = await once(unauthorized, 'unexpected-response');
assert.equal(response.statusCode, 401);
response.destroy();

await runtime.close();
await new Promise((resolve) => httpServer.close(resolve));
console.log(JSON.stringify({ success: true, task: 'Voice Task 6 - authenticated Plivo media WebSocket' }));
