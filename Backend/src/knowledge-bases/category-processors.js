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
  for (const line of nonEmptyLines(extraction)) {
    const arrow = line.text.match(/^(.+?)\s*(?:->|=>)\s*(.+)$/);
    const conditional = line.text.match(/^if\s+(.+?)\s+then\s+(.+)$/i);
    const match = arrow ?? conditional;
    if (!match) continue;
    const intent = match[1].trim();
    const action = match[2].trim();
    const lowerAction = action.toLowerCase();
    const actionType = lowerAction.includes('transfer') ? 'transfer_call'
      : lowerAction.includes('hangup') || lowerAction.includes('hang up') ? 'hangup_call'
        : lowerAction.includes('schedule') ? 'schedule_callback' : 'respond';
    records.push({
      name: intent.slice(0, 200),
      intent: intent.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 160) || 'rule',
      actionType,
      actionConfig: { instruction: action },
      responseTemplate: actionType === 'respond' ? action : null,
      sourceText: line.text,
      sourcePageStart: line.pageNumber,
      sourcePageEnd: line.pageNumber,
      priority: records.length * 10 + 100,
    });
  }
  return { records, warnings: records.length ? [] : ['No workflow lines using IF/THEN or -> syntax were detected'] };
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
