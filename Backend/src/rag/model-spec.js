export const embeddingModelSpec = Object.freeze({
  id: 'intfloat/multilingual-e5-small',
  dimensions: 384,
  distance: 'Cosine',
  queryPrefix: 'query: ',
  passagePrefix: 'passage: ',
});

export function prepareEmbeddingText(value, kind) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Embedding input must be a non-empty string');
  }
  if (kind !== 'query' && kind !== 'passage') {
    throw new TypeError('Embedding kind must be query or passage');
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  const prefix = kind === 'query' ? embeddingModelSpec.queryPrefix : embeddingModelSpec.passagePrefix;
  return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;
}
