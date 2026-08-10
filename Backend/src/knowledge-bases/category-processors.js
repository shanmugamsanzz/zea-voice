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

function parseCatalog(extraction) {
  const lines = nonEmptyLines(extraction);
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = priceFromLine(lines[index].text);
    if (!parsed) continue;
    const fallbackName = index > 0 ? lines[index - 1].text : `Item ${items.length + 1}`;
    items.push({
      name: parsed.name || fallbackName,
      price: parsed.price,
      currency: parsed.currency,
      sourceText: lines[index].text,
      sourcePageStart: lines[index].pageNumber,
      sourcePageEnd: lines[index].pageNumber,
      displayOrder: items.length,
    });
  }
  return {
    catalog: { catalogType: 'document_catalog', name: 'Extracted catalog' },
    records: items,
    warnings: items.length ? [] : ['No price-bearing catalog items were detected'],
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
    else {
      const actionType = 'respond';
      records.push({
        name: name.slice(0, 200),
        intent: normalizeIntent(name, `rule_${ruleNumber}`),
        conditions: { triggerPhrases, matchMode },
        actionType,
        actionConfig: { instruction: response, responseMode },
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
    const structuredField = line.text.match(/^\s*(RULE|MATCH|MATCH_MODE|RESPONSE_MODE|RESPONSE|PRIORITY)\s*:\s*(.*)$/i);
    if (structuredField) {
      const field = structuredField[1].toUpperCase();
      const value = structuredField[2].trim();
      if (field === 'RULE') {
        flushStructuredRule();
        structuredRule = {
          name: value, match: [], matchMode: '', responseMode: '', response: [], priority: null,
          sourceLines: [line.text], sourcePageStart: line.pageNumber, sourcePageEnd: line.pageNumber,
        };
      } else if (structuredRule) {
        structuredRule.sourceLines.push(line.text);
        structuredRule.sourcePageEnd = line.pageNumber;
        if (field === 'MATCH') structuredRule.match.push(value);
        else if (field === 'MATCH_MODE') structuredRule.matchMode = value;
        else if (field === 'RESPONSE_MODE') structuredRule.responseMode = value;
        else if (field === 'RESPONSE') structuredRule.response.push(value);
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
