import assert from 'node:assert/strict';
import { createAgentTextDocumentBatch } from '../src/voice/interaction/agent-text-document-contract.js';

let nextId = 0;
const batch = createAgentTextDocumentBatch({
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  files: [
    {
      originalname: 'information.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('Ordinary text.\nNo special headings are required.', 'utf8'),
    },
    {
      originalname: 'தமிழ்.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('\uFEFFதமிழ் தகவல்\r\nஇரண்டாவது வரி', 'utf8'),
    },
  ],
}, { createDocumentId: () => `document-${++nextId}` });

assert.deepEqual(Object.keys(batch), ['tenantId', 'agentId', 'documents']);
assert.equal(batch.documents.length, 2);
assert.deepEqual(batch.documents.map(({ id }) => id), ['document-1', 'document-2']);
assert.equal(batch.documents[0].filename, 'information.txt');
assert.equal(batch.documents[1].text, 'தமிழ் தகவல்\nஇரண்டாவது வரி');
assert.ok(batch.documents.every(({ mimeType }) => mimeType === 'text/plain'));
assert.ok(batch.documents.every(({ checksumSha256 }) => /^[a-f0-9]{64}$/u.test(checksumSha256)));
assert.ok(batch.documents.every((document) => !Object.hasOwn(document, 'documentType')));
assert.ok(batch.documents.every((document) => !Object.hasOwn(document, 'publication')));

const single = createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a',
  files: { originalname: 'single.TXT', buffer: Buffer.from('One document is valid.') },
}, { createDocumentId: () => 'single-document' });
assert.equal(single.documents.length, 1);

assert.throws(() => createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a',
  files: [{ originalname: 'structured.pdf', buffer: Buffer.from('PDF') }],
}), /ordinary \.txt files/u);
assert.throws(() => createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a',
  files: [{ originalname: 'renamed.txt', mimetype: 'application/pdf', buffer: Buffer.from('PDF') }],
}), /text\/plain content type/u);
assert.throws(() => createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a',
  files: [{ originalname: 'invalid.txt', buffer: Buffer.from([0xc3, 0x28]) }],
}), /valid UTF-8 text/u);
assert.throws(() => createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a', files: [],
}), /at least one/u);

console.log(JSON.stringify({
  contract: 'agent-text-document-batch',
  multipleDocuments: true,
  plainTextOnly: true,
  specialFormatRequired: false,
  postgresWrites: 0,
}, null, 2));
