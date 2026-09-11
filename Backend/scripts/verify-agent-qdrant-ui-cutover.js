import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx|js|jsx)$/u.test(entry.name) ? [target] : [];
  }));
  return files.flat();
}

const frontendSource = new URL('../../Frontend/src/', import.meta.url);
const files = await sourceFiles(frontendSource);
const contents = await Promise.all(files.map(async (file) => ({
  file,
  source: await readFile(file, 'utf8'),
})));

for (const { file, source } of contents) {
  assert.doesNotMatch(source, /\/knowledge-bases(?:[/?'"`]|$)/u,
    `${file.pathname} still calls the removed knowledge-base API`);
}

const [panel, resourceRoutes, resourceSchemas] = await Promise.all([
  readFile(new URL('../../Frontend/src/components/agent/AgentKnowledgeDocumentsPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/agents/agent-resource.routes.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/agents/agent-resource.schemas.js', import.meta.url), 'utf8'),
]);
const { validateOperationalResponseSettings } = await import('../src/agents/agent.service.js');
assert.match(panel, /\/agents\/\$\{agentId\}\/knowledge-documents/u);
assert.match(resourceRoutes, /use\('\/knowledge-documents',agentQdrantDocumentRouter\)/u);
assert.doesNotMatch(resourceRoutes, /use\('\/knowledge-bases/u);
assert.doesNotMatch(resourceSchemas, /agentKnowledgeBase|assignAgentKnowledgeBase/u);
assert.doesNotThrow(() => validateOperationalResponseSettings('active', {
  nonFactualRecoveryMessage: 'Please ask that another way.',
  technicalFailureMessage: 'The service is temporarily unavailable.',
}), 'Active agents must not require the removed static information-unavailable message');

console.log(JSON.stringify({
  cutover: 'agent-qdrant-knowledge-documents',
  frontendFilesScanned: contents.length,
  legacyKnowledgeBaseApiCalls: 0,
  legacyAgentKnowledgeBaseSchemas: 0,
  staticInformationUnavailableMessageRequired: false,
}, null, 2));
