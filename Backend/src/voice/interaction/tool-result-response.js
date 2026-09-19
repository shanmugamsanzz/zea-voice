import { AppError } from '../../middleware/errors.js';
import { tagTemplateEngineTiming } from './template-engine-turn-timing.js';
import { shortenCompleteSpeech } from './universal-response-safety.js';
import { llmTokenBudgetForSpeech } from './template-engine-speech-budget.js';

const toolResultResponseSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['speech'],
  properties: Object.freeze({ speech: Object.freeze({ type: 'string' }) }),
});

function cleanText(value, maximum = 8_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function serializable(value, maximum = 16_000) {
  try {
    const text = JSON.stringify(value ?? null);
    return text.length <= maximum ? JSON.parse(text) : { truncated: true };
  } catch { return null; }
}

function completionValue(completion) {
  const value = completion?.outputParsed ?? completion?.output_parsed ?? completion?.parsed
    ?? completion?.answer ?? completion?.output ?? completion?.text ?? completion;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value ?? '')); } catch { return null; }
}

export async function runToolResultResponse({
  invokeStructuredLlm, agentPrompt, language, currentQuestion, toolCall, toolResult,
  maximumSpeechCharacters, cancellationSignal, onSpeechSentence,
} = {}) {
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('Tool result response requires a structured LLM invoker');
  }
  const request = tagTemplateEngineTiming(Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: 'system', content: [
        cleanText(agentPrompt, 24_000),
        'An authorized tool has completed for the current caller request.',
        'Give one natural spoken answer using the tool result. Do not call another tool.',
        'Do not claim success, availability, sending, booking, or any fact that is not present in the tool result.',
        `Caller language: ${cleanText(language, 80) || 'Follow the caller language'}`,
        '<tool_call>', JSON.stringify(serializable({
          toolName: toolCall?.name, intent: toolCall?.intent, arguments: toolCall?.arguments,
        })), '</tool_call>',
        '<tool_result>', JSON.stringify(serializable({
          success: toolResult?.success === true, output: toolResult?.output ?? null,
          error: toolResult?.error ?? null,
        })), '</tool_result>',
        'Return only the required JSON object.',
      ].join('\n') }),
      Object.freeze({ role: 'user', content: cleanText(currentQuestion, 2_000) }),
    ]),
    temperature: 0,
    maxOutputTokens: llmTokenBudgetForSpeech(maximumSpeechCharacters),
    responseFormat: Object.freeze({ type: 'json_schema', name: 'tool_result_response',
      strict: true, schema: toolResultResponseSchema }),
  }), 'tool_result_response');
  const completion = await invokeStructuredLlm(request, { cancellationSignal, onSpeechSentence });
  const parsed = completionValue(completion);
  const speech = shortenCompleteSpeech(parsed?.speech, maximumSpeechCharacters);
  if (!speech) throw new AppError(502, 'Tool result LLM returned empty speech',
    'TOOL_RESULT_LLM_EMPTY');
  return Object.freeze({ speech, speechStreaming: completion?.speechStreaming ?? null });
}
