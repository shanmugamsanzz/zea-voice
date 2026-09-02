import assert from 'node:assert/strict';
import { understandContextualKnowledgeQuery } from '../src/knowledge-engine/contextual-query-understanding.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';
import {
  assertNonEmptyGroundedPackage,
  isRecoverableGroundedEvidenceFailure,
  scheduleGroundedEvidenceRecovery,
} from '../src/knowledge-bases/grounded-normal-turn-runtime.js';

const scope = {
  tenantId: '97000000-0000-4000-8000-000000000001',
  agentId: '97000000-0000-4000-8000-000000000002',
  callId: '97000000-0000-4000-8000-000000000003',
};
const knowledgeBaseId = '97000000-0000-4000-8000-000000000008';
const staleEntity = {
  recordId: '97000000-0000-4000-8000-000000000004',
  key: 'prior-option', name: 'Prior Option',
};
const supportRoute = {
  recordId: '97000000-0000-4000-8000-000000000005',
  recordType: 'WORKFLOW_RULE', entityType: 'ROUTE',
  label: 'Published support route', intentClass: 'KNOWN_INFORMATION',
  actionType: 'respond', explicit: true, score: 0.95,
};
const memory = { activeEntity: staleEntity };
const understanding = understandContextualKnowledgeQuery({
  ...scope, utterance: 'A current tenant concern.', memory,
}, {
  tenantId: scope.tenantId, candidate: supportRoute, action: 'RETRIEVE',
  routingCandidates: [supportRoute], alternatives: [],
  namespaceCandidates: { WORKFLOW: [supportRoute] },
});

assert.equal(understanding.contextDependent, false);
assert.equal(understanding.canonicalContext, null);
assert.equal(understanding.currentRouteSignal.recordId, supportRoute.recordId);

const llmInput = buildGroundedLlmInput({
  input: {
    ...scope, utterance: 'A current tenant concern.', latestQuestion: 'A current tenant concern.',
    memory, canonicalCallMemory: memory, queryUnderstanding: understanding,
    recentRelevantTurns: [], requestedFacts: [],
  },
  classification: { intentClass: 'KNOWN_INFORMATION' },
  resolution: {
    candidateNamespace: 'CATALOG', contextDependent: false,
    candidate: { ...staleEntity, recordType: 'CATALOG_ITEM', explicit: false },
  },
  authoritative: {
    evidence: [
      {
        id: 'published:catalog_item:prior', recordId: staleEntity.recordId,
        recordType: 'CATALOG_ITEM', callerFacing: true,
        hydrationValidated: true, publicationValidated: true,
        authoritativeData: { itemKey: staleEntity.key, name: staleEntity.name },
      },
      {
        id: 'published:workflow_rule:support', recordId: supportRoute.recordId,
        recordType: 'WORKFLOW_RULE', callerFacing: true,
        hydrationValidated: true, publicationValidated: true,
        authoritativeData: { actionType: 'respond', responseTemplate: 'Published support response.' },
      },
      {
        id: 'published:knowledge_chunk:boundary',
        recordId: '97000000-0000-4000-8000-000000000006',
        recordType: 'KNOWLEDGE_CHUNK', callerFacing: true,
        hydrationValidated: true, publicationValidated: true,
        authoritativeData: { content: 'Published support boundary.' },
      },
    ].map((source, index) => ({
      ...source,
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      knowledgeBaseId,
      publicationRevision: 4,
      documentId: `97000000-0000-4000-8100-00000000000${index + 1}`,
      documentVersionId: `97000000-0000-4000-8200-00000000000${index + 1}`,
    })),
  },
  runtimeProfile: { tools: [] },
});

assert.deepEqual(llmInput.hydratedRecords.map((source) => source.recordType),
  ['WORKFLOW_RULE']);
assert.equal(llmInput.hydratedRecords.some((source) => source.recordType === 'CATALOG_ITEM'), false);
assert.ok(llmInput.hydratedRecords.every((source) => source.sourceId));
assert.ok(llmInput.hydratedRecords.length > 0);
assert.equal(assertNonEmptyGroundedPackage({
  evidence: llmInput.hydratedRecords.map((source) => ({
    ...source, id: source.publishedEvidenceId,
    hydrationValidated: true, publicationValidated: true,
  })),
}, llmInput).length, 1);
assert.throws(() => assertNonEmptyGroundedPackage({
  evidence: [{
    id: 'published:workflow_rule:removed',
    recordId: '97000000-0000-4000-8000-000000000007',
    recordType: 'WORKFLOW_RULE', callerFacing: true,
    hydrationValidated: true, publicationValidated: true,
  }],
}, { hydratedRecords: [] }), (error) => (
  error.code === 'KNOWLEDGE_GROUNDED_PACKAGE_EMPTY'
  && error.details?.stage === 'grounded_evidence_packaging'
));
assert.equal(isRecoverableGroundedEvidenceFailure('KNOWLEDGE_GROUNDED_PACKAGE_EMPTY'), true,
  'An empty package after valid hydration must trigger publication artifact recovery');
let scheduledRecovery = null;
const recovery = await scheduleGroundedEvidenceRecovery(
  { tenantId: scope.tenantId },
  [{ knowledgeBaseId, publicationRevision: 4 }],
  {
    code: 'KNOWLEDGE_GROUNDED_PACKAGE_EMPTY',
    details: { stage: 'grounded_evidence_packaging' },
  },
  {
    schedulePublishedArtifactRecovery: async (_auth, publications, reason) => {
      scheduledRecovery = { publications, reason };
      return [{ scheduled: true, knowledgeBaseId, publicationRevision: 4 }];
    },
  },
);
assert.equal(scheduledRecovery.reason, 'KNOWLEDGE_GROUNDED_PACKAGE_EMPTY');
assert.deepEqual(scheduledRecovery.publications, [{ knowledgeBaseId, publicationRevision: 4 }]);
assert.equal(recovery[0].scheduled, true);

console.log(JSON.stringify({
  task: 'caller-facing-workflow-evidence', passed: true,
  staleCatalogExcluded: true, evidenceRecords: llmInput.hydratedRecords.length,
  emptyPackageRejectedOperationally: true,
}, null, 2));
