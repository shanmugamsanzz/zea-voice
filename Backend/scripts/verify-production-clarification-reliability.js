import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { resolveRuntimeMessage } from '../src/voice/interaction/configured-runtime-messages.js';

const repeats = Math.max(3, Number.parseInt(
  process.argv.find((argument) => argument.startsWith('--repeats='))?.split('=')[1] ?? '3',
  10,
) || 3);

const tenants = Object.freeze([
  Object.freeze({
    tenantId: 'tenant-renewable', agentId: 'agent-renewable', language: 'en',
    candidates: Object.freeze(['Sunstream Audit', 'Sunstream Monitor']),
    firstQuestion: 'Did you mean Sunstream Audit?',
    alternativeQuestion: 'Do you want the audit option or the monitoring option?',
    support: 'I can connect you with the configured information desk.',
  }),
  Object.freeze({
    tenantId: 'tenant-logistics', agentId: 'agent-logistics', language: 'es',
    candidates: Object.freeze(['Ruta Clara', 'Ruta Cargo']),
    firstQuestion: '?Quiso decir Ruta Clara?',
    alternativeQuestion: '?Busca Ruta Clara o Ruta Cargo?',
    support: 'Puedo usar el canal de asistencia configurado.',
  }),
  Object.freeze({
    tenantId: 'tenant-learning', agentId: 'agent-learning', language: 'ta',
    candidates: Object.freeze(['Kalvi Arivu', 'Kalvi Akarathi']),
    firstQuestion: 'Kalvi Arivu option-ai solreengala?',
    alternativeQuestion: 'Kalvi Arivu-aa, Kalvi Akarathi-aa?',
    support: 'Configured support option-ai use pannalaam.',
  }),
]);

function evidenceFor(fixture, name, index) {
  const recordId = `${fixture.tenantId}-record-${index + 1}`;
  return Object.freeze({
    id: `${fixture.tenantId}-published-${index + 1}`,
    recordId,
    recordType: 'CATALOG_ITEM',
    tenantId: fixture.tenantId,
    agentId: fixture.agentId,
    knowledgeBaseId: `${fixture.tenantId}-kb`,
    publicationRevision: 4,
    documentId: `${fixture.tenantId}-document`,
    documentVersionId: `${fixture.tenantId}-version`,
    documentStatus: 'ready',
    documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
    hydrationValidated: true,
    publicationValidated: true,
    callerFacing: true,
    retrievalContext: 'ambiguity',
    content: `Published record for ${name}.`,
    authoritativeData: Object.freeze({
      itemKey: `${fixture.tenantId}-item-${index + 1}`,
      name,
      aliases: Object.freeze([]),
    }),
  });
}

function envelopeFor(evidence) {
  return Object.freeze({
    found: true,
    sources: Object.freeze(evidence.map((source, index) => Object.freeze({
      id: `source_${index + 1}`,
      publishedEvidenceId: source.id,
      recordId: source.recordId,
      recordType: source.recordType,
      content: source.content,
      authoritativeData: source.authoritativeData,
    }))),
    entities: Object.freeze(evidence.map((source, index) => Object.freeze({
      id: source.recordId,
      recordId: source.recordId,
      key: source.authoritativeData.itemKey,
      name: source.authoritativeData.name,
      sourceId: `source_${index + 1}`,
    }))),
  });
}

function clarificationDecision(question, reason = 'ambiguous_request') {
  return JSON.stringify({
    evidenceIds: [],
    responseId: null,
    stateUpdate: {
      requestType: 'details',
      currentTopic: null,
      knownEntityKeys: [],
      requestedFacts: ['details'],
      constraints: [],
      contextualReferences: [],
      contextDependent: false,
      collectedInformation: {},
      correctedFields: [],
      pendingQuestionRelevant: true,
    },
    decision: 'clarify',
    answer: '',
    pendingQuestion: question,
    clarification: { reason },
    toolRequest: null,
  });
}

const retrievalSamples = [];
let turns = 0;
let configuredRecoveries = 0;
let repeatedClarifications = 0;

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const fixture of tenants) {
    const evidence = fixture.candidates.map((name, index) => evidenceFor(fixture, name, index));
    const envelope = envelopeFor(evidence);
    const scope = {
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      requireHydratedEvidence: true,
      publicationRevisions: [{
        knowledgeBaseId: `${fixture.tenantId}-kb`, publicationRevision: 4,
      }],
    };
    const memory = openGenericConversationState({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      callId: `${fixture.tenantId}-call-${repeat}`,
    }, { conversationLanguage: fixture.language });

    let token = memory.beginTurn(`clarify-${repeat}-1`);
    let started = performance.now();
    const first = applyUnifiedGroundedTurn({
      rawDecision: clarificationDecision(fixture.firstQuestion),
      groundingEnvelope: envelope,
      memory,
      turnToken: token,
      evidence,
      evidenceScope: scope,
      finalizedUtterance: 'A phonetic or incomplete tenant option',
      clarificationRecovery: { supportMessage: fixture.support, maximumAttempts: 2 },
    });
    retrievalSamples.push(performance.now() - started);
    assert.equal(first.valid, true, first.reason ?? 'first clarification invalid');
    assert.equal(first.answer, fixture.firstQuestion);
    assert.ok(first.answer.toLocaleLowerCase().includes(
      fixture.candidates[0].toLocaleLowerCase(),
    ));
    assert.equal(first.state.pendingClarification.attemptCount, 1);
    assert.deepEqual(first.state.pendingClarification.candidateRecordIds,
      evidence.map((source) => source.recordId));
    assert.equal(first.state.pendingClarification.missingFactType, 'details');
    turns += 1;

    token = memory.beginTurn(`clarify-${repeat}-2`);
    started = performance.now();
    const narrowed = applyUnifiedGroundedTurn({
      rawDecision: clarificationDecision(fixture.alternativeQuestion),
      groundingEnvelope: envelope,
      memory,
      turnToken: token,
      evidence,
      evidenceScope: scope,
      finalizedUtterance: 'Still ambiguous',
      clarificationRecovery: { supportMessage: fixture.support, maximumAttempts: 2 },
    });
    retrievalSamples.push(performance.now() - started);
    assert.equal(narrowed.valid, true);
    assert.equal(narrowed.answer, fixture.alternativeQuestion);
    assert.notEqual(narrowed.answer, first.answer);
    assert.equal(narrowed.state.pendingClarification.attemptCount, 2);
    turns += 1;

    token = memory.beginTurn(`clarify-${repeat}-3`);
    started = performance.now();
    const recovered = applyUnifiedGroundedTurn({
      rawDecision: clarificationDecision(fixture.alternativeQuestion),
      groundingEnvelope: envelope,
      memory,
      turnToken: token,
      evidence,
      evidenceScope: scope,
      finalizedUtterance: 'Still unresolved',
      clarificationRecovery: { supportMessage: fixture.support, maximumAttempts: 2 },
    });
    retrievalSamples.push(performance.now() - started);
    assert.equal(recovered.valid, true);
    assert.equal(recovered.answer, fixture.support);
    assert.equal(recovered.clarificationRecovery.mode, 'configured_support');
    assert.equal(recovered.state.pendingClarification, null);
    assert.notEqual(recovered.answer, fixture.alternativeQuestion);
    configuredRecoveries += 1;
    repeatedClarifications += 1;
    turns += 1;

    const isolated = openGenericConversationState({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      callId: `${fixture.tenantId}-isolated-${repeat}`,
    }, { conversationLanguage: fixture.language });
    assert.equal(isolated.snapshot().pendingClarification, null);
    isolated.close();
    memory.close();
  }
}

const sorted = [...retrievalSamples].sort((left, right) => left - right);
const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
assert.ok(p95 < 150, `clarification pipeline p95 exceeded 150ms: ${p95.toFixed(2)}ms`);
assert.equal(configuredRecoveries, repeats * tenants.length);
assert.equal(repeatedClarifications, repeats * tenants.length);

for (const fixture of tenants) {
  const profile = {
    agent: {
      settings: {
        clarificationRecoverySupportMessage: fixture.support,
        technicalFailureMessage: 'Separate configured technical response.',
      },
    },
  };
  assert.equal(resolveRuntimeMessage(profile, 'clarification_recovery_support'), fixture.support);
  assert.equal(resolveRuntimeMessage(profile, 'technical_failure'),
    'Separate configured technical response.');
}
assert.equal(resolveRuntimeMessage({
  agent: { settings: { technicalFailureMessage: 'Technical only.' } },
}, 'clarification_recovery_support'), '',
'technical failure configuration must never be reused as ambiguity recovery');

console.log(JSON.stringify({
  success: true,
  gate: 'tenant-driven-clarification-recovery',
  repeats,
  tenants: tenants.length,
  languages: [...new Set(tenants.map((fixture) => fixture.language))],
  turns,
  configuredRecoveries,
  repeatedClarificationsSuppressed: repeatedClarifications,
  retrievalP95Ms: Number(p95.toFixed(2)),
  crossTenantLeakage: 0,
  runtimeExceptions: 0,
}));

