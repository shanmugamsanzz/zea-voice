import assert from 'node:assert/strict';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';
import { routeTemplateEngineUtterance } from '../src/voice/interaction/template-engine-orchestrator.js';

const tenants = Object.freeze([
  Object.freeze({
    tenantId: 'routing-tenant-en', agentId: 'routing-agent-en', knowledgeBaseId: 'routing-kb-en',
    language: 'en', acknowledgement: 'Okay, thank you.', acknowledgementResponse: 'You are welcome.',
    overview: 'What options are available?', direct: 'Tell me about Option Alpha.',
    followUp: 'What is its current value?', answer: 'Option Alpha has a verified value of 125 units.',
  }),
  Object.freeze({
    tenantId: 'routing-tenant-ta', agentId: 'routing-agent-ta', knowledgeBaseId: 'routing-kb-ta',
    language: 'ta', acknowledgement: '\u0b9a\u0bb0\u0bbf\u0b99\u0bcd\u0b95, \u0ba8\u0ba9\u0bcd\u0bb1\u0bbf.', acknowledgementResponse: '\u0b9a\u0bb0\u0bbf\u0b99\u0bcd\u0b95, \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95.',
    overview: '\u0b8e\u0ba9\u0bcd\u0ba9\u0bc6\u0ba9\u0bcd\u0ba9 \u0bb5\u0bbf\u0bb0\u0bc1\u0baa\u0bcd\u0baa\u0b99\u0bcd\u0b95\u0bb3\u0bcd \u0b87\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc1?',
    direct: 'Option Alpha \u0baa\u0ba4\u0bcd\u0ba4\u0bbf \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95.', followUp: '\u0b87\u0ba4\u0bcb\u0b9f \u0ba4\u0bb1\u0bcd\u0baa\u0bcb\u0ba4\u0bc8\u0baf \u0bae\u0ba4\u0bbf\u0baa\u0bcd\u0baa\u0bc1 \u0b8e\u0ba9\u0bcd\u0ba9?',
    answer: 'Option Alpha-\u0bb5\u0bbf\u0ba9\u0bcd \u0b89\u0bb1\u0bc1\u0ba4\u0bbf\u0baa\u0bcd\u0baa\u0b9f\u0bc1\u0ba4\u0bcd\u0ba4\u0baa\u0bcd\u0baa\u0b9f\u0bcd\u0b9f \u0bae\u0ba4\u0bbf\u0baa\u0bcd\u0baa\u0bc1 125.',
  }),
  Object.freeze({
    tenantId: 'routing-tenant-ta-latn', agentId: 'routing-agent-ta-latn',
    knowledgeBaseId: 'routing-kb-ta-latn', language: 'ta-Latn',
    acknowledgement: 'Saringa, nandri.', acknowledgementResponse: 'Saringa, sollunga.',
    overview: 'Enna options irukku?', direct: 'Option Alpha pathi sollunga.',
    followUp: 'Idhoda current value enna?',
    answer: 'Option Alpha verified value 125 units.',
  }),
]);

function searchDecision(query, requestedFact, contextualReference, preferredRecordIds = []) {
  return {
    decision: 'SEARCH', response: '', clarification: null,
    search: { query, requestedFact, contextualReference, preferredRecordIds },
    tool: null, nextQuestion: null, stateUpdate: null,
  };
}

function runtimeInput(configuration, utterance, state = {}) {
  return {
    auth: { tenantId: configuration.tenantId },
    scope: {
      tenantId: configuration.tenantId,
      agentId: configuration.agentId,
      publications: [{ knowledgeBaseId: configuration.knowledgeBaseId, publicationRevision: 7 }],
    },
    callId: `gate-${configuration.language}-${utterance.length}`,
    usageDirection: 'inbound', language: configuration.language,
    mainPrompt: `Use ${configuration.language}. Route non-factual conversation to RESPONSE and facts to SEARCH.`,
    latestUtterance: utterance, conversationHistory: [], state,
    runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
  };
}

function dependencies(configuration, decisions, { evidence = true } = {}) {
  const recordId = `record-${configuration.tenantId}`;
  const evidenceId = `evidence-${configuration.tenantId}`;
  const scope = runtimeInput(configuration, 'scope').scope;
  let retrievalDiagnostics = null;
  let postSearchDiagnostics = null;
  let retrievalCalls = 0;
  return {
    dependencies: {
      invokeStructuredLlm: async () => decisions.shift(),
      loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
      retrieveEvidence: async () => {
        retrievalCalls += 1;
        const records = evidence ? [Object.freeze({
          verified: true, callerFacing: true, evidenceId, recordId,
          tenantId: configuration.tenantId, agentId: configuration.agentId,
          knowledgeBaseId: configuration.knowledgeBaseId, publicationRevision: 7,
          recordType: 'CATALOG_ITEM', canonicalIdentity: `identity-${recordId}`,
          categoryKey: 'category-alpha', callerFacingHint: configuration.answer,
          tokenCoverage: 1, authorizationHint: null, deduplicationIdentity: `dedup-${recordId}`,
          namespaceRank: 1, content: configuration.answer,
        })] : [];
        return {
          evidence: records, scope,
          diagnostics: {
            retrievalCount: evidence ? 1 : 0,
            hydrationCount: evidence ? 1 : 0,
            verifiedEvidenceCount: records.length,
            channelCounts: { structured: records.length, bm25: records.length, qdrant: records.length },
            failedChannels: [],
          },
        };
      },
      persistWorkflowState: async () => {},
      executeAuthorizedTool: async () => { throw new Error('tool execution is not expected'); },
      validateGroundedClaims: async ({ selectedEvidence }) => ({
        supported: selectedEvidence.length > 0 || decisions.length === 0,
        successClaimed: false,
        requestedFactAddressed: true,
      }),
      validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
      onRetrievalDiagnostics: (value) => { retrievalDiagnostics = value; },
      onPostSearchDiagnostics: (value) => { postSearchDiagnostics = value; },
    },
    inspect: () => ({ retrievalDiagnostics, postSearchDiagnostics, retrievalCalls, recordId, evidenceId }),
  };
}

for (const configuration of tenants) {
  const acknowledgementDecisions = [
    { decision: 'RESPONSE', response: configuration.acknowledgementResponse, clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null },
  ];
  const acknowledgementRuntime = dependencies(configuration, acknowledgementDecisions);
  const acknowledgement = await runTemplateEngineProductionTurn(
    runtimeInput(configuration, configuration.acknowledgement), acknowledgementRuntime.dependencies,
  );
  assert.equal(acknowledgement.decision.decision, 'RESPONSE');
  assert.equal(acknowledgementRuntime.inspect().retrievalCalls, 0);
  assert.equal(acknowledgementDecisions.length, 0);

  let malformedCalls = 0;
  const malformedRecovery = await routeTemplateEngineUtterance({
    mainPrompt: `Use ${configuration.language}. Route facts through grounded search.`,
    latestUtterance: configuration.overview,
  }, {
    tenantBoundaryVerified: true,
    factualClaimsPresent: true,
    invokeStructuredLlm: async () => {
      malformedCalls += 1;
      if (malformedCalls === 1) return '';
      return {
        decision: 'RESPONSE', response: configuration.answer,
        clarification: null, search: null, tool: null,
        nextQuestion: null, stateUpdate: null,
      };
    },
  });
  assert.equal(malformedCalls, 2, 'Malformed routing output must be retried once');
  assert.equal(malformedRecovery.decision.decision, 'SEARCH',
    'A factual retry must continue to retrieval without a route-validation fallback');
  assert.notEqual(malformedRecovery.decision.decision, 'NO_MATCH');
  assert.equal(malformedRecovery.outputValidation.route, 'SEARCH');

  const scenarios = [
    { utterance: configuration.overview, fact: 'available options', reference: null, state: {} },
    { utterance: configuration.direct, fact: 'details', reference: 'Option Alpha', state: {} },
    {
      utterance: configuration.followUp, fact: 'current value', reference: 'Option Alpha',
      state: { lastReferencedRecordIds: [`record-${configuration.tenantId}`] },
    },
  ];
  for (const scenario of scenarios) {
    const recordId = `record-${configuration.tenantId}`;
    const decisions = [
      searchDecision(scenario.utterance, scenario.fact, scenario.reference,
        scenario.state.lastReferencedRecordIds ?? []),
      { decision: 'RESPONSE', response: configuration.answer, clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null },
    ];
    const runtime = dependencies(configuration, decisions);
    const result = await runTemplateEngineProductionTurn(
      runtimeInput(configuration, scenario.utterance, scenario.state), runtime.dependencies,
    );
    const observed = runtime.inspect();
    assert.ok(observed.retrievalDiagnostics.retrievalCount > 0);
    assert.ok(observed.retrievalDiagnostics.hydrationCount > 0);
    assert.ok(observed.retrievalDiagnostics.verifiedEvidenceCount > 0);
    assert.ok(observed.postSearchDiagnostics.allowedAliases.includes('E1'));
    assert.equal(observed.postSearchDiagnostics.finalDecision, 'RESPONSE');
    assert.equal(result.decision.decision, 'RESPONSE');
    assert.deepEqual(result.evidenceIds, [observed.evidenceId]);
    assert.deepEqual(result.state.lastReferencedRecordIds, [recordId]);
    assert.equal(decisions.length, 0);
  }
}

console.log('Template-engine multilingual routing and positive evidence release gate passed.');
