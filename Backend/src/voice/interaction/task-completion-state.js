import { resolveTaskCompletionConfiguration } from './completion-config.js';
import { extractSchemaFieldValue } from './schema-field-value-extractor.js';

const templatePattern = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/giu;

function compact(value, maximum = 160) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, maximum).join('');
}

function safeContextValue(value) {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  return compact(value);
}

function configuredSchemas(fieldSchemas = []) {
  return new Map((Array.isArray(fieldSchemas) ? fieldSchemas : [])
    .filter((field) => field?.key).map((field) => [String(field.key), field]));
}

function stateMetadata(state = {}) {
  return {
    fieldSchemas: Array.isArray(state.fieldSchemas) ? state.fieldSchemas : [],
    resolvedEntities: Array.isArray(state.resolvedEntities) ? state.resolvedEntities : [],
    canonicalEntity: state.canonicalEntity ?? null,
  };
}

function canonicalEntity(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recordId = compact(value.recordId ?? value.id, 160);
  const name = compact(value.name, 240);
  if (!recordId || !name) return null;
  return Object.freeze({
    recordId,
    name,
    key: compact(value.key ?? value.itemKey, 160) || null,
    recordType: compact(value.recordType ?? value.type, 80) || null,
  });
}

export function createTaskCompletionState(settings = {}, context = {}, runtime = {}) {
  const configuration = resolveTaskCompletionConfiguration(settings);
  const schemas = configuredSchemas(runtime.fieldSchemas);
  const values = {};
  for (const field of configuration.requiredFields) {
    const value = safeContextValue(context[field]);
    if (value !== '') values[field] = value;
  }
  return {
    configuration,
    values,
    fieldSchemas: configuration.requiredFields.flatMap((field) => (
      schemas.has(field) ? [schemas.get(field)] : []
    )),
    resolvedEntities: Array.isArray(runtime.resolvedEntities) ? runtime.resolvedEntities : [],
    canonicalEntity: canonicalEntity(runtime.canonicalEntity),
  };
}

export function applyCanonicalEntityToTaskCompletionState(state, entity) {
  const selected = canonicalEntity(entity);
  if (!selected) return { ...state, canonicalEntity: null };
  return {
    ...state,
    canonicalEntity: selected,
    resolvedEntities: [selected],
  };
}

export function captureTaskCompletionInput(state, transcript, history = [], runtime = {}) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const metadata = stateMetadata(state);
  const schemas = configuredSchemas(runtime.fieldSchemas ?? metadata.fieldSchemas);
  const resolvedEntities = runtime.resolvedEntities ?? metadata.resolvedEntities;
  const values = { ...(state?.values ?? {}) };
  const captured = [];
  if (!configuration.enabled) {
    return { state: { configuration, values, ...metadata }, captured, missing: [], complete: false };
  }
  const missingBeforeCapture = configuration.requiredFields
    .filter((field) => values[field] === undefined);
  for (const field of missingBeforeCapture) {
    const schema = schemas.get(field);
    if (!schema) continue;
    const value = extractSchemaFieldValue(schema, transcript, {
      history,
      resolvedEntities,
      onlyMissing: missingBeforeCapture.length === 1,
    });
    if (value === undefined) continue;
    values[field] = value;
    captured.push(field);
  }
  const missing = configuration.requiredFields.filter((field) => values[field] === undefined);
  return {
    state: {
      configuration,
      values,
      fieldSchemas: [...schemas.values()],
      resolvedEntities,
    },
    captured,
    missing,
    complete: missing.length === 0,
  };
}

export function mergeTaskCompletionData(state, updates = {}) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const values = { ...(state?.values ?? {}) };
  for (const field of configuration.requiredFields) {
    const value = safeContextValue(updates[field]);
    if (value !== '') values[field] = value;
  }
  return { configuration, values, ...stateMetadata(state) };
}

export function renderTaskCompletionConfirmation(state) {
  const template = String(state?.configuration?.confirmationMessage ?? '').trim();
  if (!template) return '';
  return compact(template.replace(templatePattern, (match, field) => compact(state?.values?.[field]) || ''));
}

export function publicTaskCompletionState(state) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const values = { ...(state?.values ?? {}) };
  return Object.freeze({
    enabled: configuration.enabled,
    intent: configuration.intent || null,
    requiredFields: [...configuration.requiredFields],
    collectedData: values,
    missingFields: configuration.requiredFields.filter((field) => values[field] === undefined),
    completed: configuration.enabled
      && configuration.requiredFields.every((field) => values[field] !== undefined),
    requiresCatalogItem: configuration.requiresCatalogItem === true,
    catalogField: configuration.catalogField || null,
    canonicalEntity: canonicalEntity(state?.canonicalEntity),
  });
}
