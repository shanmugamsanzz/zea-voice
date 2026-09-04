import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.VOICE_PROVIDER_MAX_RETRIES = '1';
process.env.VOICE_PROVIDER_RETRY_BASE_MS = '10';

const { createTemplateEngineStructuredInvoker } = await import(
  '../src/voice/realtime-conversation-orchestrator.js'
);

const decision = {
  decision: 'RESPONSE', response: 'Hello.', clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
};
const decisionSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'decision', 'response', 'clarification', 'search', 'tool', 'nextQuestion', 'stateUpdate',
  ],
  properties: {
    decision: { type: 'string', enum: ['RESPONSE'] },
    response: { type: 'string' },
    clarification: { type: 'null' },
    search: { type: 'null' },
    tool: { type: 'null' },
    nextQuestion: { type: 'null' },
    stateUpdate: { type: 'null' },
  },
};
let attempts = 0;
const retryingAdapter = {
  async *stream() {
    attempts += 1;
    if (attempts === 1) {
      yield {
        type: 'error', code: 'LLM_PROVIDER_REQUEST_FAILED',
        message: 'Selected LLM provider request failed', retryable: true,
        details: { providerCode: 'server_error', status: 503 },
      };
      return;
    }
    yield { type: 'text_delta', delta: JSON.stringify(decision) };
    yield { type: 'completed', usage: { totalTokens: 10 } };
  },
  cancel() {},
};
const invoke = createTemplateEngineStructuredInvoker(retryingAdapter);
assert.deepEqual((await invoke({ messages: [], temperature: 0 })).outputParsed, decision);
assert.equal(attempts, 2);

const formats = [];
let fallbackDetails = null;
const schemaRejectingAdapter = {
  async *stream(input) {
    formats.push(input.responseFormat?.type);
    if (formats.length === 1) {
      yield {
        type: 'error', code: 'LLM_PROVIDER_REQUEST_FAILED',
        message: 'Selected LLM provider request failed', retryable: false,
        details: {
          providerCode: 'invalid_json_schema', providerParam: 'response_format', status: 400,
        },
      };
      return;
    }
    yield { type: 'text_delta', delta: JSON.stringify(decision) };
    yield { type: 'completed', usage: { totalTokens: 10 } };
  },
  cancel() {},
};
const schemaFallbackInvoker = createTemplateEngineStructuredInvoker(schemaRejectingAdapter, {
  onResponseFormatFallback: (details) => { fallbackDetails = details; },
});
assert.deepEqual((await schemaFallbackInvoker({
  messages: [], responseFormat: { type: 'json_schema', schema: { type: 'object' } },
})).outputParsed, decision);
assert.deepEqual(formats, ['json_schema', 'json_object']);
assert.equal(fallbackDetails.providerCode, 'invalid_json_schema');

let mixedAttempts = 0;
const harmlessMixedAdapter = {
  async *stream() {
    mixedAttempts += 1;
    yield { type: 'text_delta', delta: JSON.stringify({
      decision: 'response', response: 'Hello.',
      clarification: { question: 'Inactive?', reason: null, candidates: [] },
      search: { query: 'inactive', requestedFact: null, contextualReference: null },
      tool: { name: 'inactive_action', arguments: {} },
      nextQuestion: null,
      providerAnnotation: 'ignored',
    }) };
    yield { type: 'completed', finishReason: 'stop', usage: { totalTokens: 10 } };
  },
  cancel() {},
};
const normalizedMixed = await createTemplateEngineStructuredInvoker(harmlessMixedAdapter)({
  messages: [], responseFormat: { type: 'json_schema', schema: decisionSchema },
});
assert.equal(mixedAttempts, 1,
  'A recoverable mixed provider envelope must not consume the malformed-output retry');
assert.deepEqual(normalizedMixed.outputParsed, decision);

let rejectedAttempts = 0;
const rejectedAdapter = {
  async *stream() {
    rejectedAttempts += 1;
    yield {
      type: 'error', code: 'LLM_PROVIDER_REQUEST_FAILED',
      message: 'Selected LLM provider request failed', retryable: false,
      details: {
        providerCode: 'invalid_json_schema', providerParam: 'response_format', status: 400,
      },
    };
  },
  cancel() {},
};
await assert.rejects(
  () => createTemplateEngineStructuredInvoker(rejectedAdapter)({ messages: [] }),
  (error) => error.code === 'LLM_PROVIDER_REQUEST_FAILED'
    && error.retryable === false
    && error.details?.providerCode === 'invalid_json_schema'
    && error.details?.providerParam === 'response_format',
);
assert.equal(rejectedAttempts, 1);

for (const failure of [
  { name: 'empty', events: [{ type: 'completed', finishReason: 'stop' }], code: 'TEMPLATE_ENGINE_LLM_EMPTY' },
  { name: 'malformed', events: [
    { type: 'text_delta', delta: '{"decision":' },
    { type: 'completed', finishReason: 'stop' },
  ], code: 'TEMPLATE_ENGINE_LLM_INVALID_JSON' },
  { name: 'truncated', events: [
    { type: 'text_delta', delta: JSON.stringify(decision) },
    { type: 'completed', finishReason: 'length' },
  ], code: 'TEMPLATE_ENGINE_LLM_TRUNCATED' },
  { name: 'incomplete', events: [
    { type: 'text_delta', delta: JSON.stringify(decision) },
  ], code: 'TEMPLATE_ENGINE_LLM_INCOMPLETE' },
  { name: 'schema-invalid', events: [
    { type: 'text_delta', delta: JSON.stringify({ decision: 'RESPONSE' }) },
    { type: 'completed', finishReason: 'stop' },
  ], code: 'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID' },
]) {
  const requests = [];
  let structuredRetry = null;
  const adapter = {
    async *stream(input) {
      requests.push(input);
      const events = requests.length === 1 ? failure.events : [
        { type: 'text_delta', delta: JSON.stringify(decision) },
        { type: 'completed', finishReason: 'stop' },
      ];
      for (const event of events) yield event;
    },
    cancel() {},
  };
  const originalMessages = Object.freeze([
    Object.freeze({ role: 'system', content: 'Use the supplied generic schema.' }),
    Object.freeze({ role: 'user', content: 'Final caller utterance' }),
  ]);
  const result = await createTemplateEngineStructuredInvoker(adapter, {
    onStructuredOutputRetry: (details) => { structuredRetry = details; },
  })({
    messages: originalMessages,
    responseFormat: { type: 'json_schema', schema: decisionSchema },
  });
  assert.deepEqual(result.outputParsed, decision, `${failure.name} output was not recovered`);
  assert.equal(requests.length, 2, `${failure.name} output was not retried exactly once`);
  assert.equal(requests[1].responseFormat, requests[0].responseFormat);
  assert.deepEqual(requests[1].messages.slice(0, originalMessages.length), originalMessages,
    `${failure.name} retry did not preserve the finalized caller turn`);
  assert.equal(requests[1].messages.at(-1).role, 'system');
  assert.equal(structuredRetry.code, failure.code);
}

let exhaustedAttempts = 0;
await assert.rejects(() => createTemplateEngineStructuredInvoker({
  async *stream() {
    exhaustedAttempts += 1;
    yield { type: 'completed', finishReason: 'stop' };
  },
  cancel() {},
})({
  messages: [{ role: 'user', content: 'Preserve this caller turn' }],
  responseFormat: { type: 'json_schema', schema: decisionSchema },
}), (error) => error.code === 'TEMPLATE_ENGINE_LLM_EMPTY');
assert.equal(exhaustedAttempts, 2, 'Invalid structured output must be retried only once');

let cancelledAttempts = 0;
await assert.rejects(() => createTemplateEngineStructuredInvoker({
  async *stream() {
    cancelledAttempts += 1;
    yield { type: 'cancelled', reason: 'barge-in' };
  },
  cancel() {},
})({ messages: [{ role: 'user', content: 'Superseded caller turn' }] }),
(error) => error.code === 'TEMPLATE_ENGINE_LLM_CANCELLED');
assert.equal(cancelledAttempts, 1, 'A cancelled turn must never be retried');

console.log('Template-engine provider diagnostics and retry verification passed.');
