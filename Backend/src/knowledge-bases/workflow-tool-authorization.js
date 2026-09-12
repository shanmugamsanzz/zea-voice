export const WORKFLOW_TOOL_AUTHORIZATION_VERSION = 4;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function identity(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

export function assignedToolIdentifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return Object.freeze(new Set([
    tool.id,
    tool.name,
    configuration.identifier,
    configuration.toolIdentifier,
    configuration.actionKey,
    configuration.key,
    ...(Array.isArray(tool.identifiers) ? tool.identifiers : []),
  ].map(identity).filter(Boolean)));
}

export function assignedToolInputSchema(tool = {}) {
  const configuration = object(tool.configuration);
  return object(tool.inputSchema ?? configuration.inputSchema ?? configuration.input_schema
    ?? configuration.parametersSchema ?? configuration.parameters_schema);
}

// Identifiers only: never include values, URLs, credentials or descriptions.
export function assignedToolSchemaDiagnostics(tool = {}) {
  const configuration = object(tool.configuration);
  const sources = [ ['inputSchema', tool.inputSchema], ['configuration.inputSchema', configuration.inputSchema],
    ['configuration.input_schema', configuration.input_schema], ['configuration.parametersSchema', configuration.parametersSchema],
    ['configuration.parameters_schema', configuration.parameters_schema] ];
  return Object.freeze({
    effectiveSource: sources.find(([, value]) => value != null)?.[0] ?? null,
    sources: sources.filter(([, value]) => value != null).map(([source, schema]) => ({ source,
      propertyKeys: Object.keys(object(object(schema).properties)),
      requiredKeys: Array.isArray(schema?.required) ? schema.required.filter((key) => typeof key === 'string') : [],
    })),
  });
}
