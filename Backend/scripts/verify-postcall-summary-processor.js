import assert from 'node:assert/strict';
import { executePostCallSummaryJob } from '../src/voice/postcall-summary/postcall-summary.processor.js';

function sourceJob(transcript = [{ role: 'user', content: 'Call me tomorrow.' }]) {
  return {
    id: 'summary-1', tenantId: 'tenant-1', callSessionId: 'call-1', modelId: 'model-1',
    attemptCount: 1, maxAttempts: 3, instructions: 'Capture requested follow-up.', transcript,
    call: { direction: 'outbound' },
    agent: { settings: { postCallEndpointDetailsActive: true, postCallApiUrl: 'https://hooks.example.test/post' } },
    includeTranscriptInWebhook: true, includeSummaryInWebhook: true,
    providerUsage: { providers: [], totals: {} },
    provider: {
      providerId: 'provider-1', providerName: 'Test LLM', providerSlug: 'test-llm',
      modelId: 'model-1', modelKey: 'test-model', modelSettings: {}, modelCapabilities: {}, parameters: {},
    },
  };
}

let completedInput;
let deliveredPayload;
let closed = false;
const adapter = {
  async *stream(input) {
    assert.equal(input.temperature, 0);
    assert.equal(input.tools.length, 0);
    yield { type: 'text_delta', delta: '{"summary":"Customer requested a callback.",' };
    yield { type: 'text_delta', delta: '"outcome":"callback_requested","customer_intent":"Callback","sentiment":"neutral","collected_data":{"day":"tomorrow"},"follow_up_required":true,"follow_up_reason":"Call tomorrow"}' };
    yield {
      type: 'completed', finishReason: 'stop', providerRequestId: 'provider-request-1',
      usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 10 },
    };
  },
  cancel() {},
  async close() { closed = true; },
};
const completeResult = await executePostCallSummaryJob('summary-1', { attempt: 1, maxAttempts: 3 }, {
  claim: async () => ({ claimed: true, job: sourceJob() }),
  adapter,
  complete: async (_id, input) => { completedInput = input; return { id: 'summary-1', status: 'completed' }; },
  deliverWebhook: async (_profile, payload) => {
    deliveredPayload = payload;
    return { attempted: true, delivered: true, status: 200 };
  },
  recordWebhook: async () => ({ id: 'summary-1', status: 'completed' }),
  fail: async () => { throw new Error('failure path was not expected'); },
  skip: async () => { throw new Error('skip path was not expected'); },
  maxOutputTokens: 500,
});
assert.equal(completeResult.status, 'completed');
assert.equal(completedInput.outcome, 'callback_requested');
assert.equal(completedInput.usage.totalTokens, 130);
assert.equal(completedInput.usage.cachedInputTokens, 10);
assert.equal(completedInput.providerRequestId, 'provider-request-1');
assert.equal(deliveredPayload.aiSummary.outcome, 'callback_requested');
assert.equal(deliveredPayload.transcript[0].content, 'Call me tomorrow.');
assert.equal(closed, true);

let skippedReason;
const skipped = await executePostCallSummaryJob('summary-empty', {}, {
  claim: async () => ({ claimed: true, job: sourceJob([]) }),
  skip: async (_id, reason) => { skippedReason = reason; return { status: 'skipped' }; },
  deliverWebhook: async () => ({ attempted: true, delivered: true, status: 200 }),
  recordWebhook: async () => ({ status: 'skipped' }),
});
assert.equal(skipped.status, 'skipped');
assert.equal(skippedReason.code, 'POSTCALL_SUMMARY_TRANSCRIPT_EMPTY');

let failureInput;
await assert.rejects(() => executePostCallSummaryJob('summary-invalid', {}, {
  claim: async () => ({ claimed: true, job: sourceJob() }),
  adapter: {
    async *stream() { yield { type: 'text_delta', delta: 'invalid output' }; },
    cancel() {}, close() {},
  },
  fail: async (_id, error, options) => {
    failureInput = { error, options };
    return { retry: true, job: { status: 'queued' } };
  },
}), (error) => error.code === 'POSTCALL_SUMMARY_OUTPUT_INVALID');
assert.equal(failureInput.options.retryable, true);

let privatePayload;
const privateJob = sourceJob();
privateJob.includeTranscriptInWebhook = false;
privateJob.includeSummaryInWebhook = false;
await executePostCallSummaryJob('summary-private', {}, {
  claim: async () => ({ claimed: true, job: { ...privateJob, id: 'summary-private' } }),
  adapter: {
    async *stream() {
      yield { type: 'text_delta', delta: '{"summary":"Stored internally.","follow_up_required":false}' };
      yield { type: 'completed', usage: {} };
    },
    cancel() {}, close() {},
  },
  complete: async () => ({ status: 'completed' }),
  deliverWebhook: async (_profile, payload) => {
    privatePayload = payload;
    return { attempted: true, delivered: true, status: 200 };
  },
  recordWebhook: async () => ({ status: 'completed' }),
});
assert.equal(Object.hasOwn(privatePayload, 'transcript'), false);
assert.equal(Object.hasOwn(privatePayload, 'aiSummary'), false);
assert.ok(Object.hasOwn(privatePayload, 'providerUsage'));

let failedPayload;
const permanentlyFailed = await executePostCallSummaryJob('summary-failed', {}, {
  claim: async () => ({ claimed: true, job: { ...sourceJob(), id: 'summary-failed' } }),
  adapter: {
    async *stream() { throw Object.assign(new Error('Bad credentials'), { code: 'LLM_API_KEY_MISSING' }); },
    cancel() {}, close() {},
  },
  fail: async () => ({ retry: false, job: { status: 'failed' } }),
  deliverWebhook: async (_profile, payload) => {
    failedPayload = payload;
    return { attempted: true, delivered: true, status: 200 };
  },
  recordWebhook: async () => ({ status: 'failed' }),
});
assert.equal(permanentlyFailed.status, 'failed');
assert.equal(failedPayload.aiSummary.status, 'failed');
assert.equal(failedPayload.aiSummary.errorCode, 'LLM_API_KEY_MISSING');

console.log('Post-Call summary processor and usage verification passed.');
