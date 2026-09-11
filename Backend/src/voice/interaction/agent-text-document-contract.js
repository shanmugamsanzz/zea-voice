import { createHash, randomUUID } from 'node:crypto';

export const AGENT_TEXT_DOCUMENT_LIMITS = Object.freeze({
  maximumFilesPerUpload: 20,
  maximumBytesPerFile: 25 * 1024 * 1024,
  maximumFilenameCharacters: 240,
});

function cleanIdentifier(value, label) {
  const identifier = String(value ?? '').normalize('NFKC').trim().slice(0, 200);
  if (!identifier) throw new TypeError(`Text document upload requires ${label}`);
  return identifier;
}

function safeFilename(value) {
  const supplied = String(value ?? '').normalize('NFKC').trim();
  const filename = supplied.split(/[\\/]/u).at(-1)?.trim().slice(
    0, AGENT_TEXT_DOCUMENT_LIMITS.maximumFilenameCharacters,
  );
  if (!filename || !/\.txt$/iu.test(filename)) {
    throw new TypeError('Knowledge documents must be ordinary .txt files');
  }
  return filename;
}

function sourceBuffer(file) {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  if (file?.buffer instanceof Uint8Array) return Buffer.from(file.buffer);
  throw new TypeError('Text document upload requires an in-memory file buffer');
}

function assertPlainTextMimeType(file, filename) {
  const mimeType = String(file?.mimetype ?? file?.mimeType ?? '').trim().toLocaleLowerCase();
  if (mimeType && !['text/plain', 'application/octet-stream'].includes(mimeType)) {
    throw new TypeError(`${filename} must use the text/plain content type`);
  }
}

function decodeUtf8(buffer, filename) {
  if (!buffer.length) throw new TypeError(`${filename} is empty`);
  if (buffer.length > AGENT_TEXT_DOCUMENT_LIMITS.maximumBytesPerFile) {
    throw new TypeError(`${filename} exceeds the text document size limit`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new TypeError(`${filename} must contain valid UTF-8 text`);
  }
  text = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (text.includes('\0')) throw new TypeError(`${filename} contains binary data`);
  if (!text.trim()) throw new TypeError(`${filename} contains no readable text`);
  return text;
}

function normalizedFiles(value) {
  const files = Array.isArray(value) ? value : value ? [value] : [];
  if (!files.length) throw new TypeError('Upload at least one text document');
  if (files.length > AGENT_TEXT_DOCUMENT_LIMITS.maximumFilesPerUpload) {
    throw new TypeError('Too many text documents in one upload');
  }
  return files;
}

/**
 * Converts one or more ordinary multipart text files into the document input
 * consumed by the future chunk-and-embed pipeline. It deliberately has no
 * catalog, hierarchy, publication, heading or document-type fields.
 */
export function createAgentTextDocumentBatch({
  tenantId,
  agentId,
  files,
} = {}, dependencies = {}) {
  const resolvedTenantId = cleanIdentifier(tenantId, 'tenantId');
  const resolvedAgentId = cleanIdentifier(agentId, 'agentId');
  const createDocumentId = dependencies.createDocumentId ?? randomUUID;
  const documents = normalizedFiles(files).map((file) => {
    const filename = safeFilename(file.originalname ?? file.filename ?? file.name);
    assertPlainTextMimeType(file, filename);
    const buffer = sourceBuffer(file);
    const text = decodeUtf8(buffer, filename);
    return Object.freeze({
      id: cleanIdentifier(createDocumentId(), 'documentId'),
      filename,
      mimeType: 'text/plain',
      byteLength: buffer.length,
      checksumSha256: createHash('sha256').update(buffer).digest('hex'),
      text,
    });
  });
  return Object.freeze({
    tenantId: resolvedTenantId,
    agentId: resolvedAgentId,
    documents: Object.freeze(documents),
  });
}
