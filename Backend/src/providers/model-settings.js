import { resolveOpenAiRequestOptions } from '../llm/openai-request-options.js';
export function normalizedModelSettings(input, current = {}) {
  const settings = { ...(current ?? {}) };
  // PATCH still merges settings; the editor explicitly identifies removed rows.
  for (const key of input.removedSettingsKeys ?? []) delete settings[key];
  Object.assign(settings, input.settings ?? {});
  // Explicit settings win over duplicate legacy top-level fields, including clears.
  if (input.voiceId !== undefined && !Object.hasOwn(input.settings ?? {}, 'voiceId')) settings.voiceId = input.voiceId;
  if (input.language !== undefined && !Object.hasOwn(input.settings ?? {}, 'language')) settings.language = input.language;
  resolveOpenAiRequestOptions(settings);
  return settings;
}
