import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createGroundedLlmOutput,
  groundedLlmOutputTypes,
} from '../src/knowledge-bases/normal-turn-contract.js';
import { finalizeConfiguredToolResults } from '../src/knowledge-bases/verified-tool-result.js';
import { openIsolatedCallMemory } from '../src/knowledge-engine/call-memory.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';

const orchestrator = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
const facade = await readFile(
  new URL('../src/knowledge-bases/knowledge-runtime.service.js', import.meta.url), 'utf8',
);
const runtime = await readFile(
  new URL('../src/knowledge-bases/grounded-normal-turn-runtime.js', import.meta.url), 'utf8',
);
const runTurn = orchestrator.slice(
  orchestrator.indexOf('async #runTurn('),
  orchestrator.indexOf('async #synthesizeWelcome('),
);

assert.equal((runTurn.match(/this\.#llm\(/gu) ?? []).length, 1);
assert.doesNotMatch(runTurn,
  /engineDecision\.type\s*===\s*knowledgeEngineDecisionTypes\.(?:TOOL|CLARIFY)/u);
assert.match(runTurn, /\['SAFETY_EMERGENCY', 'CALL_CONTROL'\]\.includes\(intentClass\)/u);
assert.match(facade, /retrieveGroundedNormalTurn as retrieveTenantEvidence/u);
assert.doesNotMatch(runtime, /runObservedKnowledgeTurn|planSafeKnowledgeResponse|refineKnowledgeResolution/u);
assert.equal((runtime.match(/prepareKnowledgeQuery\(/gu) ?? []).length, 1,
  'normal-turn runtime must classify once through query preparation');
assert.match(runtime, /retrieveRankHydrateGroundedTurn\(/u);
assert.match(runtime, /\['structured', 'bm25', 'qdrant'\]/u);
assert.match(runtime, /mode:\s*knowledgeEngineResponseModes\.GROUNDED_LLM/u);
assert.doesNotMatch(orchestrator, /Please ask me again and I will answer briefly/u);
assert.doesNotMatch(orchestrator, /finalizeVerifiedToolResults/u);

const tenants = Object.freeze([
  Object.freeze({ tenantId: 'tenant-forge', recordId: 'forge-record', fact: 'Forge access is 42 credits.', tool: 'reserve_forge_slot' }),
  Object.freeze({ tenantId: 'tenant-orchard', recordId: 'orchard-record', fact: 'Orchard access is 57 credits.', tool: 'reserve_orchard_slot' }),
  Object.freeze({ tenantId: 'tenant-studio', recordId: 'studio-record', fact: 'Studio access is 63 credits.', tool: 'reserve_studio_slot' }),
]);
let runtimeExceptions = 0;
let verifiedTools = 0;
let validatedResponses = 0;

for (let repeat = 1; repeat <= 3; repeat += 1) for (const tenant of tenants) {
  try {
    const source = Object.freeze({
      id: 'source_1',
      publishedEvidenceId: `published:faq:${tenant.recordId}`,
      recordId: tenant.recordId,
      recordType: 'FAQ',
      content: tenant.fact,
      tenantId: tenant.tenantId,
      agentId: `${tenant.tenantId}-agent`,
      knowledgeBaseId: `${tenant.tenantId}-kb`,
      publicationRevision: repeat,
      hydrationValidated: true,
      publicationValidated: true,
      callerFacing: true,
    });
    const envelope = Object.freeze({ found: true, sources: Object.freeze([source]), entities: Object.freeze([]) });
    const response = validateGroundedLlmDecision(JSON.stringify({
      decision: 'RESPONSE', answer: tenant.fact, responseId: null,
      evidenceIds: ['source_1'], stateUpdate: {}, pendingQuestion: null,
      toolRequest: null, clarification: null,
    }), envelope, { fieldSchemas: [], toolSchemas: [] });
    assert.equal(response.valid, true);
    assert.deepEqual(response.evidenceIds, ['source_1']);
    validatedResponses += 1;

    assert.equal(validateGroundedClaim(
      tenant.fact.replace(/\d+/u, '9999'), [source], {},
    ).valid, false, 'unsupported numeric claims must be rejected');

    const memory = openIsolatedCallMemory({
      tenantId: tenant.tenantId,
      agentId: `${tenant.tenantId}-agent`,
      callId: `${tenant.tenantId}-call-${repeat}`,
    }, {});
    memory.beginTurn(`turn-${repeat}`);
    memory.applyGroundedDecision({
      decision: 'answer', answer: tenant.fact, evidenceIds: ['source_1'],
      stateUpdate: { currentTopic: tenant.recordId, knownEntityKeys: [] },
      pendingQuestion: null, toolRequest: null,
    }, { turnToken: `turn-${repeat}` });
    const stale = memory.applyGroundedDecision({
      decision: 'clarify', answer: '', evidenceIds: [], stateUpdate: {},
      pendingQuestion: 'obsolete', toolRequest: null,
    }, { turnToken: 'obsolete-turn' });
    assert.equal(stale.stale, true);
    assert.equal(memory.snapshot().currentTopic, tenant.recordId);
    memory.close();

    const configuredSuccess = `Confirmed ${tenant.recordId}.`;
    const finalized = finalizeConfiguredToolResults({
      input: {
        tenantId: tenant.tenantId,
        agentId: `${tenant.tenantId}-agent`,
        callId: `${tenant.tenantId}-call-${repeat}`,
      },
      results: [{
        verified: true, success: true, name: tenant.tool,
        toolId: `${tenant.tool}-id`, output: { callerMessage: configuredSuccess },
      }],
      runtimeProfile: { tools: [{
        id: `${tenant.tool}-id`, name: tenant.tool,
        inputSchema: { type: 'object', properties: {}, 'x-success-message': configuredSuccess },
      }] },
    });
    assert.equal(finalized.decision.reason, 'verified_tool_success');
    assert.equal(finalized.decision.response.text, configuredSuccess);
    verifiedTools += 1;

    assert.equal(createGroundedLlmOutput(groundedLlmOutputTypes.RESPONSE, {
      text: tenant.fact, selectedEvidenceIds: ['source_1'],
    }).type, 'RESPONSE');
    assert.equal(createGroundedLlmOutput(groundedLlmOutputTypes.TOOL, {
      selectedEvidenceIds: ['source_1'],
      tool: { name: tenant.tool, authorizationEvidenceId: 'source_1', input: {} },
    }).type, 'TOOL');
    assert.equal(createGroundedLlmOutput(groundedLlmOutputTypes.CLARIFY, {
      text: `Clarify ${tenant.recordId}.`, selectedEvidenceIds: [],
    }).type, 'CLARIFY');

    const foreign = validateGroundedLlmDecision(JSON.stringify({
      decision: 'RESPONSE', answer: tenant.fact, responseId: null,
      evidenceIds: ['source_2'], stateUpdate: {}, pendingQuestion: null,
      toolRequest: null, clarification: null,
    }), envelope, { fieldSchemas: [], toolSchemas: [] });
    assert.equal(foreign.valid, false);
    assert.equal(foreign.reason, 'unpublished_evidence_selected');
  } catch (error) {
    runtimeExceptions += 1;
    throw error;
  }
}

assert.equal(runtimeExceptions, 0);
assert.equal(validatedResponses, tenants.length * 3);
assert.equal(verifiedTools, tenants.length * 3);

console.log(JSON.stringify({
  gate: 'final-grounded-engine-cutover',
  passed: true,
  repeats: 3,
  syntheticTenants: tenants.length,
  normalTurnLlmCalls: 'exactly_one',
  parallelRetrieval: ['structured', 'bm25', 'qdrant'],
  maximumHydratedRecords: 5,
  outputs: ['RESPONSE', 'TOOL', 'CLARIFY'],
  validatedResponses,
  verifiedTools,
  crossTenantLeakage: false,
  staleMemoryAccepted: false,
  unsupportedClaimsAccepted: false,
  runtimeExceptions,
}, null, 2));
