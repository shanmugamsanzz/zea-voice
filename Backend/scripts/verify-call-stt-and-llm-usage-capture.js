import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { normalizeSttEvent } = await import('../src/voice/providers/stt/stt.interface.js');
const { normalizeLlmUsage } = await import('../src/voice/providers/llm/llm.interface.js');
const { ProviderUsageTracker } = await import('../src/voice/provider-usage-tracker.js');

const runtimeProfile = { providers: {
  stt: { providerId: 'stt-provider', providerName: 'Sarvam', modelId: 'stt-model', modelKey: 'saaras-v3' },
  llm: { providerId: 'llm-provider', providerName: 'OpenAI', modelId: 'llm-model', modelKey: 'gpt-test' },
} };
const tracker = new ProviderUsageTracker(runtimeProfile);

const sttUsage = normalizeSttEvent({
  type: 'usage', audioDurationMs: 12_500, processingLatencyMs: 125,
  requestCount: 1, characterCount: 42, providerUsage: { meteredAudioSeconds: 12.5 },
});
assert.equal(sttUsage.audioDurationMs, 12_500);
assert.equal(sttUsage.requestCount, 1);
assert.equal(sttUsage.characterCount, 42);
assert.equal(sttUsage.providerUsage.meteredAudioSeconds, 12.5);
tracker.record('stt', {
  requests: sttUsage.requestCount,
  audioInputMs: sttUsage.audioDurationMs,
  characters: sttUsage.characterCount,
  durationMs: sttUsage.processingLatencyMs,
  raw: sttUsage.providerUsage,
});

const llmUsage = normalizeLlmUsage({
  inputTokens: 120, outputTokens: 35, cachedInputTokens: 20,
  audioInputTokens: 15, audioOutputTokens: 5,
});
assert.deepEqual(llmUsage, {
  inputTokens: 120, outputTokens: 35, totalTokens: 155, cachedInputTokens: 20,
  audioInputTokens: 15, audioOutputTokens: 5,
});

// A single caller turn can result in normal generation, tool-call generation,
// a tool-result follow-up, and the final reply. Each completed request is a
// separate ledger event and must therefore be retained.
for (const stage of ['normal', 'tool-call', 'tool-result', 'final-response']) {
  tracker.record('llm', { ...llmUsage, stage });
}
const report = tracker.report();
const stt = report.providers.find((provider) => provider.kind === 'stt');
const llm = report.providers.find((provider) => provider.kind === 'llm');
assert.equal(stt.requests, 1);
assert.equal(stt.audioInputMs, 12_500);
assert.equal(stt.characters, 42);
assert.equal(llm.requests, 4);
assert.equal(llm.inputTokens, 480);
assert.equal(llm.outputTokens, 140);
assert.equal(llm.cachedInputTokens, 80);
assert.equal(llm.audioInputTokens, 60);
assert.equal(llm.audioOutputTokens, 20);
assert.equal(llm.events.length, 4);

const [orchestrator, llmInterface, openai, gemini, anthropic] = await Promise.all([
  fs.readFile(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/providers/llm/llm.interface.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/providers/llm/openai-compatible.adapter.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/providers/llm/gemini.adapter.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/providers/llm/anthropic.adapter.js', import.meta.url), 'utf8'),
]);
const postCallJobService = await fs.readFile(
  new URL('../src/voice/postcall-summary/postcall-summary-job.service.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /this\.usageTracker\.record\('stt', \{/u);
assert.match(orchestrator, /if \(event\.type === 'completed' && event\.usage\) options\.onUsage\?\.\(event\)/u);
assert.match(orchestrator, /if \(event\.usage\) this\.usageTracker\.record\('llm', event\.usage\)/u);
assert.match(llmInterface, /audioInputTokens/u);
assert.match(llmInterface, /audioOutputTokens/u);
assert.match(openai, /prompt_tokens_details\?\.audio_tokens/u);
assert.match(gemini, /modalityTokens\(payload\.usageMetadata\.promptTokensDetails, 'AUDIO'\)/u);
assert.match(anthropic, /audio_input_tokens/u);
assert.match(postCallJobService, /stage: 'post_call_summary'/u);
assert.match(postCallJobService, /INSERT INTO call_metered_usage_events/u);

console.log(JSON.stringify({ success: true, task: 'STT and all LLM request usage capture' }));
