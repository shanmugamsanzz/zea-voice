export const KNOWLEDGE_DOCUMENT_CONTRACT_VERSION = 1;

export const KNOWLEDGE_DOCUMENT_CONTRACTS = Object.freeze({
  catalog: Object.freeze({
    type: 'catalog',
    uiLabel: 'Product / Service Catalog',
    postgresRecords: Object.freeze(['structured_catalogs', 'structured_items', 'structured_item_attributes']),
    semanticRecordTypes: Object.freeze(['CATALOG_ITEM']),
  }),
  workflow_rules: Object.freeze({
    type: 'workflow_rules',
    uiLabel: 'Workflow and Action Rules',
    postgresRecords: Object.freeze(['workflow_rules']),
    semanticRecordTypes: Object.freeze(['WORKFLOW_RULE']),
  }),
  conversation_script: Object.freeze({
    type: 'conversation_script',
    uiLabel: 'Conversation Guidance',
    postgresRecords: Object.freeze(['conversation_flows']),
    semanticRecordTypes: Object.freeze(['CONVERSATION_NODE']),
  }),
  faq: Object.freeze({
    type: 'faq',
    uiLabel: 'FAQ',
    postgresRecords: Object.freeze(['faq_entries']),
    semanticRecordTypes: Object.freeze(['FAQ']),
  }),
  general_knowledge: Object.freeze({
    type: 'general_knowledge',
    uiLabel: 'General Knowledge',
    postgresRecords: Object.freeze(['knowledge_chunks']),
    semanticRecordTypes: Object.freeze(['KNOWLEDGE_CHUNK']),
  }),
});

export const KNOWLEDGE_DOCUMENT_TYPES = Object.freeze(Object.keys(KNOWLEDGE_DOCUMENT_CONTRACTS));

export function requireKnowledgeDocumentContract(documentType) {
  const contract = KNOWLEDGE_DOCUMENT_CONTRACTS[documentType];
  if (!contract) throw new TypeError(`Unsupported knowledge document type: ${documentType}`);
  return contract;
}

export function normalizeKnowledgeDocumentMetadata(documentType, metadata = {}) {
  const contract = requireKnowledgeDocumentContract(documentType);
  const supplied = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const language = String(supplied.language ?? 'und').trim().toLowerCase().slice(0, 20) || 'und';
  return {
    ...supplied,
    language,
    documentContract: {
      version: KNOWLEDGE_DOCUMENT_CONTRACT_VERSION,
      type: contract.type,
      label: contract.uiLabel,
    },
  };
}
