function safeToolName(tool, index) {
  const name = String(tool?.name ?? `tool_${index + 1}`).trim()
    .replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64);
  return name || `tool_${index + 1}`;
}

export function templateEngineToolSchemas(tools = []) {
  if (!Array.isArray(tools)) throw new TypeError('Assigned tools must be an array');
  return tools.map((tool, index) => {
    const configuration = tool.configuration ?? {};
    const name = safeToolName(tool, index);
    const inputSchema = configuration.inputSchema ?? configuration.input_schema
      ?? configuration.parametersSchema ?? configuration.parameters_schema
      ?? { type: 'object', properties: {}, additionalProperties: true };
    return Object.freeze({
      id: tool.id,
      name,
      identifiers: Object.freeze([...new Set([
        name, tool.id, tool.name, configuration.identifier,
        configuration.toolIdentifier, configuration.actionKey, configuration.key,
      ].map((value) => String(value ?? '').trim()).filter(Boolean))]),
      description: String(tool.description ?? `Execute ${name}`).slice(0, 1_024),
      inputSchema,
    });
  });
}
