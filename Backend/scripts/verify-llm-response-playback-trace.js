import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { traceLlmRequest, traceSelectedCallEvent } = await import('../src/voice/providers/llm/request-trace.js');
const { createHumanLogStream } = await import('../src/config/human-log-stream.js');
const settings = { LLM_REQUEST_TRACE_ENABLED: true, LLM_REQUEST_TRACE_CALL_IDS: 'test-call' };
const args = { body: '{"messages":[]}', input: { traceContext: { turnEpoch: 7 } },
  providerConfig: { parameters: { API_KEY: 'private-test-key' } }, runtimeContext: { callId: 'test-call' } };
const events = [];
const options = { settings, log: { info(event) { events.push(event); } } };
for (const status of ['completed', 'cancelled', 'failed', 'interrupted']) {
  const recorder = traceLlmRequest(args, options);
  const payload = { choices: [{ delta: { content: 'private-test-key Hello.' } }] };
  recorder.record(payload);
  payload.choices[0].delta.content = 'mutated';
  recorder.finish(status, { providerRequestId: 'provider-request' });
  recorder.finish(status);
  const response = events.at(-1);
  assert.equal(response.traceId, events.at(-2).traceId);
  assert.equal(response.status, status);
  assert.equal(response.callId, 'test-call');
  assert.equal(response.turnEpoch, 7);
  assert.equal(response.providerEvents[0].choices[0].delta.content, '[REDACTED] Hello.');
}
assert.equal(events.length, 8, 'Exactly one request and terminal trace per invocation');
const bounded = traceLlmRequest(args, options);
bounded.record({ text: 'x'.repeat(1_000_001) });
bounded.finish('completed');
assert.equal(events.at(-1).truncated, true);
assert.deepEqual(events.at(-1).providerEvents, []);
const count = events.length;
traceSelectedCallEvent({ ...args, stage: 'voice.turn_trace', data: { event: 'tool_result',
  results: [{ success: true, output: { headers: { authorization: 'do-not-log' }, requestId: 'saved-1' } }] } }, options);
assert.equal(events.length, count + 1);
assert.equal(events.at(-1).results[0].output.headers, '[REDACTED]');
assert.equal(events.at(-1).results[0].output.requestId, 'saved-1');
traceSelectedCallEvent({ ...args, stage: 'voice.playback_trace', data: { event: 'playback_interrupted' } },
  { ...options, settings: { ...settings, LLM_REQUEST_TRACE_ENABLED: false } });
assert.equal(events.length, count + 1);
for (const stage of ['llm.request_trace', 'llm.response_trace', 'voice.turn_trace', 'voice.playback_trace']) {
  let output = '';
  const event = { stage, speech: 'x'.repeat(5000) };
  createHumanLogStream({ write(value) { output += value; } }).write(JSON.stringify(event));
  assert.deepEqual(JSON.parse(output), event);
}
assert.doesNotThrow(() => {
  const recorder = traceLlmRequest(args, options);
  recorder.record({ value: 1n });
  recorder.finish('failed');
});
// Ensure the actual orchestrator paths remain wired (not just the emitter).
const source = await readFile(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
for (const event of ['final_speech', 'final_transcript', 'tool_result', 'sentence_queued',
  'tts_text_submitted', 'transport_packet_sent', 'playback_interrupted', 'playback_drained',
  'configured_quick_reply', 'cached_technical_fallback']) assert.ok(source.includes(`'${event}'`), event);
// Exercise actual audio transport metrics and confirm trace recording changes no bytes.
const { AudioPacer } = await import('../src/voice/audio/audio-pacer.js');
const { FramedAudioQueue } = await import('../src/voice/audio/framed-audio-queue.js');
const queue = new FramedAudioQueue({ maxFrames: 10, maxBytes: 1000, maxBufferedMs: 1000 });
const sent = [];
const packets = [];
const pacer = new AudioPacer({ queue, preRollMs: 0, lowWaterMs: 0, packetDurationMs: 20,
  send: async (frame) => sent.push(Buffer.from(frame.data)), shouldSend: () => true,
  onPlaybackMetric(metric) {
    if (metric.type !== 'websocket_delivery') return;
    packets.push(metric);
    traceSelectedCallEvent({ ...args, stage: 'voice.playback_trace',
      data: { event: 'transport_packet_sent', generationId: metric.generationId,
        bytes: metric.packetBytes } }, options);
  },
});
pacer.start();
try {
  await queue.enqueue({ data: Buffer.from([1, 2, 3]), durationMs: 20,
    generationId: 'turn-7-sentence-1', playbackGroupId: 'turn-7', cancellationVersion: 0 });
  const started = Date.now();
  while (!packets.length) {
    assert.ok(Date.now() - started < 2000, 'Transport send timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(sent, [Buffer.from([1, 2, 3])]);
  assert.equal(packets[0].generationId, 'turn-7-sentence-1');
  assert.equal(events.at(-1).generationId, 'turn-7-sentence-1');
  assert.equal(events.at(-1).bytes, 3);
} finally { queue.close(); await pacer.stop(); }
console.log('Response/playback traces: correlation, terminal states, redaction, bounded buffers, disabled mode, full JSON and runtime hooks passed.');
