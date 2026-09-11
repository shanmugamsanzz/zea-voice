export const QDRANT_RETRIEVAL_CONTRACT_VERSION = 1;

export const QDRANT_RETRIEVAL_LIMITS = Object.freeze({
  maximumPreviousTurns: 6,
  maximumContextCharacters: 4_000,
  maximumQuestionCharacters: 2_000,
  maximumChunkCharacters: 8_000,
  maximumChunks: 3,
});

function cleanText(value, maximum) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function requiredIdentifier(value, label) {
  const identifier = cleanText(value, 200);
  if (!identifier) throw new TypeError(`Qdrant retrieval requires ${label}`);
  return identifier;
}

function validCancellationSignal(value) {
  return value && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function';
}

function boundedPreviousContext(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const turns = [];
  let remaining = QDRANT_RETRIEVAL_LIMITS.maximumContextCharacters;
  for (const raw of value.slice(-QDRANT_RETRIEVAL_LIMITS.maximumPreviousTurns).reverse()) {
    if (remaining <= 0) break;
    const role = raw?.role === 'assistant' ? 'assistant' : raw?.role === 'user' ? 'user' : null;
    const content = cleanText(raw?.content, Math.min(1_000, remaining));
    if (!role || !content) continue;
    turns.push(Object.freeze({ role, content }));
    remaining -= content.length;
  }
  return Object.freeze(turns.reverse());
}

/**
 * The only input accepted by the new knowledge-retrieval boundary.
 * Authentication, call persistence and audio lifecycle remain outside it.
 */
export function createQdrantRetrievalRequest({
  tenantId,
  agentId,
  question,
  previousContext = [],
  cancellationSignal,
} = {}) {
  if (!validCancellationSignal(cancellationSignal)) {
    throw new TypeError('Qdrant retrieval requires an AbortSignal cancellationSignal');
  }
  const normalizedQuestion = cleanText(
    question, QDRANT_RETRIEVAL_LIMITS.maximumQuestionCharacters,
  );
  if (!normalizedQuestion) throw new TypeError('Qdrant retrieval requires current question');
  return Object.freeze({
    tenantId: requiredIdentifier(tenantId, 'tenantId'),
    agentId: requiredIdentifier(agentId, 'agentId'),
    question: normalizedQuestion,
    previousContext: boundedPreviousContext(previousContext),
    cancellationSignal,
  });
}

export function assertQdrantRetrievalActive(request) {
  if (request?.cancellationSignal?.aborted !== true) return;
  const error = new Error('Qdrant retrieval was cancelled');
  error.name = 'AbortError';
  error.code = 'QDRANT_RETRIEVAL_CANCELLED';
  throw error;
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const metadata = {};
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    const safeKey = cleanText(key, 100);
    if (!safeKey || !['string', 'number', 'boolean'].includes(typeof raw)) continue;
    metadata[safeKey] = typeof raw === 'string' ? cleanText(raw, 1_000) : raw;
  }
  return Object.freeze(metadata);
}

function verifiedChunk(request, point) {
  const payload = point?.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (cleanText(payload.tenant_id, 200) !== request.tenantId
    || cleanText(payload.agent_id, 200) !== request.agentId
    || payload.source_kind !== 'agent_text_document') return null;
  const pointId = cleanText(point.id, 240);
  const documentId = cleanText(payload.document_id, 240);
  const filename = cleanText(payload.filename, 500);
  const text = cleanText(payload.chunk_text, QDRANT_RETRIEVAL_LIMITS.maximumChunkCharacters);
  const chunkIndex = Number(payload.chunk_index);
  const score = Number(point.score);
  if (!pointId || !documentId || !filename || !text
    || !Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isFinite(score)) return null;
  return Object.freeze({
    id: pointId,
    text,
    score,
    verified: true,
    source: Object.freeze({
      documentId,
      filename,
      chunkIndex,
      metadata: safeMetadata({
        chunkId: payload.chunk_id,
        contentHash: payload.content_hash,
        uploadedAt: payload.uploaded_at,
      }),
    }),
  });
}

/**
 * Converts filtered Qdrant points into the only retrieval output exposed to
 * answer generation. Cross-tenant/agent, malformed and duplicate points are
 * discarded at the boundary.
 */
export function createQdrantRetrievalResult(request, points = []) {
  assertQdrantRetrievalActive(request);
  const byPointId = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const chunk = verifiedChunk(request, point);
    if (!chunk) continue;
    const current = byPointId.get(chunk.id);
    if (!current || chunk.score > current.score) byPointId.set(chunk.id, chunk);
  }
  const chunks = [...byPointId.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, QDRANT_RETRIEVAL_LIMITS.maximumChunks);
  return Object.freeze({ chunks: Object.freeze(chunks) });
}
