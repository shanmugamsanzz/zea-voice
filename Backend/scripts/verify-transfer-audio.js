import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://voice.example.com';
const { waitForTransferPlayback, buildTransferMusicXml, transferMusicUrl } = await import('../src/voice/transfer-audio.js');
const { createCallTransferService } = await import('../src/voice/call-transfer.service.js');
const { plivoWebhookRouter } = await import('../src/telephony/plivo-webhook.routes.js');
const { voiceRouter } = await import('../src/voice/voice.routes.js');
function media() {
  const session = new EventEmitter();
  session.checkpoint = name => { session.checkpointName = name; };
  return session;
}
const session = media(); let confirmed = false;
const ack = waitForTransferPlayback(session).then(result => { confirmed = true; return result; });
session.emit('playedStream', { name: 'unrelated' }); await Promise.resolve(); assert.equal(confirmed, false);
session.emit('playedStream', { name: session.checkpointName }); assert.equal((await ack).confirmed, true);
assert.equal(session.listenerCount('closed'), 0); assert.equal(session.listenerCount('playedStream'), 0);
for (const event of ['closed', 'stop', 'clearedAudio']) {
  const s = media(); const pending = waitForTransferPlayback(s); s.emit(event);
  await assert.rejects(pending, error => error.code === 'TRANSFER_ANNOUNCEMENT_INTERRUPTED');
  assert.equal(s.listenerCount('playedStream'), 0);
}
await assert.rejects(waitForTransferPlayback(media(), { timeoutMs: 5 }), error => error.code === 'TRANSFER_ANNOUNCEMENT_TIMEOUT');
await assert.rejects(waitForTransferPlayback({ closed: true, off() {} }), error => error.code === 'TRANSFER_ANNOUNCEMENT_UNAVAILABLE');

const call = { id: 'call-a', agentId: 'agent-a', tenantId: 'company-a', workspaceId: 'workspace-a', providerCallId: 'provider-a' };
for (const successful of [true, false]) {
  const s = media(); const operations = []; const runtimes = new Map();
  const row = { id: 'transfer-a', state: 'requested', call_id: call.id, mode: 'wait_and_return', auth_id: 'test-account', auth_token_encrypted: 'test-only-token' };
  const service = createCallTransferService({ enabled: true, publicBaseUrl: 'https://voice.example.com', runtimes,
    decrypt: value => value, logger: { info() {}, warn() {} }, ownership: { heartbeat: async () => true },
    repository: { reserve: async () => ({ attempt: row }), get: async () => row,
      transition: async (_, states, state) => { if (!states.includes(row.state)) return null; row.state = state; return row; } },
    transfer: async () => { operations.push('transfer'); return { message: 'transfer executed' }; },
    stopStreams: async () => { operations.push('stop-streams'); },
  });
  service.register({ call,
    pause: async options => { assert.equal(options.announcement, 'Prompt-controlled message'); assert.equal(options.requireAnnouncement, true);
      operations.push('announcement'); await waitForTransferPlayback(s, { timeoutMs: successful ? 1000 : 5 }); operations.push('playback-confirmed'); },
    restore: async () => { operations.push('resume'); },
  });
  const request = service.request(call, { announcement: 'Prompt-controlled message' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(operations, ['announcement'], 'No transfer/stop request may precede playback acknowledgement');
  if (successful) s.emit('playedStream', { name: s.checkpointName });
  const result = await request;
  if (successful) assert.deepEqual(operations, ['announcement', 'playback-confirmed', 'transfer', 'stop-streams']);
  else { assert.equal(result.success, false); assert.deepEqual(operations, ['announcement', 'resume']); }
  service.unregister(call.id);
}

assert.equal(transferMusicUrl('https://voice.example.com/'), 'https://voice.example.com/webhooks/plivo/transfer-music');
assert.match(buildTransferMusicXml('https://voice.example.com'), /<Play loop="0">https:\/\/voice.example.com\/webhooks\/plivo\/hold-music.wav\?seconds=4<\/Play>/);
assert.throws(() => buildTransferMusicXml('http://example.com'), error => error.code === 'TRANSFER_PUBLIC_URL_REQUIRED');
const app = express(); app.use('/webhooks/plivo', voiceRouter, plivoWebhookRouter);
const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${base}/webhooks/plivo/transfer-music`, { method });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /xml/);
    assert.equal(await response.text(), buildTransferMusicXml('https://voice.example.com'));
  }
  const response = await fetch(`${base}/webhooks/plivo/hold-music.wav?seconds=4`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /audio\/wav/);
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.length, 44 + 8000 * 4 * 2); assert.ok(wav.subarray(44).some(value => value !== 0));
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('Transfer audio passed: announcement-before-dial, exact checkpoint ACK, timeout/closed/cleared handling, listener cleanup, no handoff on missing ACK, HTTPS music XML and real local XML/WAV endpoints. Provider/DB are mocked.');
