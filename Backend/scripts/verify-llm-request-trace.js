import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.LLM_REQUEST_TRACE_ENABLED = 'true';
process.env.LLM_REQUEST_TRACE_CALL_IDS = 'selected-call';
const { traceLlmRequest } = await import('../src/voice/providers/llm/request-trace.js');
const { createHumanLogStream } = await import('../src/config/human-log-stream.js');
const events = [];
const log = { info: (event) => events.push(event) };
const settings = { LLM_REQUEST_TRACE_ENABLED: true, LLM_REQUEST_TRACE_CALL_IDS: 'selected-call' };
const payload = { model: 'test-model', messages: [
  { role: 'system', content: 'Prompt; history; KB; workflow. test-private-key' },
  { role: 'user', content: 'What services?' },
], temperature: 0, tools: [], response_format: { type: 'json_object' } };
const body = JSON.stringify(payload);
const input = { traceContext: { turnEpoch: 5 } };
const args = { body, input, providerConfig: { modelKey: 'test-model', parameters: { API_KEY: 'test-private-key' } },
  runtimeContext: { callId: 'selected-call' } };
traceLlmRequest(args, { log, settings: { ...settings, LLM_REQUEST_TRACE_ENABLED: false } });
traceLlmRequest(args, { log, settings: { ...settings, LLM_REQUEST_TRACE_CALL_IDS: '' } });
traceLlmRequest({ ...args, runtimeContext: { callId: 'other-call' } }, { log, settings });
assert.equal(events.length, 0);
traceLlmRequest(args, { log, settings });
assert.equal(events.length, 1);
assert.equal(events[0].turnEpoch, 5);
assert.equal(events[0].request.messages[1].content, 'What services?');
assert.ok(!JSON.stringify(events).includes('test-private-key'));
assert.equal(body, JSON.stringify(payload));
assert.deepEqual(input, { traceContext: { turnEpoch: 5 } });
assert.doesNotThrow(() => traceLlmRequest(args, { settings, log: { info() { throw Error('logging broken'); } } }));
const dir = mkdtempSync(join(tmpdir(), 'zea-trace-'));
try {
  const file = join(dir, 'calls');
  const fileSettings = { ...settings, LLM_REQUEST_TRACE_CALL_IDS: '', LLM_REQUEST_TRACE_CALL_IDS_FILE: file };
  traceLlmRequest(args, { log, settings: fileSettings });
  assert.equal(events.length, 1);
  writeFileSync(file, 'selected-call\n');
  traceLlmRequest(args, { log, settings: fileSettings });
  assert.equal(events.length, 2);
  writeFileSync(file, '');
  traceLlmRequest(args, { log, settings: fileSettings });
  assert.equal(events.length, 2);
} finally { rmSync(dir, { recursive: true }); }
let output = '';
const longEvent = { stage: 'llm.request_trace', request: { content: 'x'.repeat(4000) } };
createHumanLogStream({ write(value) { output += value; } }).write(JSON.stringify(longEvent));
assert.deepEqual(JSON.parse(output), longEvent);
// Verify capture at the actual adapter boundary matches the wire request.
const { logger } = await import('../src/config/logger.js');
const { createOpenAiCompatibleLlmAdapter } = await import('../src/voice/providers/llm/openai-compatible.adapter.js');
const originalInfo = logger.info;
const captured = [];
let wire;
logger.info = (event) => captured.push(event);
try {
  const adapter = createOpenAiCompatibleLlmAdapter({
    providerConfig: { providerId: 'trace-provider', providerName: 'OpenAI',
      modelId: 'trace-model', modelKey: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1/chat/completions', modelSettings: {},
      parameters: { OPENAI_API_KEY: 'test-private-key' } },
    runtimeContext: { callId: 'selected-call', fetchImpl: async (_url, options) => {
      wire = JSON.parse(options.body);
      assert.equal(captured.length, 1, 'Trace emitted before fetch');
      assert.equal(options.headers.authorization, 'Bearer test-private-key');
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } },
  });
  const messages = [{ role: 'system', content: 'Prompt, KB, history and workflow' },
    { role: 'user', content: 'Services?' }];
  const received = [];
  for await (const event of adapter.stream({ messages, temperature: 0,
    maxOutputTokens: 100, traceContext: { turnEpoch: 5 } })) received.push(event);
  assert.deepEqual(captured[0].request, wire);
  const responseTrace = captured.find((event) => event.stage === 'llm.response_trace');
  assert.equal(responseTrace.traceId, captured[0].traceId);
  assert.equal(responseTrace.turnEpoch, 5);
  assert.equal(responseTrace.status, 'completed');
  assert.equal(responseTrace.providerEvents[0].choices[0].delta.content, 'ok');
  assert.deepEqual(wire.messages, messages);
  assert.equal(captured[0].turnEpoch, 5);
  assert.equal(wire.traceContext, undefined, 'Trace metadata never sent to provider');
  assert.ok(received.some((event) => event.type === 'text_delta' && event.delta === 'ok'));
  assert.ok(!JSON.stringify(captured).includes('test-private-key'));
  await adapter.close();
} finally { logger.info = originalInfo; }
console.log('LLM request tracing: opt-in, isolation, redaction, unchanged input, failure isolation, dynamic selection and full output passed.');
