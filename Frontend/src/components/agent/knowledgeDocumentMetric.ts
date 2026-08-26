export type KnowledgeDocumentMetricType =
  | 'faq'
  | 'catalog'
  | 'workflow_rules'
  | 'conversation_script'
  | 'general_knowledge';

const metricLabels: Record<KnowledgeDocumentMetricType, readonly [string, string]> = {
  faq: ['entry', 'entries'],
  catalog: ['item', 'items'],
  workflow_rules: ['rule', 'rules'],
  conversation_script: ['node', 'nodes'],
  general_knowledge: ['chunk', 'chunks'],
};

export function knowledgeDocumentMetric(
  documentType: KnowledgeDocumentMetricType,
  counts: { recordCount?: number | null; chunkCount?: number | null },
) {
  const rawCount = documentType === 'general_knowledge'
    ? counts.chunkCount
    : counts.recordCount;
  const count = Number.isInteger(Number(rawCount)) && Number(rawCount) >= 0
    ? Number(rawCount)
    : 0;
  const labels = metricLabels[documentType];
  return `${count} ${count === 1 ? labels[0] : labels[1]}`;
}
