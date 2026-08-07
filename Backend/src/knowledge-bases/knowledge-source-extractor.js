import { AppError } from '../middleware/errors.js';
import { extractPdfText } from './pdf-text-extractor.js';
import { extractUtf8Text } from './text-file-extractor.js';

export const PDF_MIME_TYPE = 'application/pdf';
export const TEXT_MIME_TYPE = 'text/plain';

export function extractKnowledgeSource(buffer, mimeType) {
  const normalizedMimeType = String(mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (normalizedMimeType === PDF_MIME_TYPE) return extractPdfText(buffer);
  if (normalizedMimeType === TEXT_MIME_TYPE) return extractUtf8Text(buffer);
  throw new AppError(422, 'Knowledge source type is not supported', 'KNOWLEDGE_SOURCE_TYPE_UNSUPPORTED');
}
