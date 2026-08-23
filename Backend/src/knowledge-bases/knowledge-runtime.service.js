// Stable API facade. The legacy keyword/hybrid runtime was removed during the
// version-1 knowledge-engine cutover; all execution now lives in one engine.
export {
  invalidateKnowledgeBaseArtifacts,
  invalidateTenantKnowledgeCache,
  invalidateTenantRuntimeKnowledgeCache,
  ensurePublishedEngineReady,
  loadPublishedKnowledgeMap,
  retrieveTenantEvidence,
  searchPublishedKnowledge,
  searchPublishedKnowledgeOperation,
} from '../knowledge-engine/runtime-service.js';
