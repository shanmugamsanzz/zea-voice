import assert from 'node:assert/strict';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';
import { assertNonEmptyGroundedPackage } from '../src/knowledge-bases/grounded-normal-turn-runtime.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal support regression requires at least three passes');

const tenants = Object.freeze([
  {
    key: 'assembly', concern: 'unstable rotation',
    optionKey: 'balance-review', optionName: 'Balance Review',
    supportText: 'Use the published support assessment before selecting an option.',
  },
  {
    key: 'learning', concern: 'pronunciation difficulty',
    optionKey: 'speech-track', optionName: 'Speech Track',
    supportText: 'Use the published learning assessment before selecting a track.',
  },
  {
    key: 'navigation', concern: 'low-light tracking difficulty',
    optionKey: 'night-guidance', optionName: 'Night Guidance',
    supportText: 'Use the published navigation assessment before selecting a service.',
  },
]);

function scope(definition, repeat) {
  return {
    tenantId: `tenant-${definition.key}-${repeat}`,
    agentId: `agent-${definition.key}-${repeat}`,
    callId: `call-${definition.key}-${repeat}`,
    knowledgeBaseId: `kb-${definition.key}-${repeat}`,
    publicationRevision: repeat + 1,
  };
}

function evidenceRecord(definition, currentScope, type) {
  const workflow = type === 'WORKFLOW_RULE';
  const recordId = `${type.toLocaleLowerCase()}-${definition.key}`;
  const documentId = `document-${type.toLocaleLowerCase()}-${definition.key}`;
  const documentVersionId = `version-${type.toLocaleLowerCase()}-${definition.key}`;
  const content = workflow
    ? definition.supportText
    : `${definition.optionName} has a published relationship to ${definition.concern}.`;
  const authoritativeData = workflow ? {
    actionType: 'respond', responseTemplate: definition.supportText,
    relationships: { supports: [definition.concern] },
  } : {
    itemKey: definition.optionKey, name: definition.optionName,
    relationships: { recommendedFor: [definition.concern] },
  };
  return Object.freeze({
    id: `published:${currentScope.knowledgeBaseId}:${currentScope.publicationRevision}:${recordId}`,
    publishedEvidenceId: `published:${currentScope.knowledgeBaseId}:${currentScope.publicationRevision}:${recordId}`,
    recordId, recordType: type, content, callerFacing: true,
    tenantId: currentScope.tenantId, agentId: currentScope.agentId,
    knowledgeBaseId: currentScope.knowledgeBaseId,
    publicationRevision: currentScope.publicationRevision,
    documentId, documentVersionId,
    documentName: `${definition.key}-${type.toLocaleLowerCase()}.txt`,
    documentDisplayName: `${definition.key} ${type.toLocaleLowerCase()}`,
    documentType: 'TXT', pageNumber: 1,
    hydrationValidated: true, publicationValidated: true,
    documentStatus: 'ready', documentVersionStatus: 'ready',
    documentVersionIsCurrent: true, rank: 1, rrfScore: 0.9,
    authoritativeData,
    provenance: Object.freeze({
      tenantId: currentScope.tenantId, agentId: currentScope.agentId,
      knowledgeBaseId: currentScope.knowledgeBaseId,
      publicationRevision: currentScope.publicationRevision,
      recordId, recordType: type, documentId, documentVersionId,
      uploadedFilename: `${definition.key}-${type.toLocaleLowerCase()}.txt`,
      documentDisplayName: `${definition.key} ${type.toLocaleLowerCase()}`,
      documentType: 'TXT', pageNumber: 1,
    }),
  });
}

function staleRecord(definition, currentScope) {
  const record = evidenceRecord({
    ...definition, optionKey: 'previous-topic', optionName: 'Previous Topic',
  }, currentScope, 'CATALOG_ITEM');
  return Object.freeze({
    ...record, id: `${record.id}:stale`, publishedEvidenceId: `${record.id}:stale`,
    recordId: `${record.recordId}:stale`,
    provenance: Object.freeze({ ...record.provenance, recordId: `${record.recordId}:stale` }),
  });
}

function llmInputFor({ definition, currentScope, question, evidence, stale = null, catalog = false }) {
  const selected = catalog ? evidence.find((record) => record.recordType === 'CATALOG_ITEM')
    : evidence.find((record) => record.recordType === 'WORKFLOW_RULE');
  const route = {
    recordId: selected.recordId, recordType: selected.recordType,
    entityType: catalog ? 'ITEM' : 'ROUTE', explicit: catalog, score: 0.93,
  };
  const memory = stale ? {
    activeEntity: {
      recordId: stale.recordId, id: stale.recordId,
      key: stale.authoritativeData.itemKey, name: stale.authoritativeData.name,
    },
  } : {};
  return buildGroundedLlmInput({
    input: {
      tenantId: currentScope.tenantId, agentId: currentScope.agentId,
      callId: currentScope.callId, utterance: question, latestQuestion: question,
      memory, canonicalCallMemory: memory, recentRelevantTurns: [],
      queryUnderstanding: {
        explicitEntities: catalog ? [route] : [], explicitCategories: [],
        comparisonEntities: [], contextDependent: false,
        currentRouteSignal: route, explicitCurrentRoute: route,
      },
    },
    classification: { intentClass: catalog ? 'DETAILS_OR_PRICE' : 'KNOWN_INFORMATION' },
    resolution: {
      candidateNamespace: catalog ? 'CATALOG' : 'WORKFLOW',
      contextDependent: false, candidate: route, routingCandidates: [route],
    },
    authoritative: { evidence }, runtimeProfile: { tools: [] },
  });
}

function envelopeSources(records) {
  return records.map((record) => ({
    ...record,
    id: record.publishedEvidenceId,
    knowledgeBaseId: record.provenance.knowledgeBaseId,
    publicationRevision: record.provenance.publicationRevision,
    documentId: record.provenance.documentId,
    documentVersionId: record.provenance.documentVersionId,
  }));
}

function validateAnswer({ definition, currentScope, llmInput, originalEvidence, answer }) {
  assert.ok(llmInput.hydratedRecords.length > 0, 'Known support evidence must not be empty');
  assertNonEmptyGroundedPackage({ evidence: originalEvidence }, llmInput);
  const permittedEvidenceIds = new Set(llmInput.hydratedRecords
    .map((record) => record.publishedEvidenceId));
  const validationEvidence = originalEvidence.filter((record) => (
    permittedEvidenceIds.has(record.id)
  ));
  assert.equal(validationEvidence.length, llmInput.hydratedRecords.length,
    'Validation must use exactly the authoritative records permitted by packaging');
  const envelope = buildGroundingEnvelope({
    found: true, tenantEvidence: { sources: envelopeSources(llmInput.hydratedRecords) },
  }, { includePublishedMap: false });
  assert.ok(envelope.sources.length > 0, 'Grounding envelope must contain caller-facing evidence');
  for (const source of envelope.sources) {
    const packaged = llmInput.hydratedRecords.find((record) => (
      record.publishedEvidenceId === source.publishedEvidenceId
    ));
    assert.ok(packaged, 'LLM source ID must map to a packaged published evidence ID');
    assert.equal(packaged.recordId, source.recordId,
      'Published evidence ID must map to the authoritative PostgreSQL record ID');
  }
  const memory = openGenericConversationState({
    tenantId: currentScope.tenantId, workspaceId: `workspace-${definition.key}`,
    agentId: currentScope.agentId, callId: currentScope.callId,
  }, {}, 1);
  const turnToken = `turn-${definition.key}-${currentScope.publicationRevision}-${answer.length}`;
  memory.beginTurn(turnToken);
  const selected = envelope.sources[0];
  const result = applyUnifiedGroundedTurn({
    rawDecision: JSON.stringify({
      decision: 'answer', answer, responseId: null,
      evidenceIds: [selected.id], stateUpdate: {
        currentTopic: null, knownEntityKeys: [], collectedInformation: {}, correctedFields: [],
      },
      pendingQuestion: null, toolRequest: null, clarification: null,
    }),
    groundingEnvelope: envelope, memory, turnToken,
    evidence: validationEvidence, finalizedUtterance: llmInput.currentQuestion,
    evidenceScope: {
      tenantId: currentScope.tenantId, agentId: currentScope.agentId,
      requireHydratedEvidence: true,
      publicationRevisions: [{
        knowledgeBaseId: currentScope.knowledgeBaseId,
        publicationRevision: currentScope.publicationRevision,
      }],
    },
  });
  assert.equal(result.valid, true, `Supported answer was rejected: ${result.reason}`);
  assert.notEqual(result.reason, 'verified_evidence_missing');
  assert.notEqual(result.decision, 'clarify');
  memory.close();
  return envelope.sources.length;
}

let validatedTurns = 0;
let mappedSources = 0;
for (let repeat = 0; repeat < repeats; repeat += 1) {
  for (const definition of tenants) {
    const currentScope = scope(definition, repeat);
    const workflow = evidenceRecord(definition, currentScope, 'WORKFLOW_RULE');
    const catalog = evidenceRecord(definition, currentScope, 'CATALOG_ITEM');
    const stale = staleRecord(definition, currentScope);

    const concern = llmInputFor({
      definition, currentScope,
      question: `The caller reports ${definition.concern}.`, evidence: [workflow],
    });
    mappedSources += validateAnswer({
      definition, currentScope, llmInput: concern,
      originalEvidence: [workflow], answer: definition.supportText,
    });
    validatedTurns += 1;

    const afterStaleTopic = llmInputFor({
      definition, currentScope,
      question: `The caller now reports ${definition.concern}.`,
      evidence: [stale, workflow], stale,
    });
    assert.deepEqual(afterStaleTopic.hydratedRecords.map((record) => record.recordId),
      [workflow.recordId], 'A current concern must override stale Catalog memory');
    mappedSources += validateAnswer({
      definition, currentScope, llmInput: afterStaleTopic,
      originalEvidence: [stale, workflow], answer: definition.supportText,
    });
    validatedTurns += 1;

    const recommendation = llmInputFor({
      definition, currentScope,
      question: `Which published option relates to ${definition.concern}?`,
      evidence: [catalog, workflow], catalog: true,
    });
    assert.deepEqual(recommendation.hydratedRecords.map((record) => record.recordId),
      [catalog.recordId], 'The explicitly resolved option must outrank unrelated evidence');
    mappedSources += validateAnswer({
      definition, currentScope, llmInput: recommendation,
      originalEvidence: [catalog, workflow], answer: catalog.content,
    });
    validatedTurns += 1;
  }
}

console.log(JSON.stringify({
  gate: 'universal-symptom-support-regression', passed: true,
  repeats, syntheticTenants: tenants.length, validatedTurns, mappedSources,
  nonEmptyEvidence: true, staleTopicInterference: false,
  verifiedEvidenceMissing: false, falseClarification: false,
  callerFacingWorkflowRespondValidated: true,
}, null, 2));
