import { env } from '../config/env.js';

function nonEmptyLines(extraction) {
  return extraction.pages.flatMap((page) => page.lines.map((text) => ({ pageNumber: page.pageNumber, text })))
    .filter((line) => line.text.trim());
}

function parseFaq(extraction) {
  const lines = nonEmptyLines(extraction);
  const entries = [];
  let current;
  const flush = () => {
    if (current?.question && current.answer.length) {
      entries.push({
        question: current.question,
        answer: current.answer.join(' ').trim(),
        sourcePageStart: current.pageNumber,
        sourcePageEnd: current.lastPageNumber,
      });
    }
    current = null;
  };
  for (const line of lines) {
    const explicitQuestion = line.text.match(/^(?:q|question)\s*[:.)-]\s*(.+)$/i);
    const isQuestion = explicitQuestion || line.text.endsWith('?');
    if (isQuestion) {
      flush();
      current = {
        question: (explicitQuestion?.[1] ?? line.text).trim(),
        answer: [],
        pageNumber: line.pageNumber,
        lastPageNumber: line.pageNumber,
      };
      continue;
    }
    if (current) {
      current.answer.push(line.text.replace(/^(?:a|answer)\s*[:.)-]\s*/i, ''));
      current.lastPageNumber = line.pageNumber;
    }
  }
  flush();
  return { records: entries, warnings: entries.length ? [] : ['No question-and-answer pairs were detected'] };
}

function priceFromLine(text) {
  const match = text.match(/(?:₹|rs\.?|inr|\$|usd)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(inr|usd)/i);
  if (!match) return null;
  const numeric = Number((match[1] ?? match[2]).replaceAll(',', ''));
  if (!Number.isFinite(numeric)) return null;
  const token = (match[0].match(/₹|rs\.?|inr|\$|usd/i)?.[0] ?? 'INR').toLowerCase();
  const currency = token === '$' || token === 'usd' ? 'USD' : 'INR';
  const name = text.replace(match[0], '').replace(/[-–—:|]+$/u, '').trim();
  return { price: numeric, currency, name };
}

function uniqueCatalogAliases(values, canonicalName) {
  const canonical = canonicalName.normalize('NFKC').toLocaleLowerCase();
  return [...new Map(values.flatMap((value) => String(value).split(','))
    .map((value) => value.normalize('NFKC').trim())
    .filter((value) => value && value.length <= 240 && value.toLocaleLowerCase() !== canonical)
    .map((value) => [value.toLocaleLowerCase(), value])).values()].slice(0, 50);
}

function normalizeCatalogKey(value, fallback = 'catalog-entity') {
  const normalized = String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 160);
  return normalized || fallback;
}

function catalogJsonObject(value, label, warnings, lineNumber) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // The warning below gives the document author a reviewable extraction error.
  }
  warnings.push(`${label} on Catalog line ${lineNumber} must be a valid JSON object`);
  return {};
}

function catalogLineMetadata(text) {
  const metadata = {
    category: null,
    aliases: [],
    key: null,
    itemKey: null,
    categoryKey: null,
    parentCategoryKey: null,
    description: null,
    defaultItemKey: null,
    defaultSelection: null,
    relationships: null,
    selectionRules: null,
  };
  const content = [];
  for (const segment of text.split('|')) {
    const directive = segment.match(
      /^\s*(category|aliases?|key|item[\s_-]*key|category[\s_-]*key|parent(?:[\s_-]*category)?(?:[\s_-]*key)?|description|default[\s_-]*item(?:[\s_-]*key)?|default[\s_-]*selection|relationships?|selection[\s_-]*rules)\s*[:=]\s*(.+?)\s*$/iu,
    );
    if (!directive) {
      content.push(segment.trim());
      continue;
    }
    const key = directive[1].toLocaleLowerCase().replace(/[\s_-]+/gu, '_');
    const value = directive[2].trim();
    if (key === 'category') metadata.category = value.slice(0, 240);
    else if (key === 'alias' || key === 'aliases') metadata.aliases.push(value);
    else if (key === 'key') metadata.key = value;
    else if (key === 'item_key') metadata.itemKey = value;
    else if (key === 'category_key') metadata.categoryKey = value;
    else if (key.startsWith('parent')) metadata.parentCategoryKey = value;
    else if (key === 'description') metadata.description = value.slice(0, 50000);
    else if (key.startsWith('default_item')) metadata.defaultItemKey = value;
    else if (key === 'default_selection') metadata.defaultSelection = value;
    else if (key === 'relationship' || key === 'relationships') metadata.relationships = value;
    else if (key === 'selection_rules') metadata.selectionRules = value;
  }
  return { ...metadata, content: content.filter(Boolean).join(' | ') };
}

function parseCatalog(extraction) {
  const lines = nonEmptyLines(extraction);
  const items = [];
  const warnings = [];
  const categories = new Map();
  let currentCategory = null;
  for (let index = 0; index < lines.length; index += 1) {
    const headingMetadata = catalogLineMetadata(lines[index].text);
    if (headingMetadata.category && !headingMetadata.content) {
      const categoryKey = normalizeCatalogKey(headingMetadata.categoryKey ?? headingMetadata.key ?? headingMetadata.category);
      const defaultSelectionRules = catalogJsonObject(
        headingMetadata.defaultSelection ?? headingMetadata.selectionRules,
        'DEFAULT_SELECTION', warnings, index + 1,
      );
      if (headingMetadata.defaultItemKey) {
        defaultSelectionRules.defaultItemKey = normalizeCatalogKey(headingMetadata.defaultItemKey);
      }
      currentCategory = {
        key: categoryKey,
        name: headingMetadata.category,
        parentKey: headingMetadata.parentCategoryKey
          ? normalizeCatalogKey(headingMetadata.parentCategoryKey) : null,
        aliases: uniqueCatalogAliases(headingMetadata.aliases, headingMetadata.category),
        description: headingMetadata.description,
        defaultSelectionRules,
      };
      categories.set(categoryKey, currentCategory);
      continue;
    }
    const metadata = catalogLineMetadata(lines[index].text);
    const parsed = priceFromLine(metadata.content);
    if (!parsed) continue;
    const fallbackName = index > 0 ? lines[index - 1].text : `Item ${items.length + 1}`;
    const name = parsed.name || fallbackName;
    const explicitCategory = metadata.category ? {
      key: normalizeCatalogKey(metadata.categoryKey ?? metadata.category),
      name: metadata.category,
      parentKey: metadata.parentCategoryKey ? normalizeCatalogKey(metadata.parentCategoryKey) : null,
      aliases: [],
      description: null,
      defaultSelectionRules: {},
    } : null;
    const category = explicitCategory ?? currentCategory;
    if (explicitCategory && !categories.has(explicitCategory.key)) categories.set(explicitCategory.key, explicitCategory);
    items.push({
      itemKey: normalizeCatalogKey(metadata.itemKey ?? metadata.key ?? name, `item-${items.length + 1}`),
      name,
      category: category?.name ?? null,
      categoryKey: category?.key ?? null,
      parentCategoryKey: category?.parentKey ?? null,
      categoryAliases: category?.aliases ?? [],
      categoryDescription: category?.description ?? null,
      categorySelectionRules: category?.defaultSelectionRules ?? {},
      aliases: uniqueCatalogAliases(metadata.aliases, name),
      description: metadata.description,
      relationships: catalogJsonObject(metadata.relationships, 'RELATIONSHIPS', warnings, index + 1),
      selectionRules: catalogJsonObject(metadata.selectionRules, 'SELECTION_RULES', warnings, index + 1),
      price: parsed.price,
      currency: parsed.currency,
      sourceText: lines[index].text,
      sourcePageStart: lines[index].pageNumber,
      sourcePageEnd: lines[index].pageNumber,
      displayOrder: items.length,
    });
  }
  return {
    catalog: { catalogType: 'document_catalog', name: 'Extracted catalog', categories: [...categories.values()] },
    records: items,
    warnings: [...warnings, ...(!items.length ? ['No price-bearing catalog items were detected'] : [])],
  };
}

function parseWorkflowRules(extraction) {
  const records = [];
  const warnings = [];
  let structuredRule = null;

  const normalizeIntent = (value, fallback) => value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 160) || fallback;
  const splitPhrases = (value) => [...new Map(value.split('|')
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .map((phrase) => [phrase.toLocaleLowerCase(), phrase])).values()];
  const normalizeMatchMode = (value) => {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ['any_phrase', 'contains', 'exact'].includes(normalized) ? normalized : null;
  };
  const normalizeResponseMode = (value) => {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ['exact', 'instruction', 'generated'].includes(normalized) ? normalized : null;
  };
  const normalizeStageKey = (value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '').slice(0, 80);
  const truthy = (value) => ['true', 'yes', '1'].includes(value.trim().toLowerCase());
  const inferActionType = (action) => {
    const lowerAction = action.toLowerCase();
    return lowerAction.includes('transfer') ? 'transfer_call'
      : lowerAction.includes('hangup') || lowerAction.includes('hang up') ? 'hangup_call'
        : lowerAction.includes('schedule') ? 'schedule_callback' : 'respond';
  };
  const flushStructuredRule = () => {
    if (!structuredRule) return;
    const ruleNumber = records.length + 1;
    const name = structuredRule.name.trim();
    const response = structuredRule.response.join('\n').trim();
    const triggerPhrases = splitPhrases(structuredRule.match.join('|'));
    const matchMode = normalizeMatchMode(structuredRule.matchMode || 'any_phrase');
    const responseMode = normalizeResponseMode(structuredRule.responseMode || 'instruction');

    if (!name) warnings.push(`Workflow rule on page ${structuredRule.sourcePageStart} has no RULE name and was skipped`);
    else if (!triggerPhrases.length) warnings.push(`Workflow rule "${name}" has no MATCH phrases and was skipped`);
    else if (!matchMode) warnings.push(`Workflow rule "${name}" has an unsupported MATCH_MODE and was skipped`);
    else if (!responseMode) warnings.push(`Workflow rule "${name}" has an unsupported RESPONSE_MODE and was skipped`);
    else if (!response) warnings.push(`Workflow rule "${name}" has no RESPONSE and was skipped`);
    else if (structuredRule.scenario && !structuredRule.targetCategoryKey && !structuredRule.targetItemKey) {
      warnings.push(`Scenario workflow rule "${name}" needs TARGET_CATEGORY or TARGET_ITEM and was skipped`);
    }
    else {
      const actionType = 'respond';
      const fromStages = splitPhrases(structuredRule.fromStage.join('|')).map(normalizeStageKey).filter(Boolean);
      const nextStage = normalizeStageKey(structuredRule.nextStage);
      const actionKey = normalizeStageKey(structuredRule.action);
      records.push({
        name: name.slice(0, 200),
        intent: normalizeIntent(name, `rule_${ruleNumber}`),
        conditions: {
          triggerPhrases, matchMode, ...(fromStages.length ? { fromStages } : {}),
          ...(structuredRule.scenario ? { scenarioRouting: true } : {}),
        },
        actionType,
        actionConfig: {
          instruction: response, responseMode,
          ...(nextStage ? { nextStage } : {}),
          ...(actionKey ? { actionKey } : {}),
          ...(structuredRule.requiresCatalogItem ? { requiresCatalogItem: true } : {}),
          ...(structuredRule.blockedResponse ? { blockedResponse: structuredRule.blockedResponse } : {}),
          ...(structuredRule.targetCategoryKey ? { scenarioTargetCategoryKey: normalizeStageKey(structuredRule.targetCategoryKey) } : {}),
          ...(structuredRule.targetItemKey ? { scenarioTargetItemKey: normalizeStageKey(structuredRule.targetItemKey) } : {}),
        },
        responseTemplate: response,
        sourceText: structuredRule.sourceLines.join('\n'),
        sourcePageStart: structuredRule.sourcePageStart,
        sourcePageEnd: structuredRule.sourcePageEnd,
        priority: structuredRule.priority ?? (records.length * 10 + 100),
      });
    }
    structuredRule = null;
  };

  for (const line of nonEmptyLines(extraction)) {
    const structuredField = line.text.match(/^\s*(RULE|MATCH|MATCH_MODE|RESPONSE_MODE|RESPONSE|PRIORITY|FROM_STAGE|NEXT_STAGE|ACTION|REQUIRES_CATALOG_ITEM|BLOCKED_RESPONSE|SCENARIO|TARGET_CATEGORY|TARGET_ITEM)\s*:\s*(.*)$/i);
    if (structuredField) {
      const field = structuredField[1].toUpperCase();
      const value = structuredField[2].trim();
      if (field === 'RULE') {
        flushStructuredRule();
        structuredRule = {
          name: value, match: [], matchMode: '', responseMode: '', response: [], priority: null,
          fromStage: [], nextStage: '', action: '', requiresCatalogItem: false,
          blockedResponse: '', scenario: false, targetCategoryKey: '', targetItemKey: '',
          sourceLines: [line.text], sourcePageStart: line.pageNumber, sourcePageEnd: line.pageNumber,
        };
      } else if (structuredRule) {
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
        if (field === 'MATCH') structuredRule.match.push(value);
        else if (field === 'MATCH_MODE') structuredRule.matchMode = value;
        else if (field === 'RESPONSE_MODE') structuredRule.responseMode = value;
        else if (field === 'RESPONSE') structuredRule.response.push(value);
        else if (field === 'FROM_STAGE') structuredRule.fromStage.push(value);
        else if (field === 'NEXT_STAGE') structuredRule.nextStage = value;
        else if (field === 'ACTION') structuredRule.action = value;
        else if (field === 'REQUIRES_CATALOG_ITEM') structuredRule.requiresCatalogItem = truthy(value);
        else if (field === 'BLOCKED_RESPONSE') structuredRule.blockedResponse = value.slice(0, 2000);
        else if (field === 'SCENARIO') structuredRule.scenario = truthy(value);
        else if (field === 'TARGET_CATEGORY') structuredRule.targetCategoryKey = value;
        else if (field === 'TARGET_ITEM') structuredRule.targetItemKey = value;
        else if (field === 'PRIORITY') {
          const priority = Number(value);
          if (Number.isInteger(priority) && priority >= 0) structuredRule.priority = priority;
          else warnings.push(`Workflow rule "${structuredRule.name}" has an invalid PRIORITY; automatic priority was used`);
        }
      }
      continue;
    }
    if (structuredRule) {
      if (structuredRule.response.length) {
        structuredRule.response.push(line.text.trim());
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
      }
      continue;
    }

    const arrow = line.text.match(/^(.+?)\s*(?:->|=>)\s*(.+)$/);
    const conditional = line.text.match(/^if\s+(.+?)\s+then\s+(.+)$/i);
    const match = arrow ?? conditional;
    if (!match) continue;
    const intent = match[1].trim();
    const action = match[2].trim();
    const actionType = inferActionType(action);
    records.push({
      name: intent.slice(0, 200),
      intent: normalizeIntent(intent, `rule_${records.length + 1}`),
      conditions: {},
      actionType,
      actionConfig: { instruction: action },
      responseTemplate: actionType === 'respond' ? action : null,
      sourceText: line.text,
      sourcePageStart: line.pageNumber,
      sourcePageEnd: line.pageNumber,
      priority: records.length * 10 + 100,
    });
  }
  flushStructuredRule();
  if (!records.length && !warnings.length) {
    warnings.push('No structured RULE blocks or workflow lines using IF/THEN or -> syntax were detected');
  }
  return { records, warnings };
}

function parseConversation(extraction) {
  const records = nonEmptyLines(extraction).map((line, index) => ({
    flowKey: 'main',
    nodeKey: `node_${index + 1}`,
    nodeType: 'message',
    language: 'en',
    sequenceOrder: index,
    isEntry: index === 0,
    content: line.text,
    sourceText: line.text,
    sourcePageStart: line.pageNumber,
    sourcePageEnd: line.pageNumber,
  }));
  return { records, warnings: records.length ? [] : ['No conversation lines were detected'] };
}

function parseGeneralKnowledge(extraction) {
  const words = extraction.fullText.split(/\s+/u).filter(Boolean);
  const size = env.RAG_CHUNK_SIZE_TOKENS;
  const overlap = env.RAG_CHUNK_OVERLAP_TOKENS;
  const records = [];
  for (let start = 0; start < words.length; start += size - overlap) {
    const chunkWords = words.slice(start, start + size);
    if (!chunkWords.length) break;
    records.push({ chunkIndex: records.length, content: chunkWords.join(' '), tokenCount: chunkWords.length });
    if (start + size >= words.length) break;
  }
  return { records, warnings: [] };
}

const processors = {
  faq: parseFaq,
  catalog: parseCatalog,
  workflow_rules: parseWorkflowRules,
  conversation_script: parseConversation,
  general_knowledge: parseGeneralKnowledge,
};

export function processExtractedCategory(documentType, extraction) {
  const processor = processors[documentType];
  if (!processor) throw new TypeError(`Unsupported knowledge document type: ${documentType}`);
  const result = processor(extraction);
  return { documentType, ...result, recordCount: result.records.length };
}
