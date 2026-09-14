import { createStreamingSentenceBuffer } from '../streaming-sentence-buffer.js';

const simpleEscapes = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

function decodeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return null; }
}

export class StreamingJsonStringFieldDecoder {
  constructor(fieldName, onText) {
    this.fieldName = String(fieldName ?? '');
    this.onText = typeof onText === 'function' ? onText : () => {};
    this.depth = 0;
    this.inString = false;
    this.stringDepth = 0;
    this.stringRaw = '';
    this.stringEscaped = false;
    this.candidateKey = null;
    this.awaitingFieldValue = false;
    this.readingFieldValue = false;
    this.fieldEscaped = false;
    this.unicodeEscape = null;
    this.complete = false;
  }

  push(delta) {
    if (this.complete) return;
    for (const character of String(delta ?? '')) {
      if (this.complete) break;
      if (this.readingFieldValue) {
        this.#readFieldCharacter(character);
        continue;
      }
      if (this.inString) {
        this.#readGenericStringCharacter(character);
        continue;
      }
      if (this.awaitingFieldValue) {
        if (/\s/u.test(character)) continue;
        this.awaitingFieldValue = false;
        if (character === '"') this.readingFieldValue = true;
        continue;
      }
      if (character === '{' || character === '[') {
        this.depth += 1;
        this.candidateKey = null;
      } else if (character === '}' || character === ']') {
        this.depth = Math.max(0, this.depth - 1);
        this.candidateKey = null;
      } else if (character === '"') {
        this.inString = true;
        this.stringDepth = this.depth;
        this.stringRaw = '';
        this.stringEscaped = false;
      } else if (character === ':' && this.depth === 1 && this.candidateKey !== null) {
        this.awaitingFieldValue = this.candidateKey === this.fieldName;
        this.candidateKey = null;
      } else if (character === ',') {
        this.candidateKey = null;
      }
    }
  }

  #readGenericStringCharacter(character) {
    if (this.stringEscaped) {
      this.stringRaw += character;
      this.stringEscaped = false;
      return;
    }
    if (character === '\\') {
      this.stringRaw += character;
      this.stringEscaped = true;
      return;
    }
    if (character !== '"') {
      this.stringRaw += character;
      return;
    }
    this.inString = false;
    this.candidateKey = this.stringDepth === 1 ? decodeJsonString(this.stringRaw) : null;
    this.stringRaw = '';
  }

  #readFieldCharacter(character) {
    if (this.unicodeEscape !== null) {
      this.unicodeEscape += character;
      if (this.unicodeEscape.length < 4) return;
      if (/^[0-9a-f]{4}$/iu.test(this.unicodeEscape)) {
        this.onText(String.fromCharCode(Number.parseInt(this.unicodeEscape, 16)));
      }
      this.unicodeEscape = null;
      this.fieldEscaped = false;
      return;
    }
    if (this.fieldEscaped) {
      if (character === 'u') {
        this.unicodeEscape = '';
        return;
      }
      this.onText(simpleEscapes[character] ?? character);
      this.fieldEscaped = false;
      return;
    }
    if (character === '\\') {
      this.fieldEscaped = true;
      return;
    }
    if (character === '"') {
      this.readingFieldValue = false;
      this.complete = true;
      return;
    }
    this.onText(character);
  }
}

export function createStructuredSpeechSentenceStream(onSentence) {
  const sentenceBuffer = createStreamingSentenceBuffer();
  let sentenceCount = 0;
  const emit = (sentence, final) => {
    sentenceCount += 1;
    onSentence(sentence, Object.freeze({ sentenceNumber: sentenceCount, final }));
  };
  const decoder = new StreamingJsonStringFieldDecoder('speech', (text) => {
    for (const sentence of sentenceBuffer.push(text)) emit(sentence, false);
  });
  return Object.freeze({
    push: (delta) => {
      decoder.push(delta);
      if (decoder.complete) {
        for (const sentence of sentenceBuffer.flush()) emit(sentence, true);
      }
      return Object.freeze({ complete: decoder.complete, sentenceCount });
    },
    finish: () => {
      if (!decoder.complete) return Object.freeze({ complete: false, sentenceCount });
      for (const sentence of sentenceBuffer.flush()) emit(sentence, true);
      return Object.freeze({ complete: true, sentenceCount });
    },
    snapshot: () => Object.freeze({ complete: decoder.complete, sentenceCount }),
  });
}
