export const KNOWLEDGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

const supportedSources = {
  pdf: 'application/pdf',
  txt: 'text/plain',
} as const;

function sourceExtension(file: File) {
  return file.name.split('.').pop()?.trim().toLowerCase() ?? '';
}

export function knowledgeSourceDisplayName(file: File) {
  return file.name.replace(/\.(?:pdf|txt)$/i, '').trim();
}

export async function validateKnowledgeSourceFile(file: File): Promise<string> {
  const extension = sourceExtension(file);
  if (!(extension in supportedSources)) return 'Only PDF or UTF-8 TXT files are supported.';

  const expectedMime = supportedSources[extension as keyof typeof supportedSources];
  const actualMime = file.type.split(';', 1)[0].trim().toLowerCase();
  if (actualMime && actualMime !== expectedMime) {
    return extension === 'txt'
      ? 'The selected .txt file must have the text/plain MIME type.'
      : 'The selected .pdf file must have the application/pdf MIME type.';
  }
  if (file.size <= 0) return 'The selected knowledge file is empty.';
  if (file.size > KNOWLEDGE_SOURCE_MAX_BYTES) return 'The knowledge file must not exceed 25 MB.';

  if (extension === 'txt') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (text.includes('\u0000')) return 'This TXT file contains binary content. Upload a plain UTF-8 text file.';
      if (!text.trim()) return 'The selected TXT file does not contain usable text.';
    } catch {
      return 'This TXT file is not valid UTF-8. Save it as UTF-8 (not ANSI) and try again.';
    }
  }

  return '';
}

export function knowledgeSourceUploadError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/utf-?8|TEXT_ENCODING_INVALID/i.test(message)) {
    return 'This TXT file is not valid UTF-8. Save it as UTF-8 (not ANSI) and try again.';
  }
  if (/null characters|binary content|TEXT_BINARY_CONTENT/i.test(message)) {
    return 'This TXT file contains binary content. Upload a plain UTF-8 text file.';
  }
  return message;
}
