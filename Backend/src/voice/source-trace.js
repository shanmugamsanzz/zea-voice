const sourceTypeValues = [
  'welcome_configuration',
  'system_prompt',
  'pre_call_context',
  'conversation_memory',
  'knowledge',
  'tool',
  'llm',
  'silent_message',
  'call_check_configuration',
  'runtime_fallback',
  'post_call_closing',
];

export const messageSourceTypes = Object.freeze(Object.fromEntries(
  sourceTypeValues.map((value) => [value.toUpperCase(), value]),
));

const allowedSourceTypes = new Set(sourceTypeValues);
export const maximumMessageSources = 50;
const sensitiveMetadataKey = /(?:authorization|credential|password|secret|token|api[_-]?key)/iu;

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim().slice(0, 1000) || null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveMetadataKey.test(String(key)))
    .map(([key, item]) => [String(key).slice(0, 120), scalar(item)])
    .filter(([, item]) => item !== null)));
}

export function createMessageSource(type, input = {}) {
  if (!allowedSourceTypes.has(type)) throw new TypeError(`Unsupported message source type: ${type}`);
  return Object.freeze({
    type,
    id: scalar(input.id),
    label: scalar(input.label),
    metadata: metadata(input.metadata),
  });
}

function identity(source) {
  return JSON.stringify([source.type, source.id, source.label, source.metadata]);
}

export function mergeMessageSources(...collections) {
  const sources = [];
  const seen = new Set();
  for (const source of collections.flat(Infinity).filter(Boolean)) {
    const normalized = allowedSourceTypes.has(source.type)
      ? createMessageSource(source.type, source)
      : null;
    if (!normalized) continue;
    const key = identity(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(normalized);
    if (sources.length >= maximumMessageSources) break;
  }
  return Object.freeze(sources);
}

export class MessageSourceTrace {
  #sources = Object.freeze([]);

  constructor(...initialSources) {
    this.add(...initialSources);
  }

  add(...collections) {
    this.#sources = mergeMessageSources(this.#sources, ...collections);
    return this;
  }

  snapshot() {
    return this.#sources;
  }
}

export function knowledgeMessageSources(result, selectedEvidenceIds = []) {
  if (!result?.found) return Object.freeze([]);
  const selected = new Set(selectedEvidenceIds.map((value) => String(value ?? '').trim().toLocaleLowerCase()));
  const records = (result.matches?.length ? result.matches : [result.source ?? {}]).filter((record) => (
    record.callerFacing !== false && (
      !selected.size
      || selected.has(String(record.id ?? '').trim().toLocaleLowerCase())
      || selected.has(String(record.recordId ?? '').trim().toLocaleLowerCase())
    )
  ));
  const uniqueRecords = new Map();
  for (const record of records) {
    const key = [record.recordId ?? record.id, record.documentId ?? record.document_id,
      record.pageNumber ?? record.page_number, record.pageEnd ?? record.page_end].join(':');
    if (!uniqueRecords.has(key)) uniqueRecords.set(key, record);
  }
  return mergeMessageSources([...uniqueRecords.values()].map((record) => createMessageSource(messageSourceTypes.KNOWLEDGE, {
    id: record.recordId ?? record.id,
    label: record.documentDisplayName ?? record.document_display_name
      ?? record.documentName ?? record.document_name ?? 'Published knowledge',
    metadata: {
      knowledgeBaseId: record.knowledgeBaseId ?? record.knowledge_base_id,
      documentId: record.documentId ?? record.document_id,
      documentVersionId: record.documentVersionId ?? record.document_version_id,
      documentName: record.documentName ?? record.document_name,
      documentDisplayName: record.documentDisplayName ?? record.document_display_name,
      documentType: record.documentType ?? record.document_type,
      pageNumber: record.pageNumber ?? record.page_number,
      pageEnd: record.pageEnd ?? record.page_end,
      sourceSection: record.sourceSection ?? record.source_section,
      sourceLineStart: record.sourceLineStart ?? record.source_line_start,
      sourceLineEnd: record.sourceLineEnd ?? record.source_line_end,
      publicationRevision: record.publicationRevision ?? record.publication_revision,
      recordType: record.recordType ?? record.record_type,
      recordName: record.recordName ?? record.record_name
        ?? record.authoritativeData?.name ?? record.authoritative_data?.name
        ?? record.authoritativeData?.question ?? record.authoritative_data?.question
        ?? record.authoritativeData?.heading ?? record.authoritative_data?.heading
        ?? record.authoritativeData?.nodeKey ?? record.authoritative_data?.nodeKey
        ?? record.sourceSection ?? record.source_section,
      score: record.score,
      cacheHit: result.cacheHit === true,
    },
  })));
}

export function toolMessageSources(results) {
  return mergeMessageSources((results ?? []).map((result) => createMessageSource(messageSourceTypes.TOOL, {
    id: result.toolId ?? result.id,
    label: result.name,
    metadata: {
      toolCallId: result.id,
      success: result.success === true,
      durationMs: result.durationMs,
      errorCode: result.error?.code,
    },
  })));
}

export function llmMessageSource(provider, completion = {}) {
  return createMessageSource(messageSourceTypes.LLM, {
    id: provider?.modelId,
    label: provider?.modelName ?? provider?.modelKey,
    metadata: {
      providerId: provider?.providerId,
      providerName: provider?.providerName,
      modelKey: provider?.modelKey,
      providerRequestId: completion.providerRequestId,
      finishReason: completion.finishReason,
    },
  });
}
