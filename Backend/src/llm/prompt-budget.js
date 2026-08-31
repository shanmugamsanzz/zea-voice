function contentText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => String(message?.content ?? '')).join('\n');
}

export function promptCharacterCount(value) {
  return Array.from(String(value ?? '')).length;
}

export function estimatePromptTextTokens(value) {
  const content = String(value ?? '');
  const codePoints = promptCharacterCount(content);
  const lexicalUnits = content.match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)?.length ?? 0;
  // Provider tokenizers differ. This conservative provider-independent
  // estimate protects multilingual prompts without binding the runtime to a
  // particular model tokenizer.
  return Math.max(Math.ceil(codePoints / 3), Math.ceil(lexicalUnits * 1.25));
}

export function estimatePromptTokens(messages = []) {
  return estimatePromptTextTokens(contentText(messages));
}

export function promptTextFitsBudget(value, {
  maximumCharacters = Number.POSITIVE_INFINITY,
  maximumTokens = Number.POSITIVE_INFINITY,
} = {}) {
  const content = String(value ?? '');
  return promptCharacterCount(content) <= maximumCharacters
    && estimatePromptTextTokens(content) <= maximumTokens;
}
