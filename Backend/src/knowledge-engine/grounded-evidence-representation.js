const maximumEvidenceFactCharacters = 900;
const maximumArrayEntries = 12;
const maximumObjectEntries = 24;

const internalFactKeys = new Set([
  'sourcetext', 'rawtext', 'rawcontent', 'provenance', 'tenantid', 'agentid',
  'knowledgebaseid', 'publicationrevision', 'documentid', 'documentversionid',
]);

const canonicalIdentityKeys = new Set([
  'name', 'itemkey', 'category', 'categorykey', 'question', 'heading',
  'flowkey', 'nodekey', 'intent', 'title', 'label',
]);

function clean(value, maximum = 1_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalized(value) {
  return clean(value, 240).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return new Set(normalized(value).split(/\s+/u).filter((token) => token.length > 1));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return clean(value, depth === 0 ? 700 : 400);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, maximumArrayEntries)
    .map((entry) => compactValue(entry, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, maximumObjectEntries)
    .filter(([key]) => !internalFactKeys.has(normalized(key).replace(/\s/gu, '')))
    .map(([key, entry]) => [clean(key, 100), compactValue(entry, depth + 1)]));
}

function canonicalName(source = {}) {
  const data = object(source.authoritativeData);
  const recordType = clean(source.recordType, 80).toUpperCase();
  const candidates = recordType === 'CATALOG_CATEGORY'
    ? [data.category, data.name, data.title, data.label]
    : recordType === 'CATALOG_ITEM'
      ? [data.name, data.title, data.label, data.itemKey]
      : recordType === 'FAQ'
        ? [data.question, data.title, data.heading]
        : [data.name, data.title, data.heading, data.intent, data.nodeKey, data.label];
  return clean(candidates.find((value) => clean(value, 240)), 240) || null;
}

function relevanceSignals(context = {}) {
  const need = object(context.need);
  return tokens([
    context.requestedFact,
    ...(Array.isArray(context.requestedFacts) ? context.requestedFacts : []),
    context.intentClass,
    need.customerProblem,
    need.desiredOutcome,
    ...(Array.isArray(need.missingDetails) ? need.missingDetails : []),
  ].filter(Boolean).join(' '));
}

function fieldSignals(key, value) {
  const metadata = object(value);
  return tokens([
    key, metadata.key, metadata.name, metadata.label, metadata.title, metadata.type,
  ].filter(Boolean).join(' '));
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function relevanceScore([key, value], signals, context = {}) {
  const normalizedKey = normalized(key).replace(/\s/gu, '');
  if (internalFactKeys.has(normalizedKey)) return Number.NEGATIVE_INFINITY;
  if (canonicalIdentityKeys.has(normalizedKey)) return 100;
  if (signals.size > 0 && intersects(fieldSignals(key, value), signals)) return 90;
  const need = object(context.need);
  if (need.detected === true && ['description', 'attributes', 'relationships', 'selectionrules']
    .includes(normalizedKey)) return 70;
  if (signals.size === 0) return 50;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return 20;
  return 10;
}

function compactMatchingArray(value, signals) {
  if (!Array.isArray(value) || signals.size === 0) return value;
  const matches = value.filter((entry) => entry && typeof entry === 'object'
    && intersects(fieldSignals('', entry), signals));
  return matches.length ? matches : value;
}

export function selectRelevantAuthoritativeFacts(source = {}, context = {}, options = {}) {
  const data = object(source.authoritativeData);
  const signals = relevanceSignals(context);
  const maximumCharacters = Math.max(240,
    Number(options.maximumCharacters ?? maximumEvidenceFactCharacters));
  const ranked = Object.entries(data).map(([key, value], index) => ({
    key,
    value: compactValue(compactMatchingArray(value, signals)),
    index,
    score: relevanceScore([key, value], signals, context),
  })).filter((entry) => Number.isFinite(entry.score) && entry.value !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = {};
  for (const entry of ranked) {
    const candidate = { ...selected, [entry.key]: entry.value };
    if (JSON.stringify(candidate).length <= maximumCharacters) selected[entry.key] = entry.value;
  }
  if (!Object.keys(selected).length) {
    const fallback = clean(source.content, Math.max(120, maximumCharacters - 40));
    if (fallback) selected.answer = fallback;
  }
  return Object.freeze(selected);
}

export function createCanonicalGroundedEvidence(source = {}, sourceId = null, context = {}) {
  const facts = selectRelevantAuthoritativeFacts(source, context);
  const canonicalIdentityKey = canonicalRecordIdentityKey(source);
  return Object.freeze({
    sourceId, publishedEvidenceId: source.id, recordId: source.recordId,
    recordType: source.recordType, canonicalName: canonicalName(source), facts,
    authoritativeData: facts, callerFacing: source.callerFacing === true,
    hydrationValidated: source.hydrationValidated === true,
    publicationValidated: source.publicationValidated === true,
    rank: source.rank, rrfScore: source.rrfScore,
    required: context.required === true,
    reservationReasons: Object.freeze((context.reservationReasons ?? [])
      .map((reason) => clean(reason, 80)).filter(Boolean)),
    tenantId: source.tenantId, agentId: source.agentId,
    knowledgeBaseId: source.knowledgeBaseId,
    publicationRevision: source.publicationRevision,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    documentStatus: source.documentStatus ?? null,
    documentVersionStatus: source.documentVersionStatus ?? null,
    documentVersionIsCurrent: source.documentVersionIsCurrent === true,
    canonicalIdentityKey,
    provenance: Object.freeze({
      knowledgeBaseId: source.knowledgeBaseId,
      publicationRevision: source.publicationRevision,
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
    }),
  });
}
import { canonicalRecordIdentityKey } from './canonical-record-identity.js';
