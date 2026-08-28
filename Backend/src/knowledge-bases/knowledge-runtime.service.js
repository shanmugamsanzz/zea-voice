import { randomUUID } from 'node:crypto';
import {
  createKnowledgeEngineInput,
  isKnowledgeEngineInput,
} from '../knowledge-engine/engine-contract.js';
import { retrieveGroundedNormalTurn } from './grounded-normal-turn-runtime.js';

// Stable API facade. The legacy keyword/hybrid runtime was removed during the
// version-1 knowledge-engine cutover; all execution now lives in one engine.
export {
  invalidateKnowledgeBaseArtifacts,
  invalidateTenantKnowledgeCache,
  invalidateTenantRuntimeKnowledgeCache,
  ensurePublishedEngineReady,
  loadPublishedKnowledgeMap,
  searchPublishedKnowledgeOperation,
} from '../knowledge-engine/runtime-service.js';
export { schedulePublishedArtifactRecovery } from './authoritative-artifact-recovery.js';

// The live normal-turn entry point. It performs one query preparation, one
// parallel hybrid retrieval, one RRF/hydration pass and never plans a normal
// direct answer before the grounded LLM.
export {
  GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
  retrieveGroundedNormalTurn,
  retrieveGroundedNormalTurn as retrieveTenantEvidence,
} from './grounded-normal-turn-runtime.js';

export {
  NORMAL_TURN_CONTRACT_VERSION,
  createGroundedLlmOutput,
  createNormalTurnInput,
  deterministicProtocolExceptionTypes,
  groundedLlmOutputTypes,
  isDeterministicProtocolException,
  isNormalTurnInput,
  toKnowledgeEngineInput,
  unifiedNormalTurnContract,
} from './normal-turn-contract.js';
export {
  PARALLEL_HYBRID_SEARCH_VERSION,
  searchParallelHybridCandidates,
} from './parallel-hybrid-search.js';
export {
  CANONICAL_RETRIEVAL_RESERVATIONS_VERSION,
  collectCanonicalRetrievalReservations,
} from '../knowledge-engine/canonical-retrieval-reservations.js';
export {
  GROUNDED_TURN_EVIDENCE_VERSION,
  buildGroundedLlmInput,
  retrieveRankHydrateGroundedTurn,
} from './grounded-turn-evidence.js';

function searchInput(auth, input = {}) {
  if (isKnowledgeEngineInput(input)) return input;
  return createKnowledgeEngineInput({
    tenantId: auth.tenantId,
    agentId: input.agentId,
    callId: input.callId ?? `search-${randomUUID()}`,
    utterance: input.query ?? input.semanticQuery,
    usageDirection: input.usageDirection,
    language: input.language,
    requestedFacts: input.requestedFacts,
    memory: {
      activeEntity: input.activeEntity,
      activeCategory: input.activeCategory,
      latestIntent: input.detectedIntent?.intent,
      recentConversation: input.recentTurns,
      pendingClarification: input.pendingClarification,
      knownEntities: input.knownEntities,
      pendingQuestion: input.pendingQuestion,
      collectedInformation: input.collectedInformation,
    },
  });
}

// Runtime-query API and live voice both execute the exact same grounded
// retrieval path. This adapter changes only the public input shape.
export async function searchPublishedKnowledge(auth, input, dependencies = {}) {
  const engineInput = searchInput(auth, input);
  const result = await retrieveGroundedNormalTurn(auth, engineInput, dependencies);
  return Object.freeze({
    ...result,
    operation: 'search_published_knowledge',
    requestedFacts: engineInput.requestedFacts,
  });
}
