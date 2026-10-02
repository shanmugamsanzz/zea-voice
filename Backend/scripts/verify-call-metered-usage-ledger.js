import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { ProviderUsageTracker } = await import('../src/voice/provider-usage-tracker.js');
const migration = await fs.readFile(new URL('../migrations/1788700000000_call-metered-usage-ledger.js', import.meta.url), 'utf8');
const completion = await fs.readFile(new URL('../src/voice/call-completion.service.js', import.meta.url), 'utf8');

const tracker = new ProviderUsageTracker({ providers: {
  llm: { providerId: 'provider-llm', providerName: 'OpenAI', modelId: 'model-llm', modelKey: 'gpt-test' },
} });
tracker.record('llm', {
  inputTokens: 120, outputTokens: 40, cachedInputTokens: 20,
  audioInputTokens: 4, audioOutputTokens: 2, occurredAt: '2026-10-01T10:00:00.000Z',
});
const report = tracker.report();
assert.equal(report.providers.length, 1);
assert.equal(report.providers[0].requests, 1);
assert.equal(report.providers[0].cachedInputTokens, 20);
assert.equal(report.providers[0].events[0].occurredAt, '2026-10-01T10:00:00.000Z');

assert.match(migration, /CREATE TABLE call_metered_usage_events/u);
assert.match(migration, /service_type metered_service_type/u);
assert.match(migration, /model_call_count integer/u);
assert.match(migration, /occurred_at timestamptz/u);
assert.match(migration, /audio_input_tokens bigint/u);
assert.match(completion, /INSERT INTO call_metered_usage_events/u);
assert.match(completion, /cached_input_tokens/u);

console.log(JSON.stringify({ success: true, task: 'Per-call metered usage ledger' }));
