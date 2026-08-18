import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import {
  selectStrongCallerMessage,
  strongCallerMessageMatch,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';

const approvedResponse = 'We offer Foundation, Advanced and Professional courses. Which course interests you?';
const documentText = [
  'STAGE: positive_offer_response',
  'FLOW: main',
  'TYPE: message',
  'LANGUAGE: en',
  'ENTRY: false',
  'PURPOSE: Continue when the caller accepts the offer.',
  'SITUATION: The caller positively accepts the offer to hear available courses.',
  'EXAMPLES: yes | yes please | okay tell me',
  'MATCH_MODE: semantic',
  'CONTEXT: no_selected_entity',
  `RESPONSE: ${approvedResponse}`,
  'NEXT_QUESTION:',
  '',
  'STAGE: complete_course_overview',
  'FLOW: main',
  'TYPE: message',
  'LANGUAGE: en',
  'ENTRY: false',
  'PURPOSE: Answer requests for all available courses.',
  'SITUATION: The caller asks for all available course options.',
  'EXAMPLES: what courses do you have | what other courses are available',
  'MATCH_MODE: semantic',
  `RESPONSE: ${approvedResponse}`,
  'NEXT_QUESTION:',
].join('\n');

const parsed = processExtractedCategory('conversation_script', {
  fullText: documentText,
  pages: [{ pageNumber: 1, lines: documentText.split('\n') }],
});
assert.equal(parsed.recordCount, 2);
const positive = parsed.records[0];
const overview = parsed.records[1];
const variable = (record, key) => record.variables.find((item) => item.key === key)?.value;
assert.equal(variable(positive, 'situation'), 'The caller positively accepts the offer to hear available courses.');
assert.deepEqual(variable(positive, 'examples'), ['yes', 'yes please', 'okay tell me']);
assert.equal(variable(positive, 'matchMode'), 'semantic');
assert.equal(variable(positive, 'context'), 'no_selected_entity');

const scoped = (record, id) => ({
  id,
  recordId: id,
  recordType: 'CONVERSATION_NODE',
  callerFacing: true,
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  knowledgeBaseId: 'kb-a',
  publicationRevision: 4,
  documentId: 'document-a', documentVersionId: 'version-a',
  hydrationValidated: true, documentStatus: 'ready', documentVersionStatus: 'ready',
  documentVersionIsCurrent: true,
  semanticScore: 0.91,
  semanticRank: 1,
  channels: ['semantic'],
  content: record.content,
  authoritativeData: {
    nodeType: record.nodeType,
    nodeKey: record.nodeKey,
    variables: record.variables,
  },
});
const positiveEvidence = scoped(positive, 'positive');
const overviewEvidence = scoped(overview, 'overview');

assert.equal(strongCallerMessageMatch(
  positiveEvidence, 'I would be happy to hear the choices now', { knownEntities: [] },
), true);
assert.equal(strongCallerMessageMatch(positiveEvidence, 'yes', {
  knownEntities: [{ key: 'advanced-course' }],
}), false);
assert.equal(strongCallerMessageMatch(
  overviewEvidence, 'Could you walk me through everything that is available?', {},
), true);
assert.equal(strongCallerMessageMatch({ ...overviewEvidence, semanticScore: 0.2 }, 'unrelated request', {}), false);
assert.equal(selectStrongCallerMessage([
  overviewEvidence,
  { ...positiveEvidence, semanticScore: 0.89, recordId: 'near-tie' },
], 'ambiguous request', {}), null);

const scope = {
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 4 }],
  requireHydratedEvidence: true,
};
assert.equal(evidenceBelongsToRuntime(overviewEvidence, scope), true);
assert.equal(evidenceBelongsToRuntime({ ...overviewEvidence, tenantId: 'tenant-b' }, scope), false);
assert.equal(evidenceBelongsToRuntime({ ...overviewEvidence, publicationRevision: 3 }, scope), false);
assert.equal(evidenceBelongsToRuntime({ ...overviewEvidence, documentVersionIsCurrent: false }, scope), false);

const orchestrator = await readFile(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
const directBranch = orchestrator.indexOf('if (directResponseValidated)');
const llmBranch = orchestrator.indexOf('response = await this.#llm(query, history, knowledge', directBranch);
assert.ok(directBranch >= 0 && llmBranch > directBranch);
assert.match(orchestrator.slice(directBranch, llmBranch), /response\s*=\s*\{[\s\S]*text:\s*directResponse\.content/);

console.log(JSON.stringify({
  task: 'direct-conversation-message',
  passed: true,
  parsedMatchingMetadata: true,
  contextGuarded: true,
  tenantAgentRevisionValidated: true,
  llmBypassedForValidatedMessage: true,
  businessSpecificRuntimeMatching: false,
}));
