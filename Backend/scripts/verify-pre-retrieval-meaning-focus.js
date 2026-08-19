import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  focusHydratedEvidenceByMeaning,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import {
  parsePreRetrievalMeaning,
  preRetrievalMeaningInput,
} from '../src/voice/interaction/pre-retrieval-meaning.js';
import { createMeaningResolutionLlmStream } from '../src/voice/providers/llm/llm-response.service.js';

const parsed = parsePreRetrievalMeaning(JSON.stringify({
  requestType: 'item_details',
  topic: 'Premium Learning Plan',
  explicitEntities: ['Premium Learning Plan'],
  requestedFacts: ['features', 'price'],
  constraints: [],
  contextualReferences: [],
  contextDependent: false,
  topicChanged: true,
}));
assert.equal(parsed.requestType, 'item_details');
assert.deepEqual(parsed.explicitEntities, ['Premium Learning Plan']);
assert.equal(parsed.topicChanged, true);

const contextual = parsePreRetrievalMeaning(JSON.stringify({
  requestType: 'details', topic: 'previous option', explicitEntities: ['previous option'],
  requestedFacts: ['coverage'], constraints: [], contextualReferences: ['அந்த option'],
  contextDependent: true, topicChanged: false,
}));
assert.equal(contextual.contextDependent, true);
assert.deepEqual(contextual.contextualReferences, ['அந்த option']);

const input = JSON.parse(preRetrievalMeaningInput('அந்த plan-ல என்ன benefits இருக்கு?', {
  currentTopic: 'Premium Learning Plan',
  knownEntities: [{ key: 'premium-plan', name: 'Premium Learning Plan' }],
  recentTurns: [{ role: 'assistant', content: 'Two plans are available.' }],
}));
assert.equal(input.latestUtterance, 'அந்த plan-ல என்ன benefits இருக்கு?');
assert.equal(input.memory.knownEntities[0].name, 'Premium Learning Plan');

function evidence(overrides) {
  return {
    id: overrides.id, recordId: overrides.id, recordType: overrides.recordType,
    rank: overrides.rank, retrievalContext: 'primary', retrievalScore: overrides.score ?? 0.8,
    semanticScore: overrides.semanticScore ?? 0.84, callerFacing: overrides.callerFacing ?? true,
    authoritativeData: overrides.authoritativeData ?? {}, hydrationValidated: true,
    content: overrides.content ?? '', ...overrides,
  };
}

const records = [
  evidence({
    id: 'overview', recordType: 'CONVERSATION_NODE', rank: 1, semanticScore: 0.91,
    authoritativeData: { nodeType: 'message' }, content: 'All available plans.',
  }),
  evidence({
    id: 'premium', recordType: 'CATALOG_ITEM', rank: 2, semanticScore: 0.9,
    authoritativeData: {
      itemKey: 'premium-learning-plan', name: 'Premium Learning Plan',
      aliases: ['advanced learning'], category: 'Learning Plans',
      price: 2500, attributes: [{ key: 'features', value: ['Mentoring', 'Assessments'] }],
    },
  }),
  evidence({
    id: 'basic', recordType: 'CATALOG_ITEM', rank: 3, semanticScore: 0.78,
    authoritativeData: { itemKey: 'basic-learning-plan', name: 'Basic Learning Plan' },
  }),
  evidence({ id: 'faq', recordType: 'FAQ', rank: 4, content: 'A general FAQ answer.' }),
  evidence({
    id: 'guidance', recordType: 'CONVERSATION_NODE', rank: 5, callerFacing: false,
    authoritativeData: { nodeType: 'guidance' }, content: 'Explain selected evidence.',
  }),
];

const focused = focusHydratedEvidenceByMeaning(records, {
  understanding: {
    explicitEntities: ['Premium Learning Plan'],
    selectedEntities: [{ name: 'Premium Learning Plan' }],
  },
}, 5);
assert.deepEqual(focused.map((item) => item.id), ['premium', 'guidance']);
assert.equal(focused[0].authoritativeData.price, 2500);
assert.deepEqual(focused[0].authoritativeData.attributes[0].value, ['Mentoring', 'Assessments']);
assert.equal(focused.some((item) => item.id === 'overview'), false);
assert.equal(focused.some((item) => item.id === 'faq'), false);

const categoryFocused = focusHydratedEvidenceByMeaning(records, {
  understanding: { explicitEntities: ['Learning Plans'], selectedEntities: [] },
}, 5);
assert.deepEqual(categoryFocused.filter((item) => item.recordType === 'CATALOG_ITEM')
  .map((item) => item.id), ['premium']);

const unchanged = focusHydratedEvidenceByMeaning(records, { understanding: {} }, 3);
assert.deepEqual(unchanged.map((item) => item.id), ['overview', 'premium', 'basic']);

let capturedRequest;
const adapter = {
  stream(request) {
    capturedRequest = request;
    return (async function* events() {
      yield { type: 'completed' };
    }());
  },
  cancel() {},
};
const session = await createMeaningResolutionLlmStream({
  providers: { llm: { providerId: 'provider', providerName: 'provider', modelId: 'model' } },
}, { callId: 'call', query: '{}' }, {
  adapter, skipDefaultRegistration: true,
});
for await (const _event of session.events) { /* consume */ }
assert.equal(capturedRequest.responseFormat.name, 'pre_retrieval_meaning');
assert.equal(capturedRequest.tools.length, 0);
assert.match(capturedRequest.messages[0].content, /Do not answer the caller/u);

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /#resolvePreRetrievalMeaning\(query, epoch\)/u);
assert.match(orchestrator, /#knowledge\(query, meaning, retrievalAbortController\.signal\)/u);
assert.equal(orchestrator.indexOf('#resolvePreRetrievalMeaning(query, epoch)')
  < orchestrator.indexOf('#knowledge(query, meaning, retrievalAbortController.signal)'), true);

const runtimeSources = [
  '../src/voice/interaction/pre-retrieval-meaning.js',
  '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
for (const forbidden of ['Shanmuga', 'Silver', 'Diabetic', 'Onco']) {
  assert.equal(runtimeSources.includes(forbidden), false, `runtime contains tenant vocabulary: ${forbidden}`);
}

console.log('Pre-retrieval meaning and entity-focused hydration verification passed.');
