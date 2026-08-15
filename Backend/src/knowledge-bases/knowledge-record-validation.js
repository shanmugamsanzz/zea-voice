const toolIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function value(record, camel, snake = camel) {
  return record?.[camel] ?? record?.[snake];
}

export function normalizeConfiguredToolIdentifier(input) {
  const identifier = String(input ?? '').normalize('NFKC').trim();
  return toolIdentifierPattern.test(identifier) ? identifier : null;
}

export function validateKnowledgeRecord(kind, record = {}) {
  const issues = [];
  if (kind === 'catalog_item') {
    if (!String(value(record, 'name') ?? '').trim()) issues.push('Catalog item name is required');
    if (!String(value(record, 'itemKey', 'item_key') ?? '').trim()) issues.push('Catalog item stable key is required');
    const price = value(record, 'price');
    const currency = String(value(record, 'currency') ?? '').trim();
    if (price !== null && price !== undefined && price !== '') {
      if (!Number.isFinite(Number(price)) || Number(price) < 0) issues.push('Catalog item price must be a non-negative number');
      if (!/^[A-Za-z]{3}$/u.test(currency)) issues.push('A three-letter currency is required when a price is supplied');
    } else if (currency && !/^[A-Za-z]{3}$/u.test(currency)) {
      issues.push('Catalog item currency must use a three-letter code');
    }
  }
  if (kind === 'workflow_rule') {
    const config = value(record, 'actionConfig', 'action_config') ?? {};
    const responseMode = String(config.responseMode ?? 'instruction').trim().toLowerCase();
    const identifier = normalizeConfiguredToolIdentifier(config.toolIdentifier ?? config.actionKey);
    if (!['exact', 'instruction', 'generated'].includes(responseMode)) {
      issues.push('Workflow response mode must be exact, instruction or generated');
    }
    if (responseMode !== 'exact' && !identifier) {
      issues.push('Workflow instructions and generated actions require an explicit configured tool identifier');
    }
    if ((config.toolIdentifier || config.actionKey) && !identifier) {
      issues.push('Configured tool identifier may contain only letters, numbers, dot, underscore, colon or hyphen');
    }
    if (responseMode === 'exact' && !String(value(record, 'responseTemplate', 'response_template') ?? '').trim()) {
      issues.push('An exact workflow response requires caller-facing response text');
    }
  }
  return issues;
}
