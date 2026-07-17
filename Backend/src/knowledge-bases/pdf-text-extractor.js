import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

function normalizeLine(value) {
  return value.normalize('NFKC').replace(/[\t\u00a0 ]+/g, ' ').trim();
}

function pageLines(items) {
  const positioned = items
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item) => ({
      text: normalizeLine(item.str),
      x: Number(item.transform?.[4] ?? 0),
      y: Number(item.transform?.[5] ?? 0),
      width: Number(item.width ?? 0),
      hasEOL: Boolean(item.hasEOL),
    }));
  positioned.sort((left, right) => Math.abs(right.y - left.y) > 2 ? right.y - left.y : left.x - right.x);

  const rows = [];
  for (const item of positioned) {
    let row = rows.find((entry) => Math.abs(entry.y - item.y) <= 2);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((left, right) => right.y - left.y);
  return rows.map((row) => {
    row.items.sort((left, right) => left.x - right.x);
    let line = '';
    let previousEnd = null;
    for (const item of row.items) {
      const needsSpace = line && (previousEnd === null || item.x - previousEnd > 1);
      line += `${needsSpace ? ' ' : ''}${item.text}`;
      previousEnd = item.x + item.width;
    }
    return normalizeLine(line);
  }).filter(Boolean);
}

export async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PDF input must be a Buffer');
  let loadingTask;
  let pdf;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      stopAtErrors: false,
    });
    pdf = await loadingTask.promise;
    if (pdf.numPages > env.KNOWLEDGE_PDF_MAX_PAGES) {
      throw new AppError(422, `PDF exceeds the ${env.KNOWLEDGE_PDF_MAX_PAGES}-page limit`, 'PDF_PAGE_LIMIT_EXCEEDED');
    }

    const pages = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const lines = pageLines(content.items);
      const text = lines.join('\n');
      characterCount += text.length;
      if (characterCount > env.KNOWLEDGE_EXTRACTED_TEXT_MAX_CHARS) {
        throw new AppError(422, 'Extracted PDF text exceeds the configured limit', 'PDF_TEXT_LIMIT_EXCEEDED');
      }
      pages.push({ pageNumber, text, lines, characterCount: text.length });
      page.cleanup();
    }

    const fullText = pages.map((page) => page.text).filter(Boolean).join('\n\n');
    if (!fullText.trim()) {
      throw new AppError(
        422,
        'No selectable text was found. Image-only PDFs require OCR, which is not enabled in this phase',
        'PDF_TEXT_EMPTY',
      );
    }
    return {
      pageCount: pdf.numPages,
      characterCount: fullText.length,
      wordCount: fullText.split(/\s+/u).filter(Boolean).length,
      pages,
      fullText,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'The PDF could not be parsed as a valid text document', 'PDF_EXTRACTION_FAILED');
  } finally {
    await pdf?.cleanup();
    await loadingTask?.destroy();
  }
}
