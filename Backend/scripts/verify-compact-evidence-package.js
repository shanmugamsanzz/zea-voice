import assert from 'node:assert/strict';
import {
  createKnowledgeEngineDecision,
  createKnowledgeEngineInput,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';
import {
  buildCompactEvidenceBundle,
  compactBundleAsKnowledge,
} from '../src/knowledge-engine/compact-evidence-bundle.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { hydrateGroundingEnvelope } from '../src/voice/interaction/grounded-claim-validator.js';
import { validateEvidenceScope } from '../src/voice/interaction/grounded-decision-security.js';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const agentId = 'a1000000-0000-4000-8000-000000000002';
const callId = 'a1000000-0000-4000-8000-000000000003';
const input = createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'Compare this option price',
  requestedFacts: ['price'], contextualReferences: ['this'],
  recentRelevantTurns: Array.from({ length: 6 }, (_value, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `Relevant turn ${index + 1}`,
  })),
});

function source(index, recordType = 'CATALOG_ITEM', callerFacing = true) {
  return Object.freeze({
    id: `published:${recordType.toLocaleLowerCase()}:record-${index}`,
    recordId: `record-${index}`, recordType, tenantId, agentId,
    knowledgeBaseId: 'kb-1', publicationRevision: 3,
    documentId: `document-${index}`, documentVersionId: `version-${index}`,
    documentStatus: 'ready', documentVersionStatus: 'ready', documentVersionIsCurrent: true,
    documentName: 'tenant-upload.pdf', documentDisplayName: 'Tenant Upload',
    documentType: 'pdf', pageNumber: index, pageEnd: index,
    content: `Approved evidence ${index}`, callerFacing, rank: index, rrfScore: 1 / (60 + index),
    hydrationValidated: true, publicationValidated: true,
    authoritativeData: recordType === 'CATALOG_ITEM' ? {
      itemKey: `item-${index}`, name: `Item ${index}`, category: 'Options',
      categoryKey: 'options', description: `Approved description ${index}`,
      price: index * 100, currency: 'INR', attributes: [], relationships: {},
      selectionRules: {}, internalSecret: 'must-not-enter-prompt',
    } : recordType === 'CONVERSATION_NODE' ? {
      flowKey: 'main', nodeKey: 'guidance', nodeType: 'guidance', content: 'Keep it brief.',
    } : {
      intent: 'tenant_action', actionType: 'configured_tool',
      actionConfig: { toolIdentifier: 'tenant_tool' }, responseTemplate: '',
    },
    provenance: Object.freeze({
      documentId: `document-${index}`, documentVersionId: `version-${index}`,
      uploadedFilename: 'tenant-upload.pdf', documentDisplayName: 'Tenant Upload',
      pageNumber: index, pageEnd: index,
    }),
  });
}

const callerEvidence = Array.from({ length: 6 }, (_value, index) => source(index + 1));
const guidance = source(20, 'CONVERSATION_NODE', false);
const workflow = source(21, 'WORKFLOW_RULE', false);
const decision = createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
  reason: 'grounded_reasoning',
  mode: knowledgeEngineResponseModes.GROUNDED_LLM,
  evidenceIds: callerEvidence.slice(0, 5).map((item) => item.id),
});
const llmEvidenceBundle = buildCompactEvidenceBundle({
  input,
  classification: { intentClass: 'COMPARISON_COMPLEX' },
  resolution: {
    candidate: {
      recordId: 'record-1', entityType: 'ITEM', itemKey: 'item-1',
      label: 'Item 1', explicit: true,
    },
  },
  authoritative: { evidence: [...callerEvidence, guidance, workflow] },
  runtimeProfile: {
    tools: [{
      id: 'tool-1', name: 'tenant_tool', description: 'Execute tenant action',
      configuration: {
        identifier: 'tenant_tool', inputSchema: {
          type: 'object', required: ['reference'],
          properties: { reference: { type: 'string', title: 'Reference' } },
          additionalProperties: false,
        },
      },
    }, { id: 'tool-2', name: 'unrelated_tool', configuration: {} }],
  },
  decision,
});

assert.equal(llmEvidenceBundle.latestQuestion, 'Compare this option price');
assert.equal(llmEvidenceBundle.canonicalEntity.itemKey, 'item-1');
assert.equal(llmEvidenceBundle.requestedFact, 'price');
assert.equal(llmEvidenceBundle.recentRelevantTurns.length, 4);
assert.equal(llmEvidenceBundle.topEvidence.length, 5);
assert.equal(llmEvidenceBundle.conversationGuidance.length, 1);
assert.deepEqual(llmEvidenceBundle.authorizedToolSchemas.map((tool) => tool.name), ['tenant_tool']);
assert.equal(llmEvidenceBundle.actionAuthorizationEvidence.length, 1);
assert.equal(llmEvidenceBundle.actionAuthorizationEvidence[0].activationAllowed, true);
assert.doesNotMatch(JSON.stringify(llmEvidenceBundle), /must-not-enter-prompt|Approved evidence 6|unrelated_tool/u);
assert.equal(llmEvidenceBundle.topEvidence[0].provenance.uploadedFilename, 'tenant-upload.pdf');

const compactKnowledge = compactBundleAsKnowledge({
  found: true, route: 'large-runtime-object', internalDebug: 'must-not-enter-prompt',
  tenantEvidence: { llmEvidenceBundle, publicationRevisions: [{ knowledgeBaseId: 'kb-1', publicationRevision: 3 }] },
});
assert.equal(compactKnowledge.tenantEvidence.sources.length, 5);
assert.equal(compactKnowledge.tenantEvidence.entities.length, 1);
assert.equal(compactKnowledge.tenantEvidence.actionEvidence.length, 1);
assert.doesNotMatch(JSON.stringify(compactKnowledge), /large-runtime-object|internalDebug/u);

const envelope = buildGroundingEnvelope(compactKnowledge, {
  includePublishedMap: false, maximumSources: 5,
});
assert.deepEqual(envelope.sourceMap[0], {
  sourceId: 'source_1',
  publishedEvidenceId: callerEvidence[0].id,
  recordId: callerEvidence[0].recordId,
});
const hydratedEnvelope = hydrateGroundingEnvelope(envelope, callerEvidence);
assert.equal(hydratedEnvelope.sources[0].id, 'source_1');
assert.equal(hydratedEnvelope.sources[0].publishedEvidenceId, callerEvidence[0].id);
assert.equal(hydratedEnvelope.sources[0].documentId, callerEvidence[0].documentId);
assert.equal(hydratedEnvelope.sources[0].documentVersionId, callerEvidence[0].documentVersionId);
assert.deepEqual(validateEvidenceScope(hydratedEnvelope.sources[0], {
  tenantId, agentId, requireHydratedEvidence: true,
  publicationRevisions: [{ knowledgeBaseId: 'kb-1', publicationRevision: 3 }],
}), { valid: true, reason: null });
assert.equal(validateEvidenceScope({
  ...callerEvidence[0], documentVersionId: undefined,
}, {
  tenantId, agentId, requireHydratedEvidence: true,
  publicationRevisions: [{ knowledgeBaseId: 'kb-1', publicationRevision: 3 }],
}).reason, 'incomplete_evidence_metadata');
assert.equal(validateEvidenceScope({
  ...callerEvidence[0], tenantId: 'foreign-tenant',
}, {
  tenantId, agentId, requireHydratedEvidence: true,
  publicationRevisions: [{ knowledgeBaseId: 'kb-1', publicationRevision: 3 }],
}).reason, 'foreign_evidence_selected');

assert.equal(buildCompactEvidenceBundle({
  input, authoritative: { evidence: callerEvidence },
  decision: createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
    reason: 'deterministic', evidenceIds: [callerEvidence[0].id],
    mode: knowledgeEngineResponseModes.DETERMINISTIC,
    response: { text: 'Approved evidence 1', recordId: 'record-1', recordType: 'CATALOG_ITEM' },
  }),
}), null, 'Deterministic emergency/call-control/direct turns must not create an LLM package');

console.log('Compact evidence-only LLM package and authorized tool schema verified.');
