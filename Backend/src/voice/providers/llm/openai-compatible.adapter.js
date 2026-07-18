import { invokeAgentLlm, resolveLlmConfiguration } from '../../../llm/llm.client.js';

function parameters(config) {
  const values = Object.entries(config.parameters ?? {}).map(([key, value]) => ({ key, value }));
  if (String(config.providerName).toLowerCase().includes('azure')) {
    const apiKey = config.parameters?.AZURE_OPENAI_API_KEY ?? config.parameters?.OPENAI_API_KEY;
    if (apiKey && !config.parameters?.AZURE_OPENAI_API_KEY) values.push({ key: 'AZURE_OPENAI_API_KEY', value: apiKey });
  }
  return values;
}

export function createOpenAiCompatibleLlmAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveLlmConfiguration({
    llm: {
      providerId: providerConfig.providerId,
      providerName: providerConfig.providerName,
      modelId: providerConfig.modelId,
      modelKey: providerConfig.modelKey,
      baseUrl: providerConfig.baseUrl,
      modelSettings: providerConfig.modelSettings ?? {},
      parameters: parameters(providerConfig),
    },
  });
  return {
    configuration: {
      providerId: configuration.providerId,
      providerName: configuration.providerName,
      modelId: configuration.modelId,
      model: configuration.model,
    },
    generate(input) {
      return invokeAgentLlm(configuration, input, runtimeContext.fetchImpl ?? fetch);
    },
  };
}

export function registerOpenAiCompatibleLlmAdapter(registry) {
  if (registry.has('llm', 'openai-compatible')) return;
  registry.register('llm', 'openai-compatible', createOpenAiCompatibleLlmAdapter, {
    aliases: ['openai', 'azure', 'azure-openai', 'openai compatible'],
  });
}
