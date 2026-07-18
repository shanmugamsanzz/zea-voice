import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.LLM_MAX_OUTPUT_TOKENS = '120';

const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { generateSelectedLlmResponse } = await import('../src/voice/providers/llm/llm-response.service.js');

const profile = {
  agent: {
    id: 'agent-1', name: 'Selected Agent', description: 'Answers callers', goal: 'Help accurately',
    language: 'English (US)', prompt: 'Keep responses concise.', temperature: 0.2,
  },
  providers: { llm: {
    providerId: 'provider-1', providerName: 'Custom LLM Vendor', modelId: 'model-1', modelKey: 'chosen-model',
    modelSettings: { runtimeAdapter: 'test-llm-adapter' }, modelCapabilities: {}, parameters: {},
  } },
};
const registry = new ProviderAdapterRegistry();
let received;
registry.register('llm', 'test-llm-adapter', ({ providerConfig, runtimeContext }) => ({
  async generate(input) {
    received = { providerConfig, runtimeContext, input };
    return {
      answer: 'This response came from the selected model.', finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }, providerRequestId: 'request-1', durationMs: 42,
    };
  },
}));

const response = await generateSelectedLlmResponse(profile, {
  callId: 'call-1', query: 'What services are available?', usageDirection: 'inbound',
  context: { customerName: 'Caller' }, history: [{ role: 'assistant', content: 'Hello' }],
  knowledge: { found: true, route: 'semantic', matches: [{ recordType: 'KNOWLEDGE_CHUNK', content: 'Verified service information', score: 0.9 }] },
}, { registry, skipDefaultRegistration: true });

assert.equal(response.answer, 'This response came from the selected model.');
assert.equal(response.model, 'chosen-model');
assert.equal(received.providerConfig.modelKey, 'chosen-model');
assert.equal(received.runtimeContext.callId, 'call-1');
assert.equal(received.input.temperature, 0.2);
assert.equal(received.input.maxOutputTokens, 120);
assert.match(received.input.messages[0].content, /Verified service information/);
assert.equal(received.input.messages.at(-1).content, 'What services are available?');

console.log(JSON.stringify({ success: true, task: 'Voice Task 8 - selected LLM response generation' }));
