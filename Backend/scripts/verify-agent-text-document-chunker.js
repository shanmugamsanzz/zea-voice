import assert from 'node:assert/strict';
import { createAgentTextDocumentBatch } from '../src/voice/interaction/agent-text-document-contract.js';
import {
  chunkAgentTextDocumentBatch,
  normalizeAgentDocumentText,
} from '../src/voice/interaction/agent-text-document-chunker.js';

let documentNumber = 0;
const batch = createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a', files: [
    { originalname: 'first.txt', buffer: Buffer.from(
      ' First  sentence has useful context.\r\nSecond sentence continues it.\r\n\r\n' +
      'A separate paragraph remains connected to nearby context.',
    ) },
    { originalname: 'second.txt', buffer: Buffer.from(
      'one two three four one two three four',
    ) },
  ],
}, { createDocumentId: () => `document-${++documentNumber}` });

assert.equal(normalizeAgentDocumentText('\uFEFF One  line.\r\n\r\n Next\tline. '),
  'One line.\n\nNext line.');

const result = chunkAgentTextDocumentBatch(batch, {
  chunkSizeTokens: 8,
  chunkOverlapTokens: 2,
  maximumChunkCharacters: 120,
});
assert.equal(result.documents.length, 2);
assert.ok(result.chunks.length >= 3);
assert.ok(result.chunks.every((chunk) => chunk.tokenCount <= 8));
assert.ok(result.chunks.every((chunk) => chunk.text.length <= 120));
assert.ok(result.chunks.every((chunk) => /^[a-f0-9]{64}$/u.test(chunk.contentHash)));
assert.ok(result.chunks.every((chunk) => chunk.documentId === 'document-1'
  || chunk.documentId === 'document-2'));
assert.equal(new Set(result.chunks.map((chunk) => chunk.contentHash)).size, result.chunks.length,
  'Duplicate chunk content must be removed');
assert.ok(result.chunks.some((chunk) => chunk.overlapTokenCount === 2),
  'Configured context overlap must be preserved');
assert.ok(result.chunks.some((chunk) => chunk.text.endsWith('.')),
  'Natural sentence boundaries should be preferred');

const shortDocument = chunkAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a', documents: [{
    id: 'short-document', filename: 'short.txt', text: 'First sentence. Final fragment',
  }],
}, { chunkSizeTokens: 20, chunkOverlapTokens: 2, maximumChunkCharacters: 200 });
assert.equal(shortDocument.chunks.length, 1,
  'A complete document below both limits must remain in one chunk');

const longToken = chunkAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a', documents: [{
    id: 'long-document', filename: 'long.txt', text: 'x'.repeat(260),
  }],
}, { chunkSizeTokens: 8, chunkOverlapTokens: 2, maximumChunkCharacters: 100 });
assert.deepEqual(longToken.chunks.map((chunk) => chunk.text.length), [100, 60],
  'Repeated identical fragments should not create duplicate vectors');

assert.throws(() => chunkAgentTextDocumentBatch(batch, {
  chunkSizeTokens: 8, chunkOverlapTokens: 8, maximumChunkCharacters: 120,
}), /smaller than chunkSizeTokens/u);

console.log(JSON.stringify({
  chunking: 'normalized-overlapping-text',
  documentCount: result.documents.length,
  chunkCount: result.chunks.length,
  duplicateChunks: 0,
  naturalBoundaries: true,
}, null, 2));
