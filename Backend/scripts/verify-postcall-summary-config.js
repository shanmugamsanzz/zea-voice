import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const {
  normalizePostCallSummarySettings,
  resolvePostCallSummaryConfiguration,
} = await import('../src/voice/integrations/postcall-summary-config.js');
const { validateAgentRuntimeModels } = await import('../src/agents/agent.service.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');

const summaryModelId = '00000000-0000-4000-8000-000000000040';
assert.deepEqual(resolvePostCallSummaryConfiguration({}), {
  enabled: false, modelId: '', instructions: '', includeTranscript: true, includeSummary: true,
});
assert.throws(
  () => normalizePostCallSummarySettings({ postCallSummaryEnabled: true }),
  (error) => error.code === 'POSTCALL_SUMMARY_CONFIGURATION_INVALID'
    && error.field === 'postCallSummaryModelId',
);
assert.throws(
  () => normalizePostCallSummarySettings({
    postCallSummaryEnabled: true, postCallSummaryModelId: summaryModelId,
  }),
  (error) => error.code === 'POSTCALL_SUMMARY_CONFIGURATION_INVALID'
    && error.field === 'postCallSummaryInstructions',
);
const normalized = normalizePostCallSummarySettings({
  customSetting: 'preserved', postCallSummaryEnabled: true,
  postCallSummaryModelId: ` ${summaryModelId} `,
  postCallSummaryInstructions: ' Summarize facts only. ',
  postCallIncludeTranscript: false, postCallIncludeSummary: true,
});
assert.equal(normalized.customSetting, 'preserved');
assert.equal(normalized.postCallSummaryModelId, summaryModelId);
assert.equal(normalized.postCallSummaryInstructions, 'Summarize facts only.');
assert.equal(normalized.postCallIncludeTranscript, false);

function registry() {
  const value = new ProviderAdapterRegistry();
  value.register('stt', 'test-stt', () => ({ close() {} }));
  value.register('llm', 'test-llm', () => ({ close() {} }));
  value.register('tts', 'test-tts', () => ({ close() {} }));
  return value;
}

const queried = [];
await validateAgentRuntimeModels({
  async query(_sql, values) {
    queried.push(values);
    const type = values[1];
    return { rowCount: 1, rows: [{
      model_id: values[0], model_key: `${type}-model`, model_settings: {}, model_capabilities: {},
      provider_settings: {}, provider_id: `${type}-provider`, provider_name: `test-${type}`,
      provider_slug: `test-${type}`,
    }] };
  },
}, {
  sttModelId: 'stt-id', llmModelId: 'llm-id', ttsModelId: 'tts-id',
  settings: {
    postCallSummaryEnabled: true, postCallSummaryModelId: summaryModelId,
    postCallSummaryInstructions: 'Summarize facts only.',
  },
}, registry());
assert.equal(queried.length, 4);
assert.deepEqual(queried[3], [summaryModelId, 'llm']);

let queryNumber = 0;
await assert.rejects(validateAgentRuntimeModels({
  async query(_sql, values) {
    queryNumber += 1;
    if (queryNumber === 4) return { rowCount: 0, rows: [] };
    const type = values[1];
    return { rowCount: 1, rows: [{
      model_id: values[0], model_key: `${type}-model`, model_settings: {}, model_capabilities: {},
      provider_settings: {}, provider_id: `${type}-provider`, provider_name: `test-${type}`,
      provider_slug: `test-${type}`,
    }] };
  },
}, {
  sttModelId: 'stt-id', llmModelId: 'llm-id', ttsModelId: 'tts-id',
  settings: {
    postCallSummaryEnabled: true, postCallSummaryModelId: summaryModelId,
    postCallSummaryInstructions: 'Summarize facts only.',
  },
}, registry()), (error) => error.code === 'AGENT_SUMMARY_MODEL_UNAVAILABLE'
  && error.details.field === 'settings.postCallSummaryModelId');

console.log(JSON.stringify({
  success: true,
  task: 'Post-Call Summary Tasks 2 and 3 - catalog selection and save validation',
}));

