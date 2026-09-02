import assert from 'node:assert/strict';
import {
  openGenericConversationState,
} from '../src/voice/interaction/generic-conversation-state.js';
import {
  groundedDecisionJsonSchema,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';
import {
  applyUnifiedGroundedTurn,
} from '../src/voice/interaction/unified-grounded-turn.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3,
  'Zero-evidence multi-tenant regression requires at least three passes');

const tenants = Object.freeze([
  Object.freeze({
    key: 'tenant_alpha', language: 'en',
    support: 'That information is not available in the currently published knowledge.',
    candidate: 'Alpha Canonical Option',
  }),
  Object.freeze({
    key: 'tenant_beta', language: 'ta',
    support: 'அந்த தகவல் தற்போது வெளியிடப்பட்ட அறிவில் கிடைக்கவில்லை.',
    candidate: 'Beta Canonical Option',
  }),
  Object.freeze({
    key: 'tenant_gamma', language: 'es',
    support: 'Esa información no está disponible en el conocimiento publicado actual.',
    candidate: 'Gamma Canonical Option',
  }),
]);

function decision(value) {
  return JSON.stringify({
    responseId: null,
    clarification: value.decision === 'clarify'
      ? { reason: value.clarificationReason ?? 'ambiguous_request' } : null,
    evidenceIds: [],
    stateUpdate: {},
    pendingQuestion: null,
    toolRequest: null,
    ...value,
  });
}

function internalGuidance(tenant, index) {
  return Object.freeze({
    id: `${tenant.key}:internal:${index}`,
    recordId: `${tenant.key}:internal-record:${index}`,
    recordType: index % 2 ? 'WORKFLOW_RULE' : 'CONVERSATION_NODE',
    tenantId: tenant.key,
    agentId: `${tenant.key}:agent`,
    knowledgeBaseId: `${tenant.key}:kb`,
    publicationRevision: 1,
    documentId: `${tenant.key}:document:${index}`,
    documentVersionId: `${tenant.key}:version:${index}`,
    hydrationValidated: true,
    documentStatus: 'ready',
    documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
    callerFacing: false,
    retrievalContext: 'primary',
    content: 'Internal instruction that must never become caller-facing evidence.',
    authoritativeData: index % 2
      ? { actionType: 'respond', responseMode: 'instruction' }
      : { nodeType: 'guidance' },
  });
}

function supportWorkflow(tenant) {
  return Object.freeze({
    id: `${tenant.key}:support-workflow`,
    recordId: `${tenant.key}:support-workflow-record`,
    recordType: 'WORKFLOW_RULE',
    tenantId: tenant.key,
    agentId: `${tenant.key}:agent`,
    knowledgeBaseId: `${tenant.key}:kb`,
    publicationRevision: 1,
    documentId: `${tenant.key}:support-document`,
    documentVersionId: `${tenant.key}:support-version`,
    hydrationValidated: true,
    documentStatus: 'ready',
    documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
    callerFacing: false,
    activationAllowed: true,
    retrievalContext: 'primary',
    content: '',
    authoritativeData: {
      actionType: 'configured_tool',
      actionConfig: {
        toolIdentifier: `${tenant.key}_support`,
        requiresCatalogItem: false,
      },
    },
  });
}

function toolFor(tenant) {
  return Object.freeze({
    id: `${tenant.key}:support-tool`,
    name: `${tenant.key}_support`,
    identifiers: Object.freeze([`${tenant.key}_support`]),
    description: 'Tenant-configured support action',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([]),
      properties: Object.freeze({}),
      'x-confirmation-message': 'Do you want me to continue with this configured action?',
    }),
  });
}

function expectedDecision(tenant, scenario) {
  if (scenario === 'ambiguous_name') return decision({
    decision: 'CLARIFY',
    answer: '',
    pendingQuestion: `Did you mean ${tenant.candidate}?`,
    clarificationReason: 'ambiguous_request',
  });
  if (scenario === 'authorized_support_tool') return decision({
    decision: 'TOOL',
    answer: '',
    toolRequest: { name: `${tenant.key}_support`, arguments: {} },
    stateUpdate: {
      activeToolRequest: { name: `${tenant.key}_support` },
      pendingQuestionRelevant: false,
    },
  });
  return decision({
    decision: 'RESPONSE',
    answer: tenant.support,
  });
}

const scenarios = Object.freeze([
  'clear_unsupported',
  'ambiguous_name',
  'irrelevant_internal_guidance',
  'contextual_follow_up',
  'authorized_support_tool',
]);

let turns = 0;
let llmDecisions = 0;
let targetedClarifications = 0;
let configuredSupportResponses = 0;
let authorizedTools = 0;
let hallucinationsAccepted = 0;
let falseValidationRejections = 0;
let silentTurns = 0;

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const tenant of tenants) {
    for (const scenario of scenarios) {
      const callId = `${tenant.key}:call:${pass}:${scenario}`;
      const turnToken = `${callId}:turn`;
      const initialState = scenario === 'contextual_follow_up' ? {
        knownEntities: [{
          id: `${tenant.key}:missing-record`,
          key: `${tenant.key}:remembered-option`,
          name: `${tenant.key} Remembered Option`,
        }],
        currentTopic: `${tenant.key}:remembered-option`,
      } : {};
      const memory = openGenericConversationState({
        tenantId: tenant.key,
        workspaceId: `${tenant.key}:workspace`,
        agentId: `${tenant.key}:agent`,
        callId,
      }, {}, 1, initialState);
      memory.beginTurn(turnToken);

      const guidance = scenario === 'irrelevant_internal_guidance'
        ? Array.from({ length: 5 }, (_, index) => internalGuidance(tenant, index + 1))
        : [];
      const workflow = scenario === 'authorized_support_tool' ? [supportWorkflow(tenant)] : [];
      const tools = scenario === 'authorized_support_tool' ? [toolFor(tenant)] : [];
      const evidence = Object.freeze([...guidance, ...workflow]);
      const ambiguityCandidates = scenario === 'ambiguous_name' ? [{
        recordId: `${tenant.key}:candidate-record`,
        canonicalName: tenant.candidate,
        name: tenant.candidate,
        confidenceBand: 'MEDIUM',
      }] : [];
      const runtime = {
        toolSchemas: tools,
        zeroEvidenceResponse: tenant.support,
        clarificationContext: {
          heardText: scenario === 'ambiguous_name'
            ? `${tenant.key} phonetic candidate` : `${tenant.key} question`,
          candidates: ambiguityCandidates,
          ambiguityCandidates,
        },
      };
      const schema = groundedDecisionJsonSchema({ found: false, sources: [] }, runtime);
      const expectedExternalDecision = scenario === 'authorized_support_tool'
        ? 'TOOL' : scenario === 'ambiguous_name' ? 'CLARIFY' : 'RESPONSE';
      assert.ok(schema.properties.decision.enum.includes(expectedExternalDecision));

      let callsForTurn = 0;
      const invokeGroundedLlmOnce = () => {
        callsForTurn += 1;
        llmDecisions += 1;
        return expectedDecision(tenant, scenario);
      };
      const rawDecision = invokeGroundedLlmOnce();
      assert.equal(callsForTurn, 1, 'Every finalized zero-evidence turn must use one LLM decision');

      const result = applyUnifiedGroundedTurn({
        rawDecision,
        groundingEnvelope: {
          found: false,
          sources: [],
          entities: [],
          sourceMap: [],
        },
        memory,
        turnToken,
        tools,
        evidence,
        finalizedUtterance: scenario === 'contextual_follow_up'
          ? 'What is its current value?' : `${tenant.key} ${scenario} request`,
        clarificationContext: runtime.clarificationContext,
        zeroEvidenceResponse: tenant.support,
        evidenceScope: {
          tenantId: tenant.key,
          agentId: `${tenant.key}:agent`,
          publicationRevisions: [{
            knowledgeBaseId: `${tenant.key}:kb`,
            publicationRevision: 1,
          }],
        },
      });
      if (!result.valid) falseValidationRejections += 1;
      assert.equal(result.valid, true, `${tenant.key} ${scenario} was falsely rejected`);

      if (scenario === 'ambiguous_name') {
        assert.match(result.answer, new RegExp(tenant.candidate, 'u'));
        assert.match(result.answer, /\?$/u);
        targetedClarifications += 1;
      } else if (scenario === 'authorized_support_tool') {
        assert.equal(result.toolRequest, null,
          'Even a zero-evidence authorized tool must wait for caller confirmation');
        assert.equal(result.nextQuestion?.kind, 'confirmation');
        assert.equal(result.state.activeToolRequest?.name, `${tenant.key}_support`);
        authorizedTools += 1;
      } else {
        assert.equal(result.answer, tenant.support);
        assert.doesNotMatch(result.answer, /Internal instruction/u);
        configuredSupportResponses += 1;
      }
      if (!result.answer && !result.toolRequest) silentTurns += 1;

      const invented = validateGroundedLlmDecision(decision({
        decision: 'RESPONSE',
        answer: `${tenant.key} invented factual answer ${pass}.`,
      }), { found: false, sources: [], entities: [] }, runtime);
      if (invented.valid) hallucinationsAccepted += 1;
      assert.equal(invented.valid, false);
      assert.equal(invented.reason, 'verified_evidence_missing');

      const serialized = JSON.stringify(result);
      for (const other of tenants.filter((candidate) => candidate.key !== tenant.key)) {
        assert.doesNotMatch(serialized, new RegExp(other.key, 'u'),
          'Cross-tenant state or evidence leaked into the zero-evidence turn');
      }
      memory.close();
      turns += 1;
    }
  }
}

assert.equal(llmDecisions, turns);
assert.equal(falseValidationRejections, 0);
assert.equal(hallucinationsAccepted, 0);
assert.equal(silentTurns, 0);

console.log(JSON.stringify({
  gate: 'zero-evidence-multitenant',
  passed: true,
  repeats,
  tenants: tenants.length,
  languages: tenants.map((tenant) => tenant.language),
  scenarios,
  turns,
  llmDecisions,
  targetedClarifications,
  configuredSupportResponses,
  authorizedTools,
  hallucinationsAccepted,
  falseValidationRejections,
  silentTurns,
  crossTenantLeakage: false,
}, null, 2));
