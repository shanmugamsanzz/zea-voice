import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createOpenAiCompatibleLlmAdapter } = await import('../src/voice/providers/llm/openai-compatible.adapter.js');
const { createGeminiLlmAdapter } = await import('../src/voice/providers/llm/gemini.adapter.js');
const { createAnthropicLlmAdapter } = await import('../src/voice/providers/llm/anthropic.adapter.js');
const { llmEventTypes } = await import('../src/voice/providers/llm/llm.interface.js');
const { LlmCircuitBreaker } = await import('../src/voice/providers/llm/streaming-runtime.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { registerImplementedProviderAdapters } = await import('../src/voice/providers/defaults.js');

const input = {
  messages: [
    { role: 'system', content: 'Goal: help the caller accurately.' },
    { role: 'assistant', content: 'Welcome.' },
    { role: 'user', content: 'Book tomorrow.' },
  ],
  tools: [{
    name: 'book_appointment', description: 'Book an appointment',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
  }],
  temperature: 0.2,
  maxOutputTokens: 100,
};

function sseResponse(records, headers = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const record of records) controller.enqueue(encoder.encode(`data: ${typeof record === 'string' ? record : JSON.stringify(record)}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

let azureRequest;
const azure = createOpenAiCompatibleLlmAdapter({
  providerConfig: {
    providerId: 'azure-provider', providerName: 'Azure', modelId: 'azure-model', modelKey: 'gpt-4.1-nano',
    baseUrl: 'https://resource.openai.azure.com/openai/deployments/gpt-4.1-nano/chat/completions?api-version=2024-10-21',
    modelSettings: {}, parameters: { AZURE_OPENAI_API_KEY: 'azure-secret' },
  },
  runtimeContext: { fetchImpl: async (url, options) => {
    azureRequest = { url, options, body: JSON.parse(options.body) };
    return sseResponse([
      { id: 'azure-request', choices: [{ delta: { content: 'Your ' } }] },
      { id: 'azure-request', choices: [{ delta: { content: 'appointment', tool_calls: [{
        index: 0, id: 'call-1', function: { name: 'book_appointment', arguments: '{"date":' },
      }] } }] },
      { id: 'azure-request', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"tomorrow"}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'azure-request', choices: [], usage: {
        prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
        prompt_tokens_details: { cached_tokens: 5 },
      } },
      '[DONE]',
    ], { 'apim-request-id': 'azure-header-id' });
  } },
});
const azureEvents = await collect(azure.stream(input));
assert.equal(azureRequest.options.headers['api-key'], 'azure-secret');
assert.equal(azureRequest.body.stream, true);
assert.equal(azureRequest.body.stream_options.include_usage, true);
assert.equal(azureRequest.body.tools[0].function.name, 'book_appointment');
assert.deepEqual(azureEvents.map((event) => event.type), [
  'response_started', 'text_delta', 'text_delta', 'tool_call_delta', 'tool_call_delta', 'usage', 'tool_call', 'completed',
]);
assert.deepEqual(azureEvents.find((event) => event.type === 'tool_call').arguments, { date: 'tomorrow' });
assert.equal(azureEvents.at(-1).usage.totalTokens, 28);

let openAiAuthorization;
const openAi = createOpenAiCompatibleLlmAdapter({
  providerConfig: {
    providerId: 'openai-provider', providerName: 'OpenAI Compatible', modelId: 'openai-model', modelKey: 'custom-model',
    baseUrl: 'https://llm.example.com/v1', modelSettings: {}, parameters: { OPENAI_API_KEY: 'openai-secret' },
  },
  runtimeContext: { fetchImpl: async (_url, options) => {
    openAiAuthorization = options.headers.authorization;
    return sseResponse([{ id: 'openai-request', choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }, '[DONE]']);
  } },
});
assert.equal((await collect(openAi.stream(input))).at(-1).finishReason, 'stop');
assert.equal(openAiAuthorization, 'Bearer openai-secret');

let geminiRequest;
const gemini = createGeminiLlmAdapter({
  providerConfig: {
    providerId: 'gemini-provider', providerName: 'Gemini', modelId: 'gemini-model', modelKey: 'gemini-model-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', parameters: { GEMINI_API_KEY: 'gemini-secret' },
  },
  runtimeContext: { fetchImpl: async (url, options) => {
    geminiRequest = { url, options, body: JSON.parse(options.body) };
    return sseResponse([
      { responseId: 'gemini-request', candidates: [{ content: { parts: [{ text: 'Booked ' }] } }] },
      { responseId: 'gemini-request', candidates: [{ content: { parts: [{ functionCall: {
        id: 'gemini-tool', name: 'book_appointment', args: { date: 'tomorrow' },
      } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 } },
    ]);
  } },
});
const geminiEvents = await collect(gemini.stream(input));
assert.equal(geminiRequest.options.headers['x-goog-api-key'], 'gemini-secret');
assert.match(geminiRequest.url, /:streamGenerateContent\?alt=sse$/);
assert.match(geminiRequest.body.systemInstruction.parts[0].text, /Goal/);
assert.equal(geminiRequest.body.contents[0].role, 'model');
assert.equal(geminiRequest.body.tools[0].functionDeclarations[0].name, 'book_appointment');
assert.equal(geminiEvents.at(-1).usage.totalTokens, 15);
assert.equal(geminiEvents.find((event) => event.type === 'tool_call').name, 'book_appointment');

let anthropicRequest;
const anthropic = createAnthropicLlmAdapter({
  providerConfig: {
    providerId: 'anthropic-provider', providerName: 'Anthropic', modelId: 'anthropic-model', modelKey: 'claude-model',
    baseUrl: 'https://api.anthropic.com', parameters: { ANTHROPIC_API_KEY: 'anthropic-secret' },
  },
  runtimeContext: { fetchImpl: async (url, options) => {
    anthropicRequest = { url, options, body: JSON.parse(options.body) };
    return sseResponse([
      { type: 'message_start', message: { id: 'anthropic-request', usage: { input_tokens: 12 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'anthropic-tool', name: 'book_appointment', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"date":"tomorrow"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ], { 'request-id': 'anthropic-header-id' });
  } },
});
const anthropicEvents = await collect(anthropic.stream(input));
assert.equal(anthropicRequest.options.headers['x-api-key'], 'anthropic-secret');
assert.equal(anthropicRequest.options.headers['anthropic-version'], '2023-06-01');
assert.equal(anthropicRequest.body.system, 'Goal: help the caller accurately.');
assert.equal(anthropicRequest.body.tools[0].input_schema.type, 'object');
assert.equal(anthropicEvents.at(-1).usage.totalTokens, 19);
assert.deepEqual(anthropicEvents.find((event) => event.type === 'tool_call').arguments, { date: 'tomorrow' });

let cancelSignal;
const cancellable = createOpenAiCompatibleLlmAdapter({
  providerConfig: {
    providerId: 'cancel-provider', providerName: 'OpenAI', modelId: 'cancel-model', modelKey: 'model',
    baseUrl: 'https://api.openai.com/v1', modelSettings: {}, parameters: { OPENAI_API_KEY: 'secret' },
  },
  runtimeContext: { fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    cancelSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) },
});
const cancelledIterator = cancellable.stream(input);
const cancelledResult = cancelledIterator.next();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancellable.cancel('caller_barge_in'), true);
assert.equal(cancelSignal.aborted, true);
assert.equal((await cancelledResult).value.type, 'cancelled');

let now = 0;
const breaker = new LlmCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => now });
breaker.failure();
breaker.assertAvailable();
breaker.failure();
assert.throws(() => breaker.assertAvailable(), (error) => error.code === 'LLM_CIRCUIT_OPEN');
now = 1001;
breaker.assertAvailable();
breaker.success();
breaker.assertAvailable();

const registry = new ProviderAdapterRegistry();
registerImplementedProviderAdapters(registry);
assert.equal(registry.resolve('llm', { providerName: 'Azure', modelKey: 'x' }).key, 'openai-compatible');
assert.equal(registry.resolve('llm', { providerName: 'Gemini', modelKey: 'x' }).key, 'gemini');
assert.equal(registry.resolve('llm', { providerName: 'Anthropic', modelKey: 'x' }).key, 'anthropic');
assert.deepEqual(llmEventTypes, [
  'response_started', 'text_delta', 'tool_call_delta', 'tool_call', 'usage', 'completed', 'cancelled', 'error',
]);

console.log(JSON.stringify({ success: true, task: 'Streaming LLM adapters - Azure, OpenAI-compatible, Gemini and Anthropic' }));
