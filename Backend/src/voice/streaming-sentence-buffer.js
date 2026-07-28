const sentencePunctuation = new Set(['.', '!', '?', '…', '।', '。', '！', '？']);
const closingCharacters = new Set(['"', "'", '’', '”', ')', ']', '}']);
const abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'e.g', 'i.e']);

function wordBefore(text, index) {
  let start = index - 1;
  while (start >= 0 && /[\p{L}.]/u.test(text[start])) start -= 1;
  return text.slice(start + 1, index).toLowerCase();
}

function isSentenceBoundary(text, punctuationIndex) {
  const punctuation = text[punctuationIndex];
  if (punctuation === '.') {
    const previous = text[punctuationIndex - 1];
    const next = text[punctuationIndex + 1];
    if (/\d/.test(previous ?? '') && next === undefined) return false;
    if (/\d/.test(previous ?? '') && /\d/.test(next ?? '')) return false;
    if (abbreviations.has(wordBefore(text, punctuationIndex))) return false;
  }
  let end = punctuationIndex + 1;
  while (end < text.length && closingCharacters.has(text[end])) end += 1;
  return end === text.length || /\s/u.test(text[end]);
}

function extractCompleteSentences(value) {
  const sentences = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!sentencePunctuation.has(value[index]) || !isSentenceBoundary(value, index)) continue;
    let end = index + 1;
    while (end < value.length && closingCharacters.has(value[end])) end += 1;
    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    while (end < value.length && /\s/u.test(value[end])) end += 1;
    start = end;
    index = end - 1;
  }
  return { sentences, remainder: value.slice(start) };
}

export class StreamingSentenceBuffer {
  constructor() { this.buffer = ''; }

  push(delta) {
    this.buffer += String(delta ?? '');
    const result = extractCompleteSentences(this.buffer);
    this.buffer = result.remainder;
    return result.sentences;
  }

  flush() {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder ? [remainder] : [];
  }

  clear() { this.buffer = ''; }
}

export function createStreamingSentenceBuffer() {
  return new StreamingSentenceBuffer();
}
