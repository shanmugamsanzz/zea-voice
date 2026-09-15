import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createTemplateEngineStructuredInvoker } = await import(
  '../src/voice/realtime-conversation-orchestrator.js'
);

const response = {
  outcome: 'CONVERSATIONAL_RESPONSE', speech: 'Hello.', workflowAction: null,
};
const responseSchema = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'speech', 'workflowAction'],
  properties: {
    outcome: { type: 'string', enum: ['CONVERSATIONAL_RESPONSE'] },
    speech: { type: 'string' },
    workflowAction: { type: 'null' },
  },
};

function request() {
  return {
    messages: [{ role: 'user', content: 'Final caller utterance' }],
    responseFormat: { type: 'json_schema', schema: responseSchema },
  };
}

let successfulAttempts = 0;
let baseOutputTokens;
let speechObservedBeforeCompletion = false;
const streamedSpeech = [];
const successful = await createTemplateEngineStructuredInvoker({
  async *stream(input) {
    baseOutputTokens = input.maxOutputTokens;
    successfulAttempts += 1;
    const serialized = JSON.stringify(response);
    const splitAt = serialized.indexOf(',"workflowAction"');
    yield { type: 'text_delta', delta: serialized.slice(0, splitAt) };
    speechObservedBeforeCompletion = streamedSpeech.includes('Hello.');
    yield { type: 'text_delta', delta: serialized.slice(splitAt) };
    yield { type: 'completed', finishReason: 'stop', usage: { totalTokens: 10 } };
  },
  cancel() {},
})(request(), { onSpeechSentence: (sentence) => streamedSpeech.push(sentence) });
assert.deepEqual(successful.outputParsed, response);
assert.equal(successfulAttempts, 1);
assert.ok(baseOutputTokens >= 128);
assert.equal(speechObservedBeforeCompletion, true);
assert.deepEqual(streamedSpeech, ['Hello.']);
assert.equal(successful.speechStreaming.complete, true);
assert.equal(successful.speechStreaming.sentenceCount, 1);

for (const failure of [
  {
    name: 'retryable-provider-error', code: 'LLM_PROVIDER_REQUEST_FAILED',
    events: [{
      type: 'error', code: 'LLM_PROVIDER_REQUEST_FAILED', message: 'temporary failure',
      retryable: true, details: { providerCode: 'server_error', status: 503 },
    }],
  },
  {
    name: 'schema-rejection', code: 'LLM_PROVIDER_REQUEST_FAILED',
    events: [{
      type: 'error', code: 'LLM_PROVIDER_REQUEST_FAILED', message: 'schema unsupported',
      retryable: false,
      details: { providerCode: 'invalid_json_schema', providerParam: 'response_format', status: 400 },
    }],
  },
  { name: 'empty', code: 'TEMPLATE_ENGINE_LLM_EMPTY',
    events: [{ type: 'completed', finishReason: 'stop' }] },
  { name: 'malformed', code: 'TEMPLATE_ENGINE_LLM_INVALID_JSON', events: [
    { type: 'text_delta', delta: '{"decision":' },
    { type: 'completed', finishReason: 'stop' },
  ] },
  { name: 'truncated', code: 'TEMPLATE_ENGINE_LLM_TRUNCATED', events: [
    { type: 'text_delta', delta: JSON.stringify(response) },
    { type: 'completed', finishReason: 'length' },
  ] },
  { name: 'incomplete', code: 'TEMPLATE_ENGINE_LLM_INCOMPLETE',
    events: [{ type: 'text_delta', delta: JSON.stringify(response) }] },
  { name: 'schema-invalid', code: 'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID', events: [
    { type: 'text_delta', delta: JSON.stringify({ decision: 'RESPONSE' }) },
    { type: 'completed', finishReason: 'stop' },
  ] },
]) {
  let attempts = 0;
  await assert.rejects(() => createTemplateEngineStructuredInvoker({
    async *stream() {
      attempts += 1;
      for (const event of failure.events) yield event;
    },
    cancel() {},
  })(request()), (error) => error.code === failure.code);
  assert.equal(attempts, 1, `${failure.name} must not issue a second provider request`);
}

let cancelledAttempts = 0;
await assert.rejects(() => createTemplateEngineStructuredInvoker({
  async *stream() {
    cancelledAttempts += 1;
    yield { type: 'cancelled', reason: 'barge-in' };
  },
  cancel() {},
})(request()), (error) => error.code === 'TEMPLATE_ENGINE_LLM_CANCELLED');
assert.equal(cancelledAttempts, 1);

let obsoleteDeadlineCancellation = null;
const unboundedFirstSentence = await createTemplateEngineStructuredInvoker({
  async *stream() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield { type: 'text_delta', delta: JSON.stringify(response) };
    yield { type: 'completed' };
  },
  cancel(reason) { obsoleteDeadlineCancellation = reason; },
})(request(), { firstSentenceDeadlineAt: Date.now() + 10 });
assert.equal(unboundedFirstSentence.outputParsed.speech, response.speech);
assert.equal(obsoleteDeadlineCancellation, null,
  'Obsolete first-sentence targets must not cancel the configured provider request');

console.log(JSON.stringify({
  suite: 'template-engine-provider-runtime', passed: true,
  providerAttemptsPerTurn: 1, schemaFallbackRetries: 0,
  structuredOutputRetries: 0, transientRetries: 0,
}));
