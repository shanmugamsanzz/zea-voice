const alwaysCallerFacingRecordTypes = new Set([
  'faq', 'catalog_item', 'catalog_category', 'knowledge_chunk',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function publishedRecordCallerFacingHint(record = {}) {
  if (record.callerFacing === true || record.caller_facing === true
    || record.callerFacingHint === true || record.caller_facing_hint === true) return true;
  const recordType = String(
    record.recordType ?? record.record_type ?? record.type ?? '',
  ).trim().toLocaleLowerCase();
  if (alwaysCallerFacingRecordTypes.has(recordType)) return true;
  const metadata = object(record.entity_metadata ?? record.metadata);
  if (recordType === 'conversation_node') {
    return String(metadata.nodeType ?? metadata.node_type ?? '')
      .trim().toLocaleLowerCase() !== 'guidance';
  }
  if (recordType === 'workflow_rule') {
    const actionConfig = object(metadata.actionConfig ?? metadata.action_config);
    return String(actionConfig.responseMode ?? actionConfig.response_mode
      ?? metadata.responseMode ?? metadata.response_mode ?? 'instruction')
      .trim().toLocaleLowerCase() === 'exact';
  }
  return false;
}
