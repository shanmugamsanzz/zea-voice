import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../src/app.js');
await import('../src/voice/realtime-conversation-orchestrator.js');
const workflowAuthorization = await readFile(new URL(
  '../src/knowledge-bases/workflow-tool-authorization.js', import.meta.url,
), 'utf8');
const realtime = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');

for (const source of [workflowAuthorization]) {
  assert.doesNotMatch(source, /\bknowledge_documents\b/u);
  assert.doesNotMatch(source, /\bknowledge_document_versions\b/u);
  assert.doesNotMatch(source, /\bknowledge_chunks\b/u);
  assert.doesNotMatch(source, /\bknowledge_processing_jobs\b/u);
}
assert.doesNotMatch(realtime, /template-engine-production-retrieval/u);
assert.doesNotMatch(realtime, /ensurePublishedEngineReady/u);
assert.doesNotMatch(realtime, /loadTemplateEngineWorkflowContext/u);
assert.doesNotMatch(realtime, /template-engine-(?:decision-contract|output-validator|post-search-contract|workflow-context|workflow-runtime)/u);
assert.match(realtime, /retrieveAgentQdrantKnowledge/u);
assert.match(realtime, /runAgentQdrantUniversalTurn/u);

console.log(JSON.stringify({
  applicationImports: true,
  realtimeImports: true,
  workflowAuthorizationImports: true,
  legacyWorkflowContextRestored: false,
  legacyDocumentTableDependencies: 0,
  legacyPublicationRuntimeRestored: false,
}, null, 2));
