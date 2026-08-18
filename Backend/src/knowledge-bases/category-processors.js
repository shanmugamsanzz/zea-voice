import { env } from '../config/env.js';
import { requireKnowledgeDocumentContract } from './knowledge-document-contract.js';
import { normalizeConfiguredToolIdentifier } from './knowledge-record-validation.js';

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
      const answer = current.answer.join(' ').trim();
      const questions = [...new Map([current.question, ...current.aliases]
        .map((value) => [value.toLocaleLowerCase(), value])).values()];
      for (const question of questions) {
        entries.push({
          question,
          answer,
          sourcePageStart: current.pageNumber,
          sourcePageEnd: current.lastPageNumber,
        });
      }
    }
    current = null;
  };
  for (const line of lines) {
    const explicitQuestion = line.text.match(/^(?:q|question)\s*[:.)-]\s*(.+)$/i);
    const explicitAliases = line.text.match(/^aliases?\s*:\s*(.+)$/i);
    const explicitAnswer = line.text.match(/^(?:a|answer)\s*[:.)-]\s*(.*)$/i);
    if (explicitAliases && current) {
      current.aliases.push(...explicitAliases[1].split('|').map((value) => value.trim()).filter(Boolean));
      current.lastPageNumber = line.pageNumber;
      continue;
    }
    const isQuestion = explicitQuestion || line.text.endsWith('?');
    if (isQuestion) {
      flush();
      current = {
        question: (explicitQuestion?.[1] ?? line.text).trim(),
        aliases: [],
        answer: [],
        pageNumber: line.pageNumber,
        lastPageNumber: line.pageNumber,
      };
      continue;
    }
    if (current) {
      current.answer.push(explicitAnswer?.[1] ?? line.text);
      current.lastPageNumber = line.pageNumber;
    }
  }
  flush();
  return { records: entries, warnings: entries.length ? [] : ['No question-and-answer pairs were detected'] };
}

function legacyPriceFromLine(text) {
  const match = text.match(/(?:₹|rs\.?|inr|\$|usd)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(inr|usd)/i);
  if (!match) return null;
  const numeric = Number((match[1] ?? match[2]).replaceAll(',', ''));
  if (!Number.isFinite(numeric)) return null;
  const token = (match[0].match(/₹|rs\.?|inr|\$|usd/i)?.[0] ?? 'INR').toLowerCase();
  const currency = token === '$' || token === 'usd' ? 'USD' : 'INR';
  const name = text.replace(match[0], '').replace(/[-–—:|]+$/u, '').trim();
  return { price: numeric, currency, name };
}

function priceFromLine(text) {
  const match = text.match(/(?:₹|rs\.?|inr|\$|usd)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(inr|usd)/iu);
  if (!match) return legacyPriceFromLine(text);
  const numeric = Number((match[1] ?? match[2]).replaceAll(',', ''));
  if (!Number.isFinite(numeric)) return null;
  const token = (match[0].match(/₹|rs\.?|inr|\$|usd/iu)?.[0] ?? 'INR').toLowerCase();
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

function catalogJsonObject(value, label, errors, lineNumber) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // The warning below gives the document author a reviewable extraction error.
  }
  errors.push(`${label} on Catalog line ${lineNumber} must be a valid JSON object`);
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
    attributes: null,
    itemName: null,
    explicitItem: false,
    price: null,
    currency: null,
  };
  const content = [];
  for (const segment of text.split('|')) {
    const directive = segment.match(
      /^\s*(item|category|aliases?|key|item[\s_-]*key|category[\s_-]*key|parent(?:[\s_-]*category)?(?:[\s_-]*key)?|description|price|currency|default[\s_-]*item(?:[\s_-]*key)?|default[\s_-]*selection|relationships?|selection[\s_-]*rules|attributes?)\s*[:=]\s*(.+?)\s*$/iu,
    );
    if (!directive) {
      content.push(segment.trim());
      continue;
    }
    const key = directive[1].toLocaleLowerCase().replace(/[\s_-]+/gu, '_');
    const value = directive[2].trim();
    if (key === 'item') {
      metadata.itemName = value.slice(0, 240);
      metadata.explicitItem = true;
    } else if (key === 'category') metadata.category = value.slice(0, 240);
    else if (key === 'alias' || key === 'aliases') metadata.aliases.push(value);
    else if (key === 'key') metadata.key = value;
    else if (key === 'item_key') metadata.itemKey = value;
    else if (key === 'category_key') metadata.categoryKey = value;
    else if (key.startsWith('parent')) metadata.parentCategoryKey = value;
    else if (key === 'description') metadata.description = value.slice(0, 50000);
    else if (key === 'price') metadata.price = value;
    else if (key === 'currency') metadata.currency = value.toUpperCase();
    else if (key.startsWith('default_item')) metadata.defaultItemKey = value;
    else if (key === 'default_selection') metadata.defaultSelection = value;
    else if (key === 'relationship' || key === 'relationships') metadata.relationships = value;
    else if (key === 'selection_rules') metadata.selectionRules = value;
    else if (key === 'attribute' || key === 'attributes') metadata.attributes = value;
  }
  return { ...metadata, content: content.filter(Boolean).join(' | ') };
}

function parseCatalog(extraction) {
  const lines = nonEmptyLines(extraction);
  const items = [];
  const warnings = [];
  const errors = [];
  const categories = new Map();
  let currentCategory = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*ITEM\s*:\s*$/iu.test(lines[index].text)) {
      errors.push(`ITEM on Catalog line ${index + 1} requires a name`);
      continue;
    }
    const headingMetadata = catalogLineMetadata(lines[index].text);
    if (headingMetadata.category && !headingMetadata.content) {
      const categoryKey = normalizeCatalogKey(headingMetadata.categoryKey ?? headingMetadata.key ?? headingMetadata.category);
      const defaultSelectionRules = catalogJsonObject(
        headingMetadata.defaultSelection ?? headingMetadata.selectionRules,
        'DEFAULT_SELECTION', errors, index + 1,
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
    const parsedPrice = priceFromLine(metadata.content);
    const explicitPrice = metadata.price === null ? null
      : Number(String(metadata.price).replaceAll(',', ''));
    if (metadata.price !== null && (!Number.isFinite(explicitPrice) || explicitPrice < 0)) {
      errors.push(`PRICE on Catalog line ${index + 1} must be a non-negative number`);
      continue;
    }
    const isStructuredItem = metadata.explicitItem || Boolean(metadata.itemKey ?? metadata.key);
    if (!isStructuredItem && !parsedPrice) continue;
    const fallbackName = index > 0 ? lines[index - 1].text : `Item ${items.length + 1}`;
    const name = String(metadata.itemName ?? parsedPrice?.name ?? metadata.content ?? fallbackName).trim();
    if (!name) {
      errors.push(`ITEM on Catalog line ${index + 1} requires a name`);
      continue;
    }
    const currency = metadata.currency ?? parsedPrice?.currency ?? null;
    const price = metadata.price !== null ? explicitPrice : parsedPrice?.price ?? null;
    if (currency && !/^[A-Z]{3}$/u.test(String(currency))) {
      errors.push(`CURRENCY on Catalog line ${index + 1} must be a three-letter code`);
      continue;
    }
    if (price !== null && !/^[A-Z]{3}$/u.test(String(currency ?? ''))) {
      errors.push(`CURRENCY on Catalog line ${index + 1} must be a three-letter code when PRICE is supplied`);
      continue;
    }
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
    const itemKey = normalizeCatalogKey(metadata.itemKey ?? metadata.key ?? name, `item-${items.length + 1}`);
    if (items.some((item) => item.itemKey === itemKey)) {
      errors.push(`Catalog line ${index + 1} duplicates item key "${itemKey}"`);
      continue;
    }
    items.push({
      itemKey,
      name,
      category: category?.name ?? null,
      categoryKey: category?.key ?? null,
      parentCategoryKey: category?.parentKey ?? null,
      categoryAliases: category?.aliases ?? [],
      categoryDescription: category?.description ?? null,
      categorySelectionRules: category?.defaultSelectionRules ?? {},
      aliases: uniqueCatalogAliases(metadata.aliases, name),
      description: metadata.description,
      relationships: catalogJsonObject(metadata.relationships, 'RELATIONSHIPS', errors, index + 1),
      selectionRules: catalogJsonObject(metadata.selectionRules, 'SELECTION_RULES', errors, index + 1),
      attributes: Object.entries(catalogJsonObject(metadata.attributes, 'ATTRIBUTES', errors, index + 1))
        .map(([attributeKey, value], attributeIndex) => ({
          key: normalizeCatalogKey(attributeKey, `attribute-${attributeIndex + 1}`),
          name: String(value?.name ?? attributeKey).trim().slice(0, 200),
          value: value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
            ? value.value : value,
          displayOrder: attributeIndex,
        })),
      price,
      currency,
      sourceText: lines[index].text,
      sourcePageStart: lines[index].pageNumber,
      sourcePageEnd: lines[index].pageNumber,
      displayOrder: items.length,
    });
  }
  return {
    catalog: { catalogType: 'document_catalog', name: 'Extracted catalog', categories: [...categories.values()] },
    records: items,
    warnings: [...warnings, ...(!items.length ? ['No valid catalog items were detected'] : [])],
    errors,
  };
}

function parseWorkflowRules(extraction) {
  const records = [];
  const warnings = [];
  const errors = [];
  let structuredRule = null;

  const normalizeIntent = (value, fallback) => value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 160) || fallback;
  const splitPhrases = (value) => [...new Map(value.split('|')
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .map((phrase) => [phrase.toLocaleLowerCase(), phrase])).values()];
  const normalizeResponseMode = (value) => {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ['exact', 'instruction', 'generated'].includes(normalized) ? normalized : null;
  };
  const normalizeConfigKey = (value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '').slice(0, 80);
  const truthy = (value) => ['true', 'yes', '1'].includes(value.trim().toLowerCase());
  const flushStructuredRule = () => {
    if (!structuredRule) return;
    const ruleNumber = records.length + 1;
    const name = structuredRule.name.trim();
    const response = structuredRule.response.join('\n').trim();
    const triggerPhrases = splitPhrases(structuredRule.match.join('|'));
    const responseMode = normalizeResponseMode(structuredRule.responseMode || 'instruction');
    const confidenceOutcome = ['ambiguous', 'none'].includes(structuredRule.confidenceOutcome)
      ? structuredRule.confidenceOutcome : '';

    if (!name) warnings.push(`Workflow rule on page ${structuredRule.sourcePageStart} has no RULE name and was skipped`);
    else if (!triggerPhrases.length && !confidenceOutcome) warnings.push(`Workflow rule "${name}" has no SITUATION or EXAMPLE text and was skipped`);
    else if (!responseMode) errors.push(`Workflow rule "${name}" has an unsupported RESPONSE_MODE and was blocked`);
    else if (!response) warnings.push(`Workflow rule "${name}" has no RESPONSE and was skipped`);
    else if (structuredRule.scenario && !structuredRule.targetCategoryKey && !structuredRule.targetItemKey) {
      warnings.push(`Scenario workflow rule "${name}" needs TARGET_CATEGORY or TARGET_ITEM and was skipped`);
    }
    else {
      const toolIdentifier = normalizeConfiguredToolIdentifier(structuredRule.action);
      if (structuredRule.action && !toolIdentifier) {
        errors.push(`Workflow rule "${name}" has an invalid configured tool identifier and was blocked`);
        structuredRule = null;
        return;
      }
      if (responseMode !== 'exact' && !toolIdentifier) {
        errors.push(`Workflow rule "${name}" requires an explicit ACTION or TOOL identifier and was blocked`);
        structuredRule = null;
        return;
      }
      const actionType = toolIdentifier ? 'configured_tool' : 'respond';
      records.push({
        name: name.slice(0, 200),
        intent: normalizeIntent(name, `rule_${ruleNumber}`),
        conditions: {
          examples: triggerPhrases,
          ...(structuredRule.scenario ? { scenarioRouting: true } : {}),
          ...(confidenceOutcome ? { confidenceOutcome } : {}),
        },
        actionType,
        actionConfig: {
          instruction: response, responseMode,
          ...(toolIdentifier ? { actionKey: toolIdentifier, toolIdentifier } : {}),
          ...(structuredRule.requiresCatalogItem ? { requiresCatalogItem: true } : {}),
          ...(structuredRule.blockedResponse ? { blockedResponse: structuredRule.blockedResponse } : {}),
          ...(structuredRule.targetCategoryKey ? { scenarioTargetCategoryKey: normalizeConfigKey(structuredRule.targetCategoryKey) } : {}),
          ...(structuredRule.targetItemKey ? { scenarioTargetItemKey: normalizeConfigKey(structuredRule.targetItemKey) } : {}),
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
    const structuredField = line.text.match(/^\s*(RULE|MATCH|SITUATION|EXAMPLE|MATCH_MODE|RESPONSE_MODE|RESPONSE|PRIORITY|ACTION|TOOL|REQUIRES_CATALOG_ITEM|BLOCKED_RESPONSE|SCENARIO|TARGET_CATEGORY|TARGET_ITEM|CONFIDENCE_OUTCOME)\s*:\s*(.*)$/i);
    if (structuredField) {
      const field = structuredField[1].toUpperCase();
      const value = structuredField[2].trim();
      if (field === 'RULE') {
        flushStructuredRule();
        structuredRule = {
          name: value, match: [], matchMode: '', responseMode: '', response: [], priority: null,
          action: '', requiresCatalogItem: false,
          blockedResponse: '', scenario: false, targetCategoryKey: '', targetItemKey: '',
          confidenceOutcome: '',
          sourceLines: [line.text], sourcePageStart: line.pageNumber, sourcePageEnd: line.pageNumber,
        };
      } else if (structuredRule) {
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
        if (['MATCH', 'SITUATION', 'EXAMPLE'].includes(field)) structuredRule.match.push(value);
        else if (field === 'MATCH_MODE') structuredRule.matchMode = value;
        else if (field === 'RESPONSE_MODE') structuredRule.responseMode = value;
        else if (field === 'RESPONSE') structuredRule.response.push(value);
        else if (field === 'ACTION' || field === 'TOOL') structuredRule.action = value;
        else if (field === 'REQUIRES_CATALOG_ITEM') structuredRule.requiresCatalogItem = truthy(value);
        else if (field === 'BLOCKED_RESPONSE') structuredRule.blockedResponse = value.slice(0, 2000);
        else if (field === 'SCENARIO') structuredRule.scenario = truthy(value);
        else if (field === 'TARGET_CATEGORY') structuredRule.targetCategoryKey = value;
        else if (field === 'TARGET_ITEM') structuredRule.targetItemKey = value;
        else if (field === 'CONFIDENCE_OUTCOME') structuredRule.confidenceOutcome = value.toLowerCase();
        else if (field === 'PRIORITY') {
          const priority = Number(value);
          if (Number.isInteger(priority) && priority >= 0) structuredRule.priority = priority;
          else warnings.push(`Workflow rule "${structuredRule.name}" has an invalid PRIORITY; automatic priority was used`);
        }
      }
      continue;
    }
    if (structuredRule) {
      if (/^\s*[A-Z][A-Z0-9_]*\s*:/u.test(line.text)) {
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
        continue;
      }
      if (structuredRule.response.length) {
        structuredRule.response.push(line.text.trim());
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
      }
      continue;
    }

    if (/^if\s+.+?\s+then\s+.+$/iu.test(line.text) || /^.+?\s*(?:->|=>)\s*.+$/u.test(line.text)) {
      errors.push(`Workflow line on page ${line.pageNumber} uses unsupported shorthand; use a RULE block with an explicit ACTION or TOOL identifier`);
    }
  }
  flushStructuredRule();
  if (!records.length && !warnings.length) {
    warnings.push('No structured RULE blocks or workflow lines using IF/THEN or -> syntax were detected');
  }
  return { records, warnings, errors };
}

function parseConversation(extraction) {
  const lines = nonEmptyLines(extraction);
  const records = [];
  const warnings = [];
  let block = null;
  const key = (value, fallback) => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '').slice(0, 160) || fallback;
  const flush = () => {
    if (!block) return;
    const response = block.response.join(' ').trim();
    if (!response) warnings.push(`Conversation stage "${block.stage}" has no RESPONSE and was skipped`);
    else {
      const content = [response, block.nextQuestion].filter(Boolean).join(' ').trim();
      records.push({
        flowKey: key(block.flow, 'main'),
        nodeKey: key(block.stage, `node_${records.length + 1}`),
        nodeType: key(block.type, 'message'),
        language: String(block.language || 'und').trim().slice(0, 20),
        sequenceOrder: records.length,
        isEntry: block.entry === true || records.length === 0,
        content,
        variables: [
          ...(block.purpose ? [{ key: 'purpose', value: block.purpose }] : []),
          ...(block.situation ? [{ key: 'situation', value: block.situation }] : []),
          ...(block.examples.length ? [{ key: 'examples', value: block.examples }] : []),
          ...(block.matchMode ? [{ key: 'matchMode', value: block.matchMode }] : []),
          ...(block.context ? [{ key: 'context', value: block.context }] : []),
          ...(block.nextQuestion ? [{ key: 'nextQuestion', value: block.nextQuestion }] : []),
        ],
        transitions: [],
        sourceText: block.sourceLines.join('\n'),
        sourcePageStart: block.sourcePageStart,
        sourcePageEnd: block.sourcePageEnd,
      });
    }
    block = null;
  };
  for (const line of lines) {
    const field = line.text.match(/^\s*(STAGE|FLOW|TYPE|LANGUAGE|ENTRY|PURPOSE|SITUATION|EXAMPLE|EXAMPLES|MATCH_MODE|CONTEXT|RESPONSE|NEXT_QUESTION)\s*:\s*(.*)$/iu);
    if (field) {
      const name = field[1].toUpperCase();
      const value = field[2].trim();
      if (name === 'STAGE') {
        flush();
        block = {
          stage: value, flow: 'main', type: 'message', language: 'und', entry: false,
          purpose: '', situation: '', examples: [], matchMode: '', context: '', response: [], nextQuestion: '', sourceLines: [line.text],
          sourcePageStart: line.pageNumber, sourcePageEnd: line.pageNumber,
        };
      } else if (block) {
        block.sourceLines.push(line.text);
        block.sourcePageEnd = line.pageNumber;
        if (name === 'FLOW') block.flow = value;
        else if (name === 'TYPE') block.type = value;
        else if (name === 'LANGUAGE') block.language = value;
        else if (name === 'ENTRY') block.entry = ['true', 'yes', '1'].includes(value.toLocaleLowerCase());
        else if (name === 'PURPOSE') block.purpose = value;
        else if (name === 'SITUATION') block.situation = value;
        else if (name === 'EXAMPLE' || name === 'EXAMPLES') {
          block.examples.push(...value.split(/\s*\|\s*/u).map((item) => item.trim()).filter(Boolean));
        }
        else if (name === 'MATCH_MODE') block.matchMode = key(value, 'any_phrase');
        else if (name === 'CONTEXT') block.context = key(value, 'any');
        else if (name === 'RESPONSE') block.response.push(value);
        else if (name === 'NEXT_QUESTION') block.nextQuestion = value;
      }
      continue;
    }
    if (block) {
      if (/^\s*[A-Z][A-Z0-9_]*\s*:/u.test(line.text)) {
        block.sourceLines.push(line.text);
        block.sourcePageEnd = line.pageNumber;
        continue;
      }
      if (block.response.length) block.response.push(line.text.trim());
      block.sourceLines.push(line.text);
      block.sourcePageEnd = line.pageNumber;
    } else {
      // Backward-compatible plain-line scripts remain valid.
      records.push({
        flowKey: 'main', nodeKey: `node_${records.length + 1}`, nodeType: 'message', language: 'und',
        sequenceOrder: records.length, isEntry: records.length === 0, content: line.text,
        variables: [], transitions: [], sourceText: line.text,
        sourcePageStart: line.pageNumber, sourcePageEnd: line.pageNumber,
      });
    }
  }
  flush();
  return { records, warnings: [...warnings, ...(!records.length ? ['No conversation lines were detected'] : [])] };
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
  requireKnowledgeDocumentContract(documentType);
  const processor = processors[documentType];
  if (!processor) throw new TypeError(`Unsupported knowledge document type: ${documentType}`);
  const result = processor(extraction);
  return {
    documentType,
    ...result,
    warnings: result.warnings ?? [],
    errors: result.errors ?? [],
    recordCount: result.records.length,
  };
}
