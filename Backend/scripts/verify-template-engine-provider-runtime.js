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
  search: null, tool: null, stateUpdate: null,
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

console.log('Template-engine provider diagnostics and retry verification passed.');
