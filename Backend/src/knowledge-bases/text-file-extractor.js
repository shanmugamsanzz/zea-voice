import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8Text(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Text input must be a Buffer');
  return utf8Decoder.decode(buffer);
}

export function extractUtf8Text(buffer) {
  let fullText;
  try {
    fullText = decodeUtf8Text(buffer);
  } catch (error) {
    if (error instanceof TypeError && !Buffer.isBuffer(buffer)) throw error;
    throw new AppError(422, 'The text file must contain valid UTF-8 text', 'TEXT_ENCODING_INVALID');
  }

  // TextDecoder removes a leading UTF-8 BOM. Apart from that optional marker,
  // the source characters and line endings are intentionally left unchanged.
  if (fullText.includes('\u0000')) {
    throw new AppError(422, 'The text file contains binary null characters', 'TEXT_BINARY_CONTENT');
  }
  if (!fullText.trim()) {
    throw new AppError(422, 'The text file does not contain usable text', 'TEXT_CONTENT_EMPTY');
  }
  if (fullText.length > env.KNOWLEDGE_EXTRACTED_TEXT_MAX_CHARS) {
    throw new AppError(422, 'Text content exceeds the configured limit', 'TEXT_CONTENT_LIMIT_EXCEEDED');
  }

  const lines = fullText.split(/\r\n|\n|\r/u);
  return {
    pageCount: 1,
    characterCount: fullText.length,
    wordCount: fullText.split(/\s+/u).filter(Boolean).length,
    pages: [{ pageNumber: 1, text: fullText, lines, characterCount: fullText.length }],
    fullText,
  };
}
