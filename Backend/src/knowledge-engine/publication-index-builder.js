import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';

export const KNOWLEDGE_PUBLICATION_BUNDLE_VERSION = 5;

const ROUTABLE_RECORD_TYPES = new Set(['faq', 'catalog_item', 'workflow_rule', 'conversation_node']);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

export function normalizePublicationPhrase(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/gu, ' ');
}

function latinPhoneticToken(value) {
  const normalized = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/ph/gu, 'f').replace(/(?:ck|qu|q|c)/gu, 'k')
    .replace(/[z]/gu, 's').replace(/[vw]/gu, 'v').replace(/x/gu, 'ks')
    .replace(/[^a-z0-9]/gu, '');
  if (!normalized || !/[a-z]/u.test(normalized)) return normalized;
  const first = normalized[0];
  const tail = normalized.slice(1).replace(/[aeiouy]/gu, '').replace(/(.)\1+/gu, '$1');
  return `${first}${tail}`;
}

export function buildPublicationPhraseForms(values) {
  const normalized = [...new Set(values.map(normalizePublicationPhrase).filter(Boolean))];
  const compact = normalized.map((value) => value.replace(/\s+/gu, '')).filter(Boolean);
  const phonetic = normalized.map((value) => value.split(' ').map(latinPhoneticToken).filter(Boolean).join(' '))
    .filter(Boolean);
  return Object.freeze({
    normalized,
    stt: [...new Set([...normalized, ...compact])],
    phonetic: [...new Set(phonetic)],
  });
}

function metadataPhrases(record) {
  const metadata = plainObject(record.entity_metadata);
  const conditions = plainObject(metadata.conditions);
  return [
    metadata.itemKey,
    metadata.categoryKey,
    ...(stringArray(conditions.examples)),
    ...(stringArray(conditions.triggerPhrases)),
    ...(stringArray(metadata.routePhrases)),
  ];
}

function recordPhrases(record) {
  if (record.record_type === 'workflow_rule') {
    const metadata = plainObject(record.entity_metadata);
    const conditions = plainObject(metadata.conditions);
    // Workflow names, rule keys and tool identifiers are implementation
    // metadata. Only tenant-published caller phrases may activate an action.
    return [
      ...(stringArray(conditions.examples)),
      ...(stringArray(conditions.triggerPhrases)),
      ...(stringArray(record.entity_aliases)),
      ...(stringArray(metadata.routePhrases)),
    ].filter(Boolean);
  }
  const phrases = [
    record.question,
    record.entity_name,
    record.entity_category,
    ...stringArray(record.entity_aliases),
    ...stringArray(record.entity_category_aliases),
    ...metadataPhrases(record),
  ].filter(Boolean);
  // Older approved revisions may predate explicit alias fields. Their
  // authoritative evidence remains publishable and supplies a conservative
  // whole-record route phrase; it is never split into guessed aliases.
  return phrases.length ? phrases : [record.content].filter(Boolean);
}

function answerCardForRecord(record) {
  const text = String(record.answer ?? record.content ?? '').replace(/\s+/gu, ' ').trim();
  if (!text || record.record_type === 'knowledge_chunk') return null;
  const metadata = plainObject(record.entity_metadata);
  const actionType = String(metadata.actionType ?? '').toLowerCase();
  const responseMode = String(plainObject(metadata.actionConfig).responseMode ?? '').toLowerCase();
  const decision = record.record_type === 'workflow_rule' && actionType === 'configured_tool'
    ? 'TOOL' : 'DIRECT';
  return Object.freeze({
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    recordId: record.record_id,
    recordType: String(record.record_type).toUpperCase(),
    decision,
    text,
    approved: true,
    directSafe: decision === 'DIRECT' && (record.record_type !== 'workflow_rule' || responseMode === 'exact'),
  });
}

export function enrichPublicationRecord(record) {
  const phrases = buildPublicationPhraseForms(recordPhrases(record));
  return Object.freeze({
    ...record,
    publicationAliases: phrases.normalized,
    publicationSttForms: phrases.stt,
    publicationPhoneticForms: phrases.phonetic,
    approvedAnswerCard: answerCardForRecord(record),
  });
}

function validationIssue(code, message, record = null) {
  return Object.freeze({ code, message, ...(record ? { recordId: record.record_id } : {}) });
}

export function validatePublicationRecords(records) {
  const issues = [];
  const ids = new Set();
  const itemKeys = new Map();
  const categoryKeys = new Set();
  for (const record of records) {
    if (!record.record_id || ids.has(String(record.record_id))) {
      issues.push(validationIssue('DUPLICATE_RECORD_ID', 'Published records must have unique identifiers', record));
    }
    ids.add(String(record.record_id));
    if (!String(record.content ?? '').trim()) {
      issues.push(validationIssue('EMPTY_EVIDENCE', 'Published evidence must not be empty', record));
    }
    const metadata = plainObject(record.entity_metadata);
    if (record.record_type === 'catalog_item') {
      const itemKey = normalizePublicationPhrase(metadata.itemKey).replace(/\s+/gu, '-');
      const categoryKey = normalizePublicationPhrase(metadata.categoryKey).replace(/\s+/gu, '-');
      if (itemKey) {
        if (itemKeys.has(itemKey)) {
          issues.push(validationIssue('DUPLICATE_CATALOG_ITEM_KEY',
            `Catalog item key ${itemKey} is published by more than one record`, record));
        }
        itemKeys.set(itemKey, record.record_id);
      }
      if (categoryKey) categoryKeys.add(categoryKey);
    }
  }
  for (const record of records.filter((value) => value.record_type === 'workflow_rule')) {
    const metadata = plainObject(record.entity_metadata);
    const config = plainObject(metadata.actionConfig);
    const targetItem = normalizePublicationPhrase(config.scenarioTargetItemKey).replace(/\s+/gu, '-');
    const targetCategory = normalizePublicationPhrase(config.scenarioTargetCategoryKey).replace(/\s+/gu, '-');
    if (targetItem && !itemKeys.has(targetItem)) {
      issues.push(validationIssue('UNKNOWN_WORKFLOW_ITEM', `Workflow target item ${targetItem} is not published`, record));
    }
    if (targetCategory && !categoryKeys.has(targetCategory)) {
      issues.push(validationIssue('UNKNOWN_WORKFLOW_CATEGORY',
        `Workflow target category ${targetCategory} is not published`, record));
    }
    if (config.requiresCatalogItem === true && itemKeys.size === 0) {
      issues.push(validationIssue('WORKFLOW_REQUIRES_CATALOG',
        'Workflow requires a Catalog item but no Catalog item is published', record));
    }
    if (String(metadata.actionType ?? '').toLowerCase() === 'configured_tool'
      && !String(config.toolIdentifier ?? config.actionKey ?? '').trim()) {
      issues.push(validationIssue('WORKFLOW_TOOL_MISSING',
        'Configured-tool workflow has no published tool identifier', record));
    }
  }
  for (const record of records.filter((value) => ROUTABLE_RECORD_TYPES.has(value.record_type))) {
    if (!record.publicationAliases?.length) {
      issues.push(validationIssue('ROUTE_WITHOUT_TRIGGER', 'Routable published evidence has no trigger phrase', record));
    }
    if (!record.approvedAnswerCard) {
      issues.push(validationIssue('ROUTE_WITHOUT_ANSWER', 'Routable published evidence has no approved answer', record));
    }
  }
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

function candidate(record) {
  const metadata = plainObject(record.entity_metadata);
  return Object.freeze({
    recordId: record.record_id,
    recordType: String(record.record_type).toUpperCase(),
    entityType: record.record_type === 'catalog_item' ? 'ITEM' : 'ROUTE',
    label: record.entity_name ?? record.question ?? null,
    itemKey: metadata.itemKey ?? null,
    categoryKey: metadata.categoryKey ?? null,
    answerCardId: record.approvedAnswerCard?.recordId ?? null,
  });
}

function invertedIndex(records, field) {
  const index = {};
  for (const record of records) {
    if (!ROUTABLE_RECORD_TYPES.has(record.record_type)) continue;
    for (const phrase of record[field] ?? []) {
      index[phrase] ??= [];
      if (!index[phrase].some((entry) => entry.recordId === record.record_id)) index[phrase].push(candidate(record));
    }
  }
  return index;
}

function namespacedRouteIndexes(records) {
  const workflow = records.filter((record) => record.record_type === 'workflow_rule');
  const callControl = workflow.filter((record) => {
    const metadata = plainObject(record.entity_metadata);
    const conditions = plainObject(metadata.conditions);
    return String(conditions.intentClass ?? metadata.intentClass ?? '').normalize('NFKC')
      .trim().toUpperCase().replace(/[\s-]+/gu, '_') === 'CALL_CONTROL';
  });
  const namespaces = {
    faq: records.filter((record) => record.record_type === 'faq'),
    conversation: records.filter((record) => record.record_type === 'conversation_node'),
    workflow,
    callControl,
    // General Knowledge is intentionally discovered through BM25/Qdrant unless
    // a future document contract publishes explicit route phrases. Raw chunks
    // must never become exact-match routes merely because they contain a word.
    general: [],
  };
  return Object.freeze(Object.fromEntries(Object.entries(namespaces).map(([name, entries]) => [
    name,
    Object.freeze({
      exact: invertedIndex(entries, 'publicationAliases'),
      stt: invertedIndex(entries, 'publicationSttForms'),
      phonetic: invertedIndex(entries, 'publicationPhoneticForms'),
    }),
  ])));
}

function categoryCandidates(records) {
  const categories = new Map();
  for (const record of records.filter((entry) => entry.record_type === 'catalog_item')) {
    const metadata = plainObject(record.entity_metadata);
    const key = normalizePublicationPhrase(metadata.categoryKey ?? record.entity_category)
      .replace(/\s+/gu, '-');
    if (!key) continue;
    const current = categories.get(key) ?? {
      key,
      label: String(record.entity_category ?? metadata.categoryKey ?? '').trim(),
      description: String(metadata.categoryDescription ?? '').trim() || null,
      phrases: [],
      recordIds: [],
      children: [],
    };
    current.phrases.push(
      record.entity_category,
      metadata.categoryKey,
      ...stringArray(record.entity_category_aliases),
    );
    current.recordIds.push(record.record_id);
    current.children.push(Object.freeze({
      recordId: record.record_id,
      itemKey: metadata.itemKey ?? null,
      label: String(record.entity_name ?? '').trim() || null,
    }));
    categories.set(key, current);
  }
  return [...categories.values()].map((category) => ({
    ...category,
    phrases: buildPublicationPhraseForms(category.phrases.filter(Boolean)),
    recordIds: [...new Set(category.recordIds)],
  }));
}

function categoryInvertedIndex(categories, field) {
  const index = {};
  for (const category of categories) {
    for (const phrase of category.phrases[field] ?? []) {
      index[phrase] ??= [];
      if (!index[phrase].some((entry) => entry.categoryKey === category.key)) {
        index[phrase].push(Object.freeze({
          recordId: category.recordIds[0],
          evidenceRecordIds: Object.freeze([...category.recordIds]),
          recordType: 'CATALOG_CATEGORY',
          entityType: 'CATEGORY',
          label: category.label,
          itemKey: null,
          categoryKey: category.key,
          categoryDescription: category.description,
          children: Object.freeze([...category.children]),
          answerCardId: null,
        }));
      }
    }
  }
  return index;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildPublicationIndexes(job, sourceRecords) {
  const records = sourceRecords.map(enrichPublicationRecord);
  const validation = validatePublicationRecords(records);
  if (!validation.valid) {
    throw new AppError(409, 'Published documents failed schema or cross-document validation',
      'KNOWLEDGE_PUBLICATION_VALIDATION_FAILED', { issues: validation.issues });
  }
  const answerCards = records.map((record) => record.approvedAnswerCard).filter(Boolean);
  const categories = categoryCandidates(records);
  const entityIndex = Object.freeze({
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    exact: invertedIndex(records.filter((record) => record.record_type === 'catalog_item'), 'publicationAliases'),
    stt: invertedIndex(records.filter((record) => record.record_type === 'catalog_item'), 'publicationSttForms'),
    phonetic: invertedIndex(records.filter((record) => record.record_type === 'catalog_item'), 'publicationPhoneticForms'),
    categories: Object.freeze({
      exact: categoryInvertedIndex(categories, 'normalized'),
      stt: categoryInvertedIndex(categories, 'stt'),
      phonetic: categoryInvertedIndex(categories, 'phonetic'),
    }),
  });
  const routeIndex = Object.freeze({
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    exact: invertedIndex(records, 'publicationAliases'),
    stt: invertedIndex(records, 'publicationSttForms'),
    phonetic: invertedIndex(records, 'publicationPhoneticForms'),
    namespaces: namespacedRouteIndexes(records),
  });
  const identity = {
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    tenantId: String(job.tenant_id).toLowerCase(),
    knowledgeBaseId: String(job.knowledge_base_id).toLowerCase(),
    publicationRevision: job.targetRevision,
  };
  const manifest = Object.freeze({
    ...identity,
    recordCount: records.length,
    answerCardCount: answerCards.length,
    entityRouteCount: Object.keys(entityIndex.exact).length,
    routeCount: Object.keys(routeIndex.exact).length,
    documentVersionIds: [...new Set(records.map((record) => String(record.document_version_id).toLowerCase()))].sort(),
    contentHash: stableHash(records.map((record) => ({
      id: record.record_id,
      type: record.record_type,
      content: record.content,
      aliases: record.publicationAliases,
      answer: record.approvedAnswerCard?.text ?? null,
    }))),
  });
  return Object.freeze({
    ...identity,
    records: Object.freeze(records),
    answerCards: Object.freeze(answerCards),
    entityIndex,
    routeIndex,
    manifest,
    validation,
  });
}
