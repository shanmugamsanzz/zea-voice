import assert from 'node:assert/strict';
import {
  createMessageSource,
  knowledgeMessageSources,
  llmMessageSource,
  MessageSourceTrace,
  maximumMessageSources,
  mergeMessageSources,
  messageSourceTypes,
  toolMessageSources,
} from '../src/voice/source-trace.js';

const prompt = createMessageSource(messageSourceTypes.SYSTEM_PROMPT, {
  id: 'agent-1', label: 'Agent Instructions', metadata: {
    configured: true, apiKey: 'must-not-leak', authorization: 'Bearer must-not-leak',
  },
});
assert.equal(prompt.type, 'system_prompt');
assert.equal(prompt.metadata.configured, true);
assert.equal(prompt.metadata.apiKey, undefined);
assert.equal(prompt.metadata.authorization, undefined);
assert.throws(() => createMessageSource('unknown'), /Unsupported message source type/);

const knowledge = knowledgeMessageSources({
  route: 'catalog', found: true, matches: [{
    id: 'published:catalog_item:item-1',
    recordId: 'item-1', knowledgeBaseId: 'kb-1', documentId: 'document-1',
    documentVersionId: 'version-1', documentName: 'packages.pdf',
    documentDisplayName: 'Published Packages', documentType: 'catalog',
    recordName: 'Gold Master Health Checkup',
    publicationRevision: 4, pageNumber: 2, pageEnd: 3,
    sourceSection: 'service-plans', sourceLineStart: 14, sourceLineEnd: 18,
  }, {
    id: 'published:catalog_item:item-1',
    recordId: 'item-1', knowledgeBaseId: 'kb-1', documentId: 'document-1',
    documentVersionId: 'version-1', documentName: 'packages.pdf',
    pageNumber: 2, pageEnd: 3,
  }] }, ['published:catalog_item:item-1']);
assert.equal(knowledge.length, 1, 'Repeated record/document/page citations must be deduplicated');
assert.equal(knowledge[0].type, 'knowledge');
assert.equal(knowledge[0].metadata.documentName, 'packages.pdf');
assert.equal(knowledge[0].metadata.pageNumber, 2);
assert.equal(knowledge[0].label, 'Published Packages');
assert.equal(knowledge[0].metadata.documentDisplayName, 'Published Packages');
assert.equal(knowledge[0].metadata.documentType, 'catalog');
assert.equal(knowledge[0].metadata.recordName, 'Gold Master Health Checkup');
assert.equal(knowledge[0].metadata.route, undefined);
assert.equal(knowledge[0].metadata.publicationRevision, 4);
assert.equal(knowledge[0].metadata.sourceSection, 'service-plans');
assert.equal(knowledge[0].metadata.sourceLineStart, 14);

const tools = toolMessageSources([{
  id: 'call-1', toolId: 'tool-1', name: 'appointment_slots', success: true, durationMs: 25,
}]);
assert.equal(tools[0].id, 'tool-1');
assert.equal(tools[0].metadata.toolCallId, 'call-1');

const llm = llmMessageSource({
  providerId: 'provider-1', providerName: 'OpenAI', modelId: 'model-1',
  modelKey: 'gpt-4.1-mini', modelName: 'GPT-4.1 Mini',
}, { providerRequestId: 'request-1', finishReason: 'stop' });
assert.equal(llm.type, 'llm');
assert.equal(llm.metadata.providerRequestId, 'request-1');

const merged = mergeMessageSources(prompt, prompt, knowledge, tools, llm);
assert.equal(merged.length, 4);
assert.equal(Object.isFrozen(merged), true);

const turnTrace = new MessageSourceTrace(prompt);
turnTrace.add(knowledge).add(tools).add(llm);
assert.equal(turnTrace.snapshot().length, 4);
assert.equal(Object.isFrozen(turnTrace.snapshot()), true);

const combined = mergeMessageSources(Array.from({ length: maximumMessageSources + 10 }, (_, index) => (
  createMessageSource(messageSourceTypes.KNOWLEDGE, { id: `record-${index}`, label: 'semantic' })
)));
assert.equal(combined.length, maximumMessageSources);
assert.equal(combined[0].id, 'record-0');
assert.equal(combined.at(-1).id, `record-${maximumMessageSources - 1}`);

console.log(JSON.stringify({ success: true, task: 'Message source type contract and capture helpers' }));
