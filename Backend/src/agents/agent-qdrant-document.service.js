import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import {
  deleteTenantAgentDocumentPoints,
  ensureTenantCollection,
  scrollTenantAgentDocumentPoints,
  upsertTenantPoints,
} from '../rag/qdrant.client.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';
import { createAgentTextDocumentBatch } from '../voice/interaction/agent-text-document-contract.js';
import { chunkAgentTextDocumentBatch } from '../voice/interaction/agent-text-document-chunker.js';
import { embedAgentDocumentChunks } from '../voice/interaction/agent-document-embeddings.js';
import { getAgent } from './agent.service.js';

function pointUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function dependencies(overrides = {}) {
  return {
    ensureAgent: overrides.ensureAgent ?? getAgent,
    ensureCollection: overrides.ensureCollection ?? ensureTenantCollection,
    embedChunks: overrides.embedChunks ?? embedAgentDocumentChunks,
    upsertPoints: overrides.upsertPoints ?? upsertTenantPoints,
    scrollPoints: overrides.scrollPoints ?? scrollTenantAgentDocumentPoints,
    deletePoints: overrides.deletePoints ?? deleteTenantAgentDocumentPoints,
    now: overrides.now ?? (() => new Date()),
  };
}

export function qdrantAgentDocumentPoint(tenantId, agentId, document, chunk, uploadedAt) {
  return Object.freeze({
    id: pointUuid(`${tenantId}:${agentId}:${chunk.id}:${chunk.contentHash}`),
    vector: chunk.embedding,
    payload: Object.freeze({
      tenant_id: tenantId,
      agent_id: agentId,
      document_id: document.id,
      filename: document.filename,
      chunk_id: chunk.id,
      chunk_index: chunk.chunkIndex,
      chunk_start: chunk.characterStart,
      chunk_end: chunk.characterEnd,
      chunk_token_count: chunk.tokenCount,
      chunk_overlap_tokens: chunk.overlapTokenCount,
      chunk_text: chunk.text,
      content_hash: chunk.contentHash,
      document_checksum_sha256: document.checksumSha256,
      byte_length: document.byteLength,
      mime_type: 'text/plain',
      uploaded_at: uploadedAt,
      source_kind: 'agent_text_document',
    }),
  });
}

function documentSummary(point) {
  const payload = point?.payload ?? {};
  return {
    id: String(payload.document_id ?? ''),
    filename: String(payload.filename ?? ''),
    mimeType: 'text/plain',
    byteLength: Number(payload.byte_length ?? 0),
    checksumSha256: String(payload.document_checksum_sha256 ?? ''),
    uploadedAt: String(payload.uploaded_at ?? ''),
    status: 'ready',
    chunkCount: 0,
  };
}

function aggregateDocuments(points) {
  const documents = new Map();
  for (const point of points) {
    const payload = point?.payload ?? {};
    const id = String(payload.document_id ?? '');
    if (!id || payload.source_kind !== 'agent_text_document') continue;
    const document = documents.get(id) ?? documentSummary(point);
    document.chunkCount += 1;
    documents.set(id, document);
  }
  return [...documents.values()].sort((left, right) => (
    right.uploadedAt.localeCompare(left.uploadedAt) || left.filename.localeCompare(right.filename)
  ));
}

async function upload(auth, agentId, files, overrides = {}) {
  const runtime = dependencies(overrides);
  const tenantId = requireTenantId(auth?.tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  await runtime.ensureAgent(auth, resolvedAgentId);
  const batch = createAgentTextDocumentBatch({ tenantId, agentId: resolvedAgentId, files });
  const chunked = chunkAgentTextDocumentBatch(batch, {
    chunkSizeTokens: env.RAG_CHUNK_SIZE_TOKENS,
    chunkOverlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
    maximumChunkCharacters: env.RAG_EMBEDDING_MAX_CHARS,
  });
  const embedded = await runtime.embedChunks(chunked, {
    embeddingBatchSize: env.RAG_EMBEDDING_BATCH_SIZE,
  });
  const uploadedAt = runtime.now().toISOString();
  const documentById = new Map(batch.documents.map((document) => [document.id, document]));
  const points = embedded.chunks.map((chunk) => qdrantAgentDocumentPoint(
    tenantId, resolvedAgentId, documentById.get(chunk.documentId), chunk, uploadedAt,
  ));
  await runtime.ensureCollection(tenantId);
  const writtenDocumentIds = new Set();
  try {
    for (let offset = 0; offset < points.length; offset += env.QDRANT_UPSERT_BATCH_SIZE) {
      const selected = points.slice(offset, offset + env.QDRANT_UPSERT_BATCH_SIZE);
      await runtime.upsertPoints(tenantId, selected);
      selected.forEach(({ payload }) => writtenDocumentIds.add(payload.document_id));
    }
  } catch (error) {
    await Promise.allSettled([...writtenDocumentIds].map((documentId) => (
      runtime.deletePoints(tenantId, resolvedAgentId, documentId)
    )));
    throw error;
  }
  return Object.freeze({
    documents: Object.freeze(batch.documents.map((document) => Object.freeze({
      id: document.id,
      filename: document.filename,
      mimeType: document.mimeType,
      byteLength: document.byteLength,
      checksumSha256: document.checksumSha256,
      uploadedAt,
      status: 'ready',
      chunkCount: points.filter(({ payload }) => payload.document_id === document.id).length,
    }))),
  });
}

export function uploadAgentQdrantDocuments(auth, agentId, files, overrides = {}) {
  return upload(auth, agentId, files, overrides);
}

export async function listAgentQdrantDocuments(auth, agentId, overrides = {}) {
  const runtime = dependencies(overrides);
  const tenantId = requireTenantId(auth?.tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  await runtime.ensureAgent(auth, resolvedAgentId);
  const points = await runtime.scrollPoints(tenantId, resolvedAgentId);
  return Object.freeze(aggregateDocuments(points).map(Object.freeze));
}

export async function replaceAgentQdrantDocument(auth, agentId, documentId, file, overrides = {}) {
  const runtime = dependencies(overrides);
  const tenantId = requireTenantId(auth?.tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  const resolvedDocumentId = requireEntityId(documentId, 'documentId');
  await runtime.ensureAgent(auth, resolvedAgentId);
  const existing = await runtime.scrollPoints(
    tenantId, resolvedAgentId, { documentId: resolvedDocumentId },
  );
  if (!existing.length) {
    throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  }
  const replacement = await upload(auth, resolvedAgentId, [file], overrides);
  const replacementId = replacement.documents[0].id;
  try {
    await runtime.deletePoints(tenantId, resolvedAgentId, resolvedDocumentId);
  } catch (error) {
    await runtime.deletePoints(tenantId, resolvedAgentId, replacementId).catch(() => {});
    throw error;
  }
  return Object.freeze({ ...replacement.documents[0], replacedDocumentId: resolvedDocumentId });
}

export async function deleteAgentQdrantDocument(auth, agentId, documentId, overrides = {}) {
  const runtime = dependencies(overrides);
  const tenantId = requireTenantId(auth?.tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  const resolvedDocumentId = requireEntityId(documentId, 'documentId');
  await runtime.ensureAgent(auth, resolvedAgentId);
  const existing = await runtime.scrollPoints(
    tenantId, resolvedAgentId, { documentId: resolvedDocumentId },
  );
  if (!existing.length) {
    throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  }
  await runtime.deletePoints(tenantId, resolvedAgentId, resolvedDocumentId);
  return Object.freeze({ id: resolvedDocumentId, deleted: true });
}
