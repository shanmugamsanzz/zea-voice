import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizePublishedConversationGuidance,
  selectApplicableConversationGuidance,
} from '../src/voice/interaction/template-engine-conversation-guidance.js';
import { routeTemplateEngineUtterance } from '../src/voice/interaction/template-engine-orchestrator.js';
import { loadTemplateEnginePublishedContext } from '../src/voice/interaction/template-engine-production-retrieval.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const publication = { tenantId, knowledgeBaseId, publicationRevision: 7 };
const scope = { tenantId, agentId, publications: [publication] };

function publishedRecord({
  recordId, purpose, situation, examples, nextQuestion, intentClass = null, nodeKey = null,
}) {
  return normalizePublishedConversationGuidance({
    record_id: recordId,
    record_type: 'conversation_node',
    language: 'en',
    entity_metadata: {
      flowKey: 'main', nodeKey: nodeKey ?? recordId, nodeType: 'guidance',
      variables: [
        { key: 'intentClass', value: intentClass },
        { key: 'purpose', value: purpose },
        { key: 'situation', value: situation },
        { key: 'examples', value: examples },
        { key: 'nextQuestion', value: nextQuestion },
      ],
    },
  }, publication, agentId);
}

const detailGuidance = publishedRecord({
  recordId: 'guidance-detail',
  purpose: 'Explain the selected offering and continue the caller journey.',
  situation: 'The caller asks for details about one selected offering.',
  examples: ['Explain the selected option'],
  nextQuestion: 'Would you like the next configured step or another option?',
  intentClass: 'DETAILS', nodeKey: 'selected_option_details',
});
const overviewGuidance = publishedRecord({
  recordId: 'guidance-overview',
  purpose: 'Present all currently available options.',
  situation: 'The caller requests an overview of available options.',
  examples: ['What options are available?'],
  nextQuestion: 'Which option would you like to explore?',
  intentClass: 'OVERVIEW', nodeKey: 'available_options_overview',
});
const crossTenant = Object.freeze({
  ...overviewGuidance,
  recordId: 'cross-tenant-guidance',
  tenantId: '99999999-9999-4999-8999-999999999999',
});

assert.equal(detailGuidance.purpose.includes('selected offering'), true);
assert.equal(detailGuidance.nextQuestion.includes('configured step'), true);
const loadedContext = await loadTemplateEnginePublishedContext({
  auth: { tenantId }, scope, callId: 'call-guidance', usageDirection: 'inbound', language: 'en',
}, {
  loadArtifacts: async () => ({
    publications: [{ knowledgeBaseId, publicationRevision: 7 }],
    bundles: [{ records: [{
      record_id: 'guidance-loaded', record_type: 'conversation_node', language: 'en',
      entity_metadata: {
        nodeKey: 'guidance_loaded', nodeType: 'guidance',
        variables: [
          { key: 'purpose', value: 'Continue a verified information response.' },
          { key: 'nextQuestion', value: 'What would you like to explore next?' },
        ],
      },
    }] }],
  }),
});
assert.equal(loadedContext.publishedConversationGuidance.length, 1);
assert.equal(loadedContext.publishedConversationGuidance[0].recordId, 'guidance-loaded');
assert.equal(loadedContext.publishedConversationGuidance[0].tenantId, tenantId);
const selected = selectApplicableConversationGuidance({
  publishedConversationGuidance: [detailGuidance, overviewGuidance, crossTenant],
  scope,
  latestUtterance: 'Please explain the selected option',
  finalDecision: 'SEARCH',
  searchInterpretation: {
    query: 'selected option details', requestedFact: 'details', contextualReference: 'selected option',
  },
  evidence: [{ recordType: 'CATALOG_ITEM', canonicalName: 'Selected Option' }],
  recentCompleteTurns: [{ role: 'user', content: 'I selected one option.' }],
  currentIntent: 'DETAILS', conversationStage: 'selected option details', language: 'en',
});
assert.equal(selected.recordId, 'guidance-detail');
assert.equal(selected.intentClass, 'DETAILS');
assert.equal(selected.conversationStage, 'selected option details');
assert.equal(selected.selectionReasons.includes('intent_compatible'), true);
assert.equal(selected.selectionReasons.includes('stage_compatible'), true);
assert.equal(Object.values(selected).some((value) => String(value).includes('cross-tenant')), false);

const evidenceSelected = selectApplicableConversationGuidance({
  publishedConversationGuidance: [detailGuidance, overviewGuidance],
  scope,
  latestUtterance: 'Continue',
  evidence: [{ recordType: 'CONVERSATION_NODE', recordId: 'guidance-overview' }],
});
assert.equal(evidenceSelected.recordId, 'guidance-overview');

const namedEntityMustNotReuseOverview = selectApplicableConversationGuidance({
  publishedConversationGuidance: [overviewGuidance], scope,
  latestUtterance: 'Explain Beta Option', finalDecision: 'SEARCH',
  searchInterpretation: {
    query: 'Beta Option details', requestedFact: 'details', contextualReference: 'Beta Option',
  },
  evidence: [
    { recordType: 'CONVERSATION_NODE', recordId: 'guidance-overview' },
    { recordType: 'CATALOG_ITEM', recordId: 'beta-record', canonicalName: 'Beta Option' },
  ],
  currentIntent: 'DETAILS', conversationStage: 'SEARCH details', language: 'en',
});
assert.equal(namedEntityMustNotReuseOverview, null,
  'A named entity request must not reuse overview guidance even when it was retrieved');

const namedEntitySelectsDetails = selectApplicableConversationGuidance({
  publishedConversationGuidance: [overviewGuidance, detailGuidance], scope,
  latestUtterance: 'Explain Beta Option', finalDecision: 'SEARCH',
  searchInterpretation: {
    query: 'Beta Option details', requestedFact: 'details', contextualReference: 'Beta Option',
  },
  evidence: [{ recordType: 'CATALOG_ITEM', recordId: 'beta-record', canonicalName: 'Beta Option' }],
  currentIntent: 'DETAILS', conversationStage: 'SEARCH details', language: 'en',
});
assert.equal(namedEntitySelectsDetails.recordId, 'guidance-detail',
  'A named entity request must select compatible details guidance');

// Production publication bundles expose compact records with `metadata` and
// generated caller-language aliases. Selection must preserve and use those
// published signals instead of depending on a test-only `entity_metadata` shape.
const publishedBundleGuidance = normalizePublishedConversationGuidance({
  record_id: 'guidance-published-shape',
  record_type: 'conversation_node',
  language: 'ta',
  content: 'Present the configured overview and invite the caller to select an option.',
  publicationAliases: ['ஆம் சொல்லுங்கள்', 'yes continue'],
  publicationSttForms: ['ஆம்சொல்லுங்கள்'],
  metadata: {
    flowKey: 'main', nodeKey: 'configured_overview', nodeType: 'message',
    sequenceOrder: 2, isEntry: false,
    variables: {
      intentClass: 'CATEGORY_OVERVIEW',
      purpose: 'Continue the configured overview after caller acceptance.',
      nextQuestion: 'Which configured option would you like to explore?',
    },
  },
}, publication, agentId);
assert.equal(publishedBundleGuidance.nextQuestion, 'Which configured option would you like to explore?');
assert.equal(publishedBundleGuidance.sequenceOrder, 2);
const multilingualSelection = selectApplicableConversationGuidance({
  publishedConversationGuidance: [detailGuidance, publishedBundleGuidance],
  scope,
  latestUtterance: 'ஆம் சொல்லுங்க',
  finalDecision: 'RESPONSE',
  recentCompleteTurns: [{ role: 'assistant', content: 'May I continue?' }],
  conversationStage: 'conversation',
  language: 'ta-IN',
});
assert.equal(multilingualSelection.recordId, 'guidance-published-shape');
assert.equal(multilingualSelection.selectionReasons.includes('semantic_example_compatible'), true);

const contentMatchedGuidance = normalizePublishedConversationGuidance({
  record_id: 'guidance-content-match', record_type: 'conversation_node', language: 'en',
  content: 'Explain the selected option including its complete configured attributes.',
  metadata: {
    flowKey: 'main', nodeKey: 'configured_details', nodeType: 'guidance',
    variables: [
      { key: 'purpose', value: 'Explain one selected option.' },
      { key: 'nextQuestion', value: 'Would you like the next configured action?' },
    ],
  },
}, publication, agentId);
const contentSelection = selectApplicableConversationGuidance({
  publishedConversationGuidance: [overviewGuidance, contentMatchedGuidance],
  scope,
  latestUtterance: 'What are all of its configured attributes?',
  finalDecision: 'SEARCH',
  searchInterpretation: {
    query: 'selected option configured attributes', requestedFact: 'attributes',
    contextualReference: 'selected option',
  },
  recentCompleteTurns: [{ role: 'assistant', content: 'The selected option is available.' }],
  conversationStage: 'SEARCH attributes', language: 'en',
});
assert.equal(contentSelection.recordId, 'guidance-content-match');

let request;
await routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for non-factual conversation.',
  latestUtterance: 'Continue',
  conversationGuidance: selected,
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  invokeStructuredLlm: async (value) => {
    request = value;
    return {
      decision: 'RESPONSE', response: 'Certainly.', clarification: null,
      search: null, tool: null,
      nextQuestion: { question: 'Would you like another option?', reason: 'relevant continuation' },
      stateUpdate: null,
    };
  },
});
const systemPrompt = request.messages[0].content;
assert.match(systemPrompt, /"conversationGuidance"/u);
assert.match(systemPrompt, /"purpose":"Explain the selected offering/u);
assert.match(systemPrompt, /"nextQuestion":"Would you like the next configured step/u);
assert.match(systemPrompt, /non-binding conversational guidance/u);
assert.match(systemPrompt, /Never copy a guidance nextQuestion as mandatory fixed speech/u);

const selectorSource = readFileSync(
  new URL('../src/voice/interaction/template-engine-conversation-guidance.js', import.meta.url),
  'utf8',
);
for (const forbidden of ['silver', 'gold', 'platinum', 'hospital', 'patient_name']) {
  assert.equal(selectorSource.toLocaleLowerCase().includes(forbidden), false);
}

console.log('Template-engine published Conversation Guidance verification passed');
