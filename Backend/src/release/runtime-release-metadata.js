import { env } from '../config/env.js';
import { AUTHORITATIVE_EVIDENCE_VERSION } from '../knowledge-engine/authoritative-evidence.js';
import { TARGETED_RETRIEVAL_VERSION } from '../knowledge-engine/targeted-retrieval.js';
import { TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION } from '../voice/interaction/template-engine-decision-contract.js';
import { TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION } from '../voice/interaction/template-engine-hybrid-retrieval.js';
import { TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION } from '../voice/interaction/template-engine-output-validator.js';
import { TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION } from '../voice/interaction/template-engine-production-retrieval.js';
import { TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION } from '../voice/interaction/template-engine-production-runtime.js';
import { TEMPLATE_ENGINE_WORKFLOW_RUNTIME_VERSION } from '../voice/interaction/template-engine-workflow-runtime.js';

export function runtimeReleaseMetadata() {
  return Object.freeze({
    gitSha: String(env.DEPLOY_GIT_SHA ?? '').trim() || null,
    engine: 'template_engine_v1',
    versions: Object.freeze({
      decisionContract: TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION,
      productionRuntime: TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION,
      productionRetrieval: TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION,
      hybridRetrieval: TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION,
      outputValidator: TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION,
      workflowRuntime: TEMPLATE_ENGINE_WORKFLOW_RUNTIME_VERSION,
      authoritativeEvidence: AUTHORITATIVE_EVIDENCE_VERSION,
      targetedRetrieval: TARGETED_RETRIEVAL_VERSION,
    }),
  });
}
