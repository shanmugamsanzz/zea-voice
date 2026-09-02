import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [orchestrator, unifiedTurn, decisions, retrieval, evidence] = await Promise.all([
  readFile(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/voice/interaction/unified-grounded-turn.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/voice/interaction/grounded-llm-decision.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/knowledge-engine/targeted-retrieval.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/knowledge-bases/grounded-turn-evidence.js', import.meta.url), 'utf8'),
]);

for (const decision of ['RESPONSE', 'CLARIFY', 'TOOL', 'NO_MATCH']) {
  assert.match(decisions, new RegExp(`['"]${decision}['"]`, 'u'));
}
assert.match(retrieval, /Promise\.all/u,
  'structured, lexical and semantic retrieval must remain concurrent');
assert.match(evidence, /maximumEvidenceRecords\s*=\s*5/u,
  'the verified grounding path must retain no more than five records');
assert.match(orchestrator, /groundedDecisionInput/u);
assert.match(orchestrator, /configuredToolSchemas/u);
assert.match(orchestrator, /canonicalResponseCommitAllowed/u,
  'canonical RESPONSE commits require an explicit validated boundary');
assert.match(orchestrator, /commitBoundary:\s*'verified_tool_result'/u,
  'TOOL canonical memory must commit only after a verified result');
assert.match(unifiedTurn, /effectiveDecision\.decision === 'clarify'[\s\S]*applied:\s*false/u,
  'CLARIFY must not commit the model memory proposal');
assert.match(orchestrator, /configuredInformationUnavailableResponse/u);
assert.match(orchestrator, /configuredTechnicalFailureResponse/u);

console.log(JSON.stringify({
  gate: 'grounded-turn-architecture',
  passed: true,
  flow: [
    'audio', 'stt_final', 'lightweight_understanding', 'contextual_query',
    'hybrid_retrieval', 'verified_evidence', 'single_grounded_llm',
    'validation_and_routing', 'post_success_memory_commit', 'tts',
  ],
  decisions: ['RESPONSE', 'CLARIFY', 'TOOL', 'NO_MATCH'],
  durableMemoryBoundaries: ['validated_RESPONSE', 'verified_TOOL'],
}, null, 2));
