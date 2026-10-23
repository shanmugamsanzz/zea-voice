import { AppError } from '../middleware/errors.js';
const efforts = new Set(['none','minimal','low','medium','high','xhigh','max']);
function invalid(field) {
  throw new AppError(400, 'Invalid OpenAI-compatible model request setting', 'LLM_MODEL_REQUEST_OPTIONS_INVALID', { field });
}
export function resolveOpenAiRequestOptions(settings = {}) {
  // A legacy numeric completion-budget row selects the modern API field only.
  // The actual value always comes from the current runtime speech budget.
  const tokenParameter = settings.outputTokenParameter ?? (Object.hasOwn(settings,'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens');
  if (!['max_tokens','max_completion_tokens'].includes(tokenParameter)) invalid('outputTokenParameter');
  const raw = settings.supportsTemperature ?? true;
  const supportsTemperature = typeof raw === 'boolean' ? raw
    : ['true','yes'].includes(String(raw).toLowerCase()) ? true
      : ['false','no'].includes(String(raw).toLowerCase()) ? false : null;
  if (supportsTemperature === null) invalid('supportsTemperature');
  const effort = settings.reasoning_effort;
  if (effort !== undefined && (typeof effort !== 'string' || !efforts.has(effort))) invalid('reasoning_effort');
  return Object.freeze({ tokenParameter, supportsTemperature, ...(effort !== undefined ? {reasoningEffort:effort}: {}) });
}
export function openAiGenerationParameters(options = {}, { temperature, maxOutputTokens } = {}) {
  const tokenParameter = options.tokenParameter ?? 'max_tokens';
  // Do not accept arbitrary request-body keys from the settings editor.
  if (!['max_tokens','max_completion_tokens'].includes(tokenParameter)) invalid('outputTokenParameter');
  return {
    ...(options.supportsTemperature !== false && temperature !== undefined ? {temperature}:{}),
    [tokenParameter]: maxOutputTokens,
    ...(options.reasoningEffort !== undefined ? {reasoning_effort: options.reasoningEffort}:{}),
  };
}
