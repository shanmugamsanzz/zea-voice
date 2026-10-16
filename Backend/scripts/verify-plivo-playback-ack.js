import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PlivoMediaSession } from '../src/voice/plivo-media.socket.js';
import { waitForTransferPlayback } from '../src/voice/transfer-audio.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code, reason) { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
}
async function session() {
  const socket = new Socket();
  const events = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level,
    data => events.push({ level, ...data })]));
  const media = new PlivoMediaSession({ socket, call: { id: 'call-test', providerCallId: 'provider-test' }, log });
  const receive = async event => {
    socket.emit('message', Buffer.from(JSON.stringify(event)), false);
    await media.processing;
  };
  await receive({ event: 'start', sequenceNumber: 1,
    start: { streamId: 'stream-test', callId: 'provider-test',
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } });
  return { socket, media, events, receive };
}

// Real transport parser, not a synthesized EventEmitter ACK: legacy and modern
// control replies must reach the transfer wait even after newer audio arrived.
for (const [type, sequenceNumber] of [['played', undefined], ['playedStream', 0],
  ['playedStream', 20], ['playedStream', 101]]) {
  const { socket, media, events, receive } = await session();
  let audioFrames = 0;
  media.on('media', () => audioFrames++);
  const frame = seq => ({ event: 'media', streamId: 'stream-test', sequenceNumber: seq,
    media: { track: 'inbound', payload: Buffer.alloc(160, 255).toString('base64') } });
  await receive(frame(100));
  const waiting = waitForTransferPlayback(media, { timeoutMs: 1000 });
  const checkpoint = socket.sent.at(-1).name;
  await receive({ event: type, streamId: 'stream-test', sequenceNumber, name: 'unrequested' });
  assert.equal(media.pendingCheckpoints.has(checkpoint), true);
  await receive({ event: type, streamId: 'stream-test', sequenceNumber, name: checkpoint });
  await waiting;
  assert.equal(media.pendingCheckpoints.size, 0);
  assert.ok(events.some(event => event.stage === 'voice.playback_ack_received'));
  assert.equal(media.lastSequence, 100, 'Control replies cannot move the audio sequence high-water mark');
  let duplicates = 0;
  media.on('playedStream', () => duplicates++);
  await receive({ event: type, streamId: 'stream-test', sequenceNumber, name: checkpoint });
  assert.equal(duplicates, 0);
  await receive(frame(99)); await receive(frame(101));
  assert.equal(audioFrames, 2, 'Stale audio is still rejected; next audio still passes');
  assert.equal(media.closed, false);
  media.close();
}

// Missing/wrong stream cannot satisfy a pending checkpoint.
for (const streamId of [undefined, 'wrong-stream']) {
  const { media, socket, receive } = await session();
  let acknowledged = false;
  const waiting = waitForTransferPlayback(media, { timeoutMs: 20 });
  const rejection = assert.rejects(waiting, error => ['TRANSFER_ANNOUNCEMENT_TIMEOUT',
    'TRANSFER_ANNOUNCEMENT_INTERRUPTED'].includes(error.code));
  media.on('playedStream', () => { acknowledged = true; });
  await receive({ event: 'played', streamId, name: socket.sent.at(-1).name });
  await rejection;
  assert.equal(acknowledged, false);
  media.close();
}

// A real clear acknowledgement with zero sequence interrupts the wait safely.
{
  const { media, receive } = await session();
  const waiting = waitForTransferPlayback(media, { timeoutMs: 1000 });
  const rejected = assert.rejects(waiting, { code: 'TRANSFER_ANNOUNCEMENT_INTERRUPTED' });
  await receive({ event: 'clearedAudio', streamId: 'stream-test', sequenceNumber: 0 });
  await rejected;
  media.close();
}
{
  const { media, socket, receive } = await session();
  media.checkpoint('cleared-checkpoint');
  media.clearAudio();
  let acknowledged = false;
  media.on('playedStream', () => { acknowledged = true; });
  await receive({ event: 'played', streamId: 'stream-test', name: 'cleared-checkpoint' });
  assert.equal(acknowledged, false);
  assert.equal(socket.sent.at(-1).event, 'clearAudio');
  media.close();
}
console.log('Plivo playback ACK compatibility passed: legacy/modern replies, stale/zero sequence, checkpoint matching, duplicate rejection, stream isolation, clear cancellation and unchanged audio ordering.');
