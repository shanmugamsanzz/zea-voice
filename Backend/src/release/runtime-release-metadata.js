import { env } from '../config/env.js';
import { TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION } from '../voice/interaction/template-engine-production-runtime.js';
import { AGENT_QDRANT_RETRIEVAL_VERSION } from '../voice/interaction/agent-qdrant-retrieval.js';
import { AGENT_QDRANT_GROUNDED_TURN_VERSION } from '../voice/interaction/agent-qdrant-grounded-turn.js';

export function runtimeReleaseMetadata() {
  return Object.freeze({
    gitSha: String(env.DEPLOY_GIT_SHA ?? '').trim() || null,
    engine: 'qdrant_universal_single_llm_v2',
    versions: Object.freeze({
      productionRuntime: TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION,
      qdrantRetrieval: AGENT_QDRANT_RETRIEVAL_VERSION,
      qdrantUniversalTurn: AGENT_QDRANT_GROUNDED_TURN_VERSION,
    }),
  });
}
