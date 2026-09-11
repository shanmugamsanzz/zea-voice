import { createHash } from 'node:crypto';

function integer(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

export function resolveAgentTextChunkingConfiguration({
  chunkSizeTokens,
  chunkOverlapTokens,
  maximumChunkCharacters,
} = {}) {
  const size = integer(chunkSizeTokens, 'chunkSizeTokens', 4, 2_000);
  const overlap = integer(chunkOverlapTokens, 'chunkOverlapTokens', 0, 500);
  const characters = integer(maximumChunkCharacters, 'maximumChunkCharacters', 100, 10_000);
  if (overlap >= size) throw new TypeError('chunkOverlapTokens must be smaller than chunkSizeTokens');
  return Object.freeze({
    chunkSizeTokens: size,
    chunkOverlapTokens: overlap,
    maximumChunkCharacters: characters,
  });
}

export function normalizeAgentDocumentText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\p{Cc}/gu, (character) => (
      character === '\n' || character === '\t' ? character : ' '
    ))
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/[\t ]+/gu, ' ').replace(/ *\n */gu, '\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

function textTokens(text) {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)].map((match) => Object.freeze({
    value: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

function naturalBoundaries(text, tokens) {
  const boundaries = new Set([tokens.length]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (/[.!?\u0964\uFF01\uFF1F]/u.test(tokens[index].value)) boundaries.add(index + 1);
    const next = tokens[index + 1];
    if (next && text.slice(tokens[index].end, next.start).includes('\n\n')) boundaries.add(index + 1);
  }
  return boundaries;
}

function characterBoundedEnd(text, tokens, start, wantedEnd, maximumCharacters) {
  let end = wantedEnd;
  while (end > start + 1
    && tokens[end - 1].end - tokens[start].start > maximumCharacters) end -= 1;
  if (tokens[end - 1].end - tokens[start].start <= maximumCharacters) return end;
  // A single unusually long lexical token must not create an oversized
  // embedding input. This case is handled as a direct character fragment.
  return start + 1;
}

function selectedNaturalEnd(boundaries, start, maximumEnd, targetSize) {
  const minimumUsefulEnd = start + Math.max(1, Math.floor(targetSize / 2));
  let selected = null;
  for (const boundary of boundaries) {
    if (boundary >= minimumUsefulEnd && boundary <= maximumEnd) {
      selected = selected === null ? boundary : Math.max(selected, boundary);
    }
  }
  return selected ?? maximumEnd;
}

function contentHash(value) {
  return createHash('sha256').update(value.replace(/\s+/gu, ' ').trim()).digest('hex');
}

function chunkDocument(document, configuration) {
  const normalizedText = normalizeAgentDocumentText(document?.text);
  if (!normalizedText) throw new TypeError(`${document?.filename ?? 'Document'} contains no chunkable text`);
  const tokens = textTokens(normalizedText);
  if (!tokens.length) throw new TypeError(`${document?.filename ?? 'Document'} contains no chunkable tokens`);
  const boundaries = naturalBoundaries(normalizedText, tokens);
  const chunks = [];
  const seen = new Set();
  let start = 0;
  let previousEnd = 0;
  while (start < tokens.length) {
    const tokenLimit = Math.min(tokens.length, start + configuration.chunkSizeTokens);
    const characterLimit = characterBoundedEnd(
      normalizedText, tokens, start, tokenLimit, configuration.maximumChunkCharacters,
    );
    let end = selectedNaturalEnd(
      boundaries, start, characterLimit, configuration.chunkSizeTokens,
    );
    let text = normalizedText.slice(tokens[start].start, tokens[end - 1].end).trim();
    // Split a single unbroken token by characters when necessary.
    if (text.length > configuration.maximumChunkCharacters) {
      text = text.slice(0, configuration.maximumChunkCharacters);
      const consumedEnd = tokens[start].start + text.length;
      tokens[start] = Object.freeze({ ...tokens[start], start: consumedEnd,
        value: normalizedText.slice(consumedEnd, tokens[start].end) });
      end = start;
    }
    const hash = contentHash(text);
    if (text && !seen.has(hash)) {
      seen.add(hash);
      chunks.push(Object.freeze({
        id: `${document.id}:${chunks.length}`,
        documentId: document.id,
        filename: document.filename,
        chunkIndex: chunks.length,
        text,
        tokenCount: end > start ? end - start : 1,
        overlapTokenCount: Math.max(0, previousEnd - start),
        characterStart: tokens[start].start,
        characterEnd: tokens[start].start + text.length,
        contentHash: hash,
      }));
    }
    if (end === start) continue;
    if (end >= tokens.length) break;
    previousEnd = end;
    const next = Math.max(start + 1, end - configuration.chunkOverlapTokens);
    start = next;
  }
  return chunks;
}

/**
 * Chunks every document independently so overlap never crosses document or
 * agent boundaries. Returned positions refer to each normalized document.
 */
export function chunkAgentTextDocumentBatch(batch, options = {}) {
  if (!batch?.tenantId || !batch?.agentId || !Array.isArray(batch.documents)
    || !batch.documents.length) throw new TypeError('A valid agent text document batch is required');
  const configuration = resolveAgentTextChunkingConfiguration(options);
  const chunks = batch.documents.flatMap((document) => chunkDocument(document, configuration));
  return Object.freeze({
    tenantId: batch.tenantId,
    agentId: batch.agentId,
    configuration,
    documents: batch.documents,
    chunks: Object.freeze(chunks),
  });
}
