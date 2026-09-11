import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtimeFiles = [
  '../src/voice/interaction/agent-qdrant-retrieval.js',
  '../src/voice/interaction/agent-qdrant-grounded-turn.js',
  '../src/voice/interaction/qdrant-retrieval-contract.js',
  '../src/voice/interaction/agent-document-embeddings.js',
  '../src/voice/interaction/template-engine-production-runtime.js',
  '../src/agents/agent-qdrant-document.service.js',
  '../src/rag/qdrant.client.js',
  '../src/voice/realtime-conversation-orchestrator.js',
];

const tenantSpecificVocabulary = /\b(?:shanmuga|silver|gold|platinum|onco(?:\s+care)?|diabet(?:es|ic)|pediatric|organ[-\s]+specific)\b/iu;
const sources = await Promise.all(runtimeFiles.map(async (relativePath) => ({
  relativePath,
  source: await readFile(new URL(relativePath, import.meta.url), 'utf8'),
})));

for (const { relativePath, source } of sources) {
  assert.doesNotMatch(source, tenantSpecificVocabulary,
    `${relativePath} contains tenant-specific business vocabulary`);
}

const groundedTurn = sources.find(({ relativePath }) => (
  relativePath.endsWith('/agent-qdrant-grounded-turn.js')
))?.source ?? '';
assert.match(groundedTurn, /agentPrompt/u,
  'The configured agent prompt must control answer behaviour');
assert.match(groundedTurn, /retrieved_chunks/u,
  'Tenant knowledge must enter the LLM through retrieved Qdrant chunks');

console.log(JSON.stringify({
  gate: 'zero-business-vocabulary-release',
  scannedRuntimeFiles: sources.length,
  tenantSpecificBusinessDefaults: 0,
  behaviourSource: 'configured_agent_prompt',
  factualSource: 'tenant_agent_qdrant_chunks',
}, null, 2));
