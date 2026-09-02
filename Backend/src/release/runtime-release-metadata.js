import { env } from '../config/env.js';
import { GROUNDED_NORMAL_TURN_RUNTIME_VERSION } from '../knowledge-bases/grounded-normal-turn-runtime.js';
import { GROUNDED_TURN_EVIDENCE_VERSION } from '../knowledge-bases/grounded-turn-evidence.js';
import { AUTHORITATIVE_EVIDENCE_VERSION } from '../knowledge-engine/authoritative-evidence.js';
import { CANONICAL_RETRIEVAL_RESERVATIONS_VERSION } from '../knowledge-engine/canonical-retrieval-reservations.js';
import { CANONICAL_TOPIC_MEMORY_VERSION } from '../knowledge-engine/canonical-topic-memory.js';
import { CONTEXTUAL_QUERY_UNDERSTANDING_VERSION } from '../knowledge-engine/contextual-query-understanding.js';
import { TARGETED_RETRIEVAL_VERSION } from '../knowledge-engine/targeted-retrieval.js';

export function runtimeReleaseMetadata() {
  return Object.freeze({
    gitSha: String(env.DEPLOY_GIT_SHA ?? '').trim() || null,
    engine: 'unified_grounded_decision',
    versions: Object.freeze({
      groundedNormalTurn: GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
      groundedEvidence: GROUNDED_TURN_EVIDENCE_VERSION,
      authoritativeEvidence: AUTHORITATIVE_EVIDENCE_VERSION,
      canonicalReservations: CANONICAL_RETRIEVAL_RESERVATIONS_VERSION,
      canonicalMemory: CANONICAL_TOPIC_MEMORY_VERSION,
      queryUnderstanding: CONTEXTUAL_QUERY_UNDERSTANDING_VERSION,
      targetedRetrieval: TARGETED_RETRIEVAL_VERSION,
    }),
  });
}
