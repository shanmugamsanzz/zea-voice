import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import {
  authoritativeEvidenceFromRow,
  detectEvidenceConflict,
  mergeAndRerankCandidates,
  resolveConfidenceResponseRoute,
  retainStrongCandidates,
  selectStrongCallerMessage,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import {
  classifyFinalCallCheckUtterance,
  resolveCallCheckConfiguration,
} from '../src/voice/interaction/call-check-config.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { validateGroundedClaims } from '../src/voice/interaction/grounded-claim-validator.js';
import {
  evidenceBelongsToRuntime,
  validateDecisionSecurity,
} from '../src/voice/interaction/grounded-decision-security.js';
import {
  createGroundedDecisionStreamDecoder,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';

const scope = Object.freeze({
  tenantId: 'tenant-semantic-replay', agentId: 'agent-semantic-replay',
  publicationRevisions: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-semantic-replay', publicationRevision: 11 }),
  ]),
  requireHydratedEvidence: true,
});

// Industry and language examples belong only to this regression fixture. The
// runtime under test receives semantic scores and published records; it does
// not contain or compare any of these words.
const fixtures = Object.freeze([
  Object.freeze({
    industry: 'property', language: 'ta',
    utterance: 'இந்த வீட்டோட வாடகையும் வசதிகளையும் முழுசா சொல்லுங்க',
    topic: 'two bedroom home', entityKey: 'home-two-bedroom', requestedFacts: ['price', 'features'],
    answer: 'Two bedroom home rent is INR 18000 and includes covered parking.',
  }),
  Object.freeze({
    industry: 'education', language: 'ta',
    utterance: 'இந்த courseல என்ன கத்துக்கலாம், fees எவ்வளவு?',
    topic: 'data course', entityKey: 'data-course', requestedFacts: ['curriculum', 'price'],
    answer: 'The data course costs INR 24000 and includes analytics and visualization.',
  }),
  Object.freeze({
    industry: 'insurance', language: 'en',
    utterance: 'What does that policy cover and how much is it?',
    topic: 'travel policy', entityKey: 'travel-policy', requestedFacts: ['coverage', 'price'],
    answer: 'The travel policy costs INR 3200 and covers approved emergency travel expenses.',
  }),
  Object.freeze({
    industry: 'retail', language: 'en',
    utterance: 'Give me the full details for this model, including the price.',
    topic: 'compact appliance', entityKey: 'compact-appliance', requestedFacts: ['details', 'price'],
    answer: 'The compact appliance costs INR 7999 and includes a two year warranty.',
  }),
  Object.freeze({
    industry: 'logistics', language: 'ta',
    utterance: 'இந்த delivery option எவ்வளவு நேரம் ஆகும், charge என்ன?',
    topic: 'express delivery', entityKey: 'express-delivery', requestedFacts: ['duration', 'price'],
    answer: 'Express delivery costs INR 450 and arrives within two business days.',
  }),
]);

function rowFor(fixture, index) {
  return {
    record_type: 'CATALOG_ITEM', record_id: `record-${index + 1}`,
    tenant_id: scope.tenantId, agent_id: scope.agentId,
    knowledge_base_id: 'kb-semantic-replay', publication_revision: 11,
    document_id: `document-${index + 1}`, document_version_id: `version-${index + 1}`,
    document_name: `${fixture.industry}-catalog`, language: fixture.language,
    content: fixture.answer, caller_facing: true, score: 0.93, rank: 1,
    authoritative_data: {
      itemKey: fixture.entityKey, name: fixture.topic,
      price: Number(fixture.answer.match(/INR (\d+)/u)?.[1]),
      attributes: fixture.requestedFacts,
      selectionRules: { selectable: true },
    },
  };
}

const durations = [];
for (const [index, fixture] of fixtures.entries()) {
  const started = performance.now();
  const semantic = [
    {
      recordType: 'CATALOG_ITEM', recordId: `record-${index + 1}`,
      knowledgeBaseId: 'kb-semantic-replay', semanticScore: 0.93,
      channelRank: 1, language: fixture.language, contentPreview: fixture.answer,
    },
    {
      recordType: 'FAQ', recordId: `irrelevant-${index + 1}`,
      knowledgeBaseId: 'kb-semantic-replay', semanticScore: 0.18,
      channelRank: 2, language: fixture.language, contentPreview: 'An unrelated published answer.',
    },
  ];
  const lexical = [{
    recordType: 'CATALOG_ITEM', recordId: `record-${index + 1}`,
    knowledgeBaseId: 'kb-semantic-replay', lexicalScore: 5.2, tokenCoverage: 0.7,
    channelRank: 1, language: fixture.language, contentPreview: fixture.answer,
  }];
  const ranked = mergeAndRerankCandidates(semantic, lexical, fixture.utterance, fixture.language, 5);
  const retained = retainStrongCandidates(ranked, fixture.utterance, 5);
  assert.equal(retained[0].recordId, `record-${index + 1}`, `${fixture.industry}: relevant evidence first`);
  assert.ok(retained.length <= 5, `${fixture.industry}: bounded evidence`);

  const evidence = {
    ...authoritativeEvidenceFromRow(rowFor(fixture, index)),
    semanticScore: 0.93, semanticRank: 1, retrievalScore: retained[0].score,
    retrievalContext: 'primary', channels: ['semantic', 'bm25'],
  };
  assert.equal(evidenceBelongsToRuntime(evidence, scope), true, `${fixture.industry}: authoritative scope`);
  assert.equal(evidenceBelongsToRuntime({ ...evidence, tenantId: 'another-tenant' }, scope), false,
    `${fixture.industry}: tenant isolation`);
  assert.equal(evidenceBelongsToRuntime({ ...evidence, publicationRevision: 10 }, scope), false,
    `${fixture.industry}: revision isolation`);

  const route = resolveConfidenceResponseRoute({
    evidence: [evidence], conflict: detectEvidenceConflict([evidence]),
  });
  assert.equal(route.outcome, 'grounded_llm', `${fixture.industry}: reasoning route`);
  const envelope = buildGroundingEnvelope({
    found: true, tenantEvidence: {
      sources: [evidence],
      entities: [{ key: fixture.entityKey, name: fixture.topic, id: evidence.recordId }],
    },
  }, { includePublishedMap: false });
  const rawDecision = JSON.stringify({
    decision: 'answer', answer: fixture.answer, responseId: null,
    evidenceIds: ['source_1'],
    stateUpdate: {
      requestType: 'details', currentTopic: fixture.topic,
      knownEntityKeys: [fixture.entityKey], requestedFacts: fixture.requestedFacts,
      constraints: [], contextualReferences: fixture.utterance.includes('இந்த')
        || fixture.utterance.includes('that') || fixture.utterance.includes('this') ? ['current item'] : [],
      contextDependent: true, collectedInformation: {}, correctedFields: [],
    },
    pendingQuestion: null, toolRequest: null, clarification: null,
  });

  const decoder = createGroundedDecisionStreamDecoder(envelope);
  const split = Math.floor(rawDecision.length / 2);
  assert.equal(decoder.push(rawDecision.slice(0, split)).delta, '', `${fixture.industry}: no partial TTS`);
  assert.equal(decoder.push(rawDecision.slice(split)).delta, '', `${fixture.industry}: JSON not spoken`);
  const decision = validateGroundedLlmDecision(rawDecision, envelope);
  assert.equal(decision.valid, true, `${fixture.industry}: decision JSON`);
  const claims = validateGroundedClaims(decision.answer, [evidence]);
  assert.equal(claims.valid, true, `${fixture.industry}: facts and numbers grounded`);
  const security = validateDecisionSecurity({
    sources: [evidence], runtime: { evidenceScope: scope, answer: decision.answer },
  });
  assert.equal(security.valid, true, `${fixture.industry}: final response security`);

  const memory = openGenericConversationState({
    tenantId: scope.tenantId, workspaceId: 'workspace-semantic-replay',
    agentId: scope.agentId, callId: `call-${index + 1}`,
  }, { conversationLanguage: fixture.language });
  const token = memory.beginTurn(`turn-${index + 1}`);
  memory.append({ role: 'user', content: fixture.utterance }, { turnToken: token });
  memory.applyGroundedDecision({
    stateUpdate: {
      currentTopic: fixture.topic,
      knownEntities: [{ key: fixture.entityKey, name: fixture.topic }],
      requestType: 'details', requestedFacts: fixture.requestedFacts,
      constraints: [], contextualReferences: ['current item'], contextDependent: true,
    }, pendingQuestion: null,
  }, { turnToken: token });
  memory.append({ role: 'assistant', content: decision.answer }, { turnToken: token });
  const snapshot = memory.snapshot();
  assert.equal(snapshot.currentTopic, fixture.topic, `${fixture.industry}: topic memory`);
  assert.equal(snapshot.knownEntities[0].key, fixture.entityKey, `${fixture.industry}: entity memory`);
  assert.deepEqual(snapshot.requestedFacts, fixture.requestedFacts, `${fixture.industry}: requested facts memory`);
  // Caller-facing TTS is assigned only from the fully validated decision.
  const finalTtsText = decision.answer;
  assert.equal(finalTtsText, fixture.answer, `${fixture.industry}: final TTS text`);
  memory.close();
  durations.push(performance.now() - started);
}

const directEvidence = {
  ...authoritativeEvidenceFromRow({
    record_type: 'CONVERSATION_NODE', record_id: 'message-overview',
    tenant_id: scope.tenantId, agent_id: scope.agentId,
    knowledge_base_id: 'kb-semantic-replay', publication_revision: 11,
    document_id: 'document-guidance', document_version_id: 'version-guidance',
    document_name: 'conversation-guidance', language: 'en',
    content: 'Published overview response.', caller_facing: true, score: 0.94, rank: 1,
    authoritative_data: {
      nodeType: 'message', variables: [
        { key: 'situation', value: 'The caller requests a general overview.' },
        { key: 'context', value: 'no_selected_entity' },
      ],
    },
  }),
  semanticScore: 0.94, semanticRank: 1, retrievalScore: 0.93,
  retrievalContext: 'primary', channels: ['semantic', 'bm25'],
};
const direct = selectStrongCallerMessage(
  [directEvidence], 'Could you walk me through everything available?', { knownEntities: [] },
);
assert.equal(direct?.recordId, 'message-overview', 'unseen wording selects semantic published response');
assert.equal(resolveConfidenceResponseRoute({ directMessage: direct, evidence: [directEvidence] }).outcome,
  'direct');
assert.equal(direct.content, 'Published overview response.', 'direct response remains verbatim');

const conflicting = [
  { ...directEvidence, recordType: 'CATALOG_ITEM', recordId: 'conflict-a',
    retrievalScore: 0.9, authoritativeData: { itemKey: 'same-item', price: 100 } },
  { ...directEvidence, recordType: 'CATALOG_ITEM', recordId: 'conflict-b',
    retrievalScore: 0.88, authoritativeData: { itemKey: 'same-item', price: 200 } },
];
const conflict = detectEvidenceConflict(conflicting);
assert.equal(conflict.detected, true);
assert.equal(resolveConfidenceResponseRoute({ evidence: conflicting, conflict }).outcome, 'clarify');
assert.equal(resolveConfidenceResponseRoute({ evidence: [], rejectedCandidates: 2 }).outcome, 'clarify');

const callCheck = resolveCallCheckConfiguration({
  callCheckPhrases: ['Hello', 'Are you there?'], callCheckResponse: 'Yes, I am here.',
}, { strict: true });
assert.equal(classifyFinalCallCheckUtterance('Hello', callCheck, { finalized: true }).shortcut, true);
assert.equal(classifyFinalCallCheckUtterance(
  'Hello, explain the current option.', callCheck, { finalized: true },
).shortcut, false, 'a meaningful interrupted request must reach semantic routing');

const toolSchema = {
  name: 'submit_request', inputSchema: {
    type: 'object', additionalProperties: false, required: ['reference'],
    properties: { reference: { type: 'string' } },
  },
};
const authorizationEvidence = {
  ...directEvidence, recordType: 'WORKFLOW_RULE', recordId: 'workflow-submit', callerFacing: false,
  activationAllowed: true,
  authoritativeData: {
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'submit_request', requiresCatalogItem: false },
  },
};
const authorizedTool = validateDecisionSecurity({
  toolRequest: { name: 'submit_request', arguments: { reference: 'ABC-123' } },
  runtime: {
    evidenceScope: scope, toolSchemas: [toolSchema], actionEvidence: [authorizationEvidence],
    requireCurrentActionEvidence: true, configuredFieldKeys: ['reference'],
    collectedInformation: { reference: 'ABC-123' },
  },
});
assert.equal(authorizedTool.valid, true, 'published workflow and assigned UI tool authorize execution');
const unauthorizedTool = validateDecisionSecurity({
  toolRequest: { name: 'unassigned_action', arguments: {} },
  runtime: {
    evidenceScope: scope, toolSchemas: [toolSchema], actionEvidence: [authorizationEvidence],
    requireCurrentActionEvidence: true,
  },
});
assert.equal(unauthorizedTool.valid, false);
assert.equal(unauthorizedTool.reason, 'unauthorized_tool_request');

const orchestratorSource = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestratorSource, /llm\.native_tool_events_rejected/u);
assert.match(orchestratorSource, /grounded\.decision === 'action'/u);
assert.doesNotMatch(orchestratorSource, /return \{ toolCalls: providerToolCalls/u);

const sortedDurations = [...durations].sort((left, right) => left - right);
const percentile = (value) => sortedDurations[Math.min(
  sortedDurations.length - 1, Math.ceil((value / 100) * sortedDurations.length) - 1,
)];
const latency = { p50: percentile(50), p90: percentile(90), p95: percentile(95) };
assert.ok(latency.p95 < 100, `local semantic replay p95 exceeded 100ms: ${latency.p95.toFixed(2)}ms`);

console.log(JSON.stringify({
  task: 'semantic-production-replay', passed: true,
  industries: fixtures.map((fixture) => fixture.industry),
  languages: [...new Set(fixtures.map((fixture) => fixture.language))],
  validated: [
    'retrieval', 'evidence-ranking', 'authoritative-scope', 'grounded-decision',
    'facts-and-numbers', 'memory', 'interruptions', 'final-tts', 'tool-safety',
  ],
  partialLlmTextReleased: false,
  localReplayLatencyMs: Object.fromEntries(Object.entries(latency)
    .map(([key, value]) => [key, Number(value.toFixed(2))])),
}));
