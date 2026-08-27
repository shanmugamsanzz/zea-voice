// Stable API facade. The legacy keyword/hybrid runtime was removed during the
// version-1 knowledge-engine cutover; all execution now lives in one engine.
export {
  invalidateKnowledgeBaseArtifacts,
  invalidateTenantKnowledgeCache,
  invalidateTenantRuntimeKnowledgeCache,
  ensurePublishedEngineReady,
  loadPublishedKnowledgeMap,
  searchPublishedKnowledge,
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
  groundedLlmOutputTypes,
  isNormalTurnInput,
  toKnowledgeEngineInput,
} from './normal-turn-contract.js';
export {
  PARALLEL_HYBRID_SEARCH_VERSION,
  searchParallelHybridCandidates,
} from './parallel-hybrid-search.js';
export {
  GROUNDED_TURN_EVIDENCE_VERSION,
  buildGroundedLlmInput,
  retrieveRankHydrateGroundedTurn,
} from './grounded-turn-evidence.js';
