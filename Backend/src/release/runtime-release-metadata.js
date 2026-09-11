import { env } from '../config/env.js';
import { TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION } from '../voice/interaction/template-engine-decision-contract.js';
import { TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION } from '../voice/interaction/template-engine-output-validator.js';
import { TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION } from '../voice/interaction/template-engine-production-runtime.js';
import { TEMPLATE_ENGINE_WORKFLOW_RUNTIME_VERSION } from '../voice/interaction/template-engine-workflow-runtime.js';
import { AGENT_QDRANT_RETRIEVAL_VERSION } from '../voice/interaction/agent-qdrant-retrieval.js';
import { AGENT_QDRANT_GROUNDED_TURN_VERSION } from '../voice/interaction/agent-qdrant-grounded-turn.js';

export function runtimeReleaseMetadata() {
  return Object.freeze({
    gitSha: String(env.DEPLOY_GIT_SHA ?? '').trim() || null,
    engine: 'qdrant_single_llm_v1',
    versions: Object.freeze({
      decisionContract: TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION,
      productionRuntime: TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION,
      qdrantRetrieval: AGENT_QDRANT_RETRIEVAL_VERSION,
      qdrantGroundedTurn: AGENT_QDRANT_GROUNDED_TURN_VERSION,
      outputValidator: TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION,
      workflowRuntime: TEMPLATE_ENGINE_WORKFLOW_RUNTIME_VERSION,
    }),
  });
}
