// Stable API facade. The legacy keyword/hybrid runtime was removed during the
// version-1 knowledge-engine cutover; all execution now lives in one engine.
export {
  invalidateTenantKnowledgeCache,
  invalidateTenantRuntimeKnowledgeCache,
  loadPublishedKnowledgeMap,
  retrieveTenantEvidence,
  searchPublishedKnowledge,
  searchPublishedKnowledgeOperation,
} from '../knowledge-engine/runtime-service.js';
