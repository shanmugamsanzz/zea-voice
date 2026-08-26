import {
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from './engine-contract.js';

export const COMPACT_EVIDENCE_BUNDLE_VERSION = 2;

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizedId(value) {
  return cleanText(value, 240).toLocaleLowerCase();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactMemoryEntity(value) {
  const entity = object(value);
  const recordId = cleanText(entity.recordId ?? entity.id, 160);
  const key = cleanText(entity.itemKey ?? entity.categoryKey ?? entity.key, 160);
  const name = cleanText(entity.name ?? entity.label, 240);
  if (!recordId && !key && !name) return null;
  return Object.freeze({
    recordId: recordId || null,
    key: key || null,
    name: name || null,
  });
}

function compactCallMemory(input) {
  const memory = object(input?.canonicalCallMemory ?? input?.memory);
  const pending = object(memory.pendingClarification);
  const tool = object(memory.activeTool);
  return Object.freeze({
    activeEntity: compactMemoryEntity(memory.activeEntity),
    activeCategory: compactMemoryEntity(memory.activeCategory),
    latestIntent: cleanText(memory.latestIntent, 80) || null,
    pendingClarification: Object.keys(pending).length ? Object.freeze({
      kind: cleanText(pending.kind ?? pending.reason, 80) || null,
      question: cleanText(pending.question ?? pending.prompt, 500) || null,
      candidateRecordIds: Object.freeze((Array.isArray(pending.candidateRecordIds)
        ? pending.candidateRecordIds
        : (Array.isArray(pending.recordIds) ? pending.recordIds : []))
        .slice(0, 5).map((id) => cleanText(id, 160)).filter(Boolean)),
    }) : null,
    activeTool: Object.keys(tool).length ? Object.freeze({
      name: cleanText(tool.name, 100) || null,
      status: cleanText(tool.status, 80) || null,
    }) : null,
  });
}

function compactAuthoritativeData(source) {
  const data = object(source?.authoritativeData);
  if (source?.recordType === 'CATALOG_ITEM') return Object.freeze({
    itemKey: data.itemKey ?? null,
    name: cleanText(data.name, 240),
    aliases: Object.freeze((data.aliases ?? []).slice(0, 12).map((value) => cleanText(value, 160))),
    category: cleanText(data.category, 240),
    categoryKey: data.categoryKey ?? null,
    categoryDescription: cleanText(data.categoryDescription, 800),
    description: cleanText(data.description, 1_200),
    price: data.price ?? null,
    currency: cleanText(data.currency, 20),
    attributes: Object.freeze((data.attributes ?? []).slice(0, 20)),
    relationships: Object.freeze(object(data.relationships)),
    selectionRules: Object.freeze(object(data.selectionRules)),
  });
  if (source?.recordType === 'CATALOG_CATEGORY') return Object.freeze({
    categoryKey: data.categoryKey ?? null,
    category: cleanText(data.category, 240),
    categoryAliases: Object.freeze((data.categoryAliases ?? []).slice(0, 12)
      .map((value) => cleanText(value, 160))),
    categoryDescription: cleanText(data.categoryDescription, 1_200),
    children: Object.freeze((data.children ?? []).slice(0, 50).map((child) => Object.freeze({
      recordId: child.recordId ?? null,
      itemKey: child.itemKey ?? null,
      name: cleanText(child.name, 240),
      description: cleanText(child.description, 600),
      price: child.price ?? null,
      currency: cleanText(child.currency, 20),
    }))),
  });
  if (source?.recordType === 'FAQ') return Object.freeze({
    question: cleanText(data.question, 600), answer: cleanText(data.answer, 2_000),
  });
  if (source?.recordType === 'CONVERSATION_NODE') return Object.freeze({
    flowKey: data.flowKey ?? null, nodeKey: data.nodeKey ?? null,
    nodeType: data.nodeType ?? null, content: cleanText(data.content, 2_000),
  });
  if (source?.recordType === 'WORKFLOW_RULE') return Object.freeze({
    intent: data.intent ?? null, actionType: data.actionType ?? null,
    actionConfig: Object.freeze(object(data.actionConfig)),
    responseTemplate: cleanText(data.responseTemplate, 1_200),
  });
  return Object.freeze({
    heading: cleanText(data.heading, 300), content: cleanText(data.content ?? source?.content, 2_000),
  });
}

function compactEvidence(source) {
  return Object.freeze({
    id: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
    tenantId: source.tenantId,
    agentId: source.agentId,
    knowledgeBaseId: source.knowledgeBaseId,
    publicationRevision: source.publicationRevision,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    documentStatus: source.documentStatus,
    documentVersionStatus: source.documentVersionStatus,
    documentVersionIsCurrent: source.documentVersionIsCurrent === true,
    documentName: source.documentName,
    documentDisplayName: source.documentDisplayName,
    documentType: source.documentType,
    pageNumber: source.pageNumber,
    pageEnd: source.pageEnd,
    content: cleanText(source.content, 2_500),
    callerFacing: source.callerFacing === true,
    rank: source.rank,
    rrfScore: source.rrfScore,
    hydrationValidated: source.hydrationValidated === true,
    publicationValidated: source.publicationValidated === true,
    activationAllowed: source.activationAllowed === true,
    retrievalContext: source.retrievalContext ?? 'primary',
    channels: Object.freeze([...(source.channels ?? [])]),
    authoritativeData: compactAuthoritativeData(source),
    provenance: source.provenance ?? Object.freeze({
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
      uploadedFilename: source.documentName,
      documentDisplayName: source.documentDisplayName,
      pageNumber: source.pageNumber,
      pageEnd: source.pageEnd,
      sourceSection: source.sourceSection,
      sourceLineStart: source.sourceLineStart,
      sourceLineEnd: source.sourceLineEnd,
    }),
  });
}

function canonicalEntity(resolution, evidence) {
  const candidate = resolution?.candidate;
  if (!candidate) return null;
  const hydrated = evidence.find((source) => (
    normalizedId(source.recordId) === normalizedId(candidate.recordId)
  ));
  if (!hydrated) return null;
  const data = object(hydrated?.authoritativeData);
  const entityType = candidate.entityType
    ?? (hydrated.recordType === 'CATALOG_CATEGORY' ? 'CATEGORY' : 'ITEM');
  const category = entityType === 'CATEGORY';
  const key = category
    ? candidate.categoryKey ?? data.categoryKey
    : candidate.itemKey ?? data.itemKey;
  const name = category
    ? candidate.label ?? data.category
    : candidate.label ?? data.name;
  return Object.freeze({
    id: hydrated.recordId,
    recordId: hydrated.recordId,
    key: key ?? null,
    entityType,
    itemKey: candidate.itemKey ?? data.itemKey ?? null,
    categoryKey: candidate.categoryKey ?? data.categoryKey ?? null,
    name: cleanText(name, 240),
    aliases: Object.freeze((entityType === 'CATEGORY'
      ? (data.categoryAliases ?? []) : (data.aliases ?? []))
      .slice(0, 20).map((alias) => cleanText(alias, 160)).filter(Boolean)),
    category: cleanText(data.category, 240) || null,
    explicit: candidate.explicit === true,
  });
}

function catalogEntities(evidence, resolvedEntity) {
  const entities = [];
  const seen = new Set();
  const append = (value) => {
    const key = normalizedId(value?.key ?? value?.recordId);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entities.push(Object.freeze(value));
  };
  if (resolvedEntity) append(resolvedEntity);
  for (const source of evidence) {
    const data = object(source.authoritativeData);
    if (source.recordType === 'CATALOG_ITEM') append({
      id: source.recordId, recordId: source.recordId, recordType: source.recordType,
      entityType: 'ITEM', key: data.itemKey ?? source.recordId,
      itemKey: data.itemKey ?? null, categoryKey: data.categoryKey ?? null,
      name: cleanText(data.name, 240), category: cleanText(data.category, 240) || null,
      aliases: Object.freeze((data.aliases ?? []).slice(0, 20)
        .map((alias) => cleanText(alias, 160)).filter(Boolean)),
    });
    if (source.recordType === 'CATALOG_CATEGORY') append({
      id: source.recordId, recordId: source.recordId, recordType: source.recordType,
      entityType: 'CATEGORY', key: data.categoryKey ?? source.recordId,
      itemKey: null, categoryKey: data.categoryKey ?? null,
      name: cleanText(data.category, 240), category: cleanText(data.category, 240) || null,
      aliases: Object.freeze((data.categoryAliases ?? []).slice(0, 20)
        .map((alias) => cleanText(alias, 160)).filter(Boolean)),
    });
  }
  return Object.freeze(entities.slice(0, 20));
}

function toolIdentifier(source) {
  const config = object(source?.authoritativeData?.actionConfig);
  return normalizedId(config.toolIdentifier ?? config.actionKey ?? config.tool ?? config.action);
}

function toolIdentifiers(tool) {
  const config = object(tool?.configuration);
  return new Set([
    tool?.id, tool?.name, config.identifier, config.toolIdentifier, config.actionKey, config.key,
  ].map(normalizedId).filter(Boolean));
}

function authorizedTools(evidence, runtimeProfile) {
  const workflows = evidence.filter((source) => (
    source.recordType === 'WORKFLOW_RULE'
    && source.hydrationValidated === true
    && String(source.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && toolIdentifier(source)
  ));
  const selected = [];
  for (const workflow of workflows) {
    const identifier = toolIdentifier(workflow);
    for (const tool of runtimeProfile?.tools ?? []) {
      if (!toolIdentifiers(tool).has(identifier)) continue;
      const config = object(tool.configuration);
      selected.push(Object.freeze({
        name: cleanText(tool.name, 160),
        authorizationEvidenceId: workflow.id,
        description: cleanText(tool.description, 600),
        inputSchema: Object.freeze(object(tool.inputSchema ?? config.inputSchema
          ?? config.input_schema ?? config.parametersSchema ?? config.parameters_schema)),
      }));
    }
  }
  return Object.freeze(selected.slice(0, 3));
}

export function buildCompactEvidenceBundle({
  input, classification, resolution, authoritative, runtimeProfile, decision,
} = {}) {
  if (decision?.type !== knowledgeEngineDecisionTypes.RESPONSE
    || decision?.mode !== knowledgeEngineResponseModes.GROUNDED_LLM) return null;
  const allEvidence = authoritative?.evidence ?? [];
  const allowedIds = new Set((decision.evidenceIds ?? []).map(normalizedId));
  const topEvidence = allEvidence.filter((source) => (
    source.callerFacing === true
    && (allowedIds.has(normalizedId(source.id)) || allowedIds.has(normalizedId(source.recordId)))
  )).slice(0, 5).map(compactEvidence);
  const guidance = allEvidence.filter((source) => (
    source.recordType === 'CONVERSATION_NODE' && source.callerFacing === false
  )).slice(0, 1).map(compactEvidence);
  const workflowEvidence = allEvidence.filter((source) => source.recordType === 'WORKFLOW_RULE');
  const authorizedToolSchemas = authorizedTools(workflowEvidence, runtimeProfile);
  const authorizationIds = new Set(authorizedToolSchemas.map((tool) => (
    normalizedId(tool.authorizationEvidenceId)
  )));
  const actionAuthorizationEvidence = workflowEvidence.filter((source) => (
    authorizationIds.has(normalizedId(source.id))
  )).slice(0, 3).map((source) => compactEvidence({
    ...source, activationAllowed: true, retrievalContext: 'primary',
  }));
  const sourceMap = topEvidence.map((source, index) => Object.freeze({
    sourceId: `source_${index + 1}`,
    publishedEvidenceId: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
    knowledgeBaseId: source.knowledgeBaseId,
    publicationRevision: source.publicationRevision,
  }));
  const resolvedEntity = canonicalEntity(resolution, allEvidence);
  return Object.freeze({
    version: COMPACT_EVIDENCE_BUNDLE_VERSION,
    latestQuestion: cleanText(input?.latestQuestion ?? input?.utterance, 2_000),
    callMemory: compactCallMemory(input),
    canonicalEntity: resolvedEntity,
    entities: catalogEntities(topEvidence, resolvedEntity),
    requestedFact: input?.requestedFact ?? null,
    requestedFacts: Object.freeze([...(input?.requestedFacts ?? [])].slice(0, 8)),
    recentRelevantTurns: Object.freeze([...(input?.recentRelevantTurns ?? [])].slice(-4)),
    intentClass: classification?.intentClass ?? null,
    topEvidence: Object.freeze(topEvidence),
    sourceMap: Object.freeze(sourceMap),
    conversationGuidance: Object.freeze(guidance),
    authorizedToolSchemas,
    actionAuthorizationEvidence: Object.freeze(actionAuthorizationEvidence),
    publicationRevisions: Object.freeze([...new Set(topEvidence.map((source) => (
      `${source.knowledgeBaseId}:${source.publicationRevision}`
    )))]),
  });
}

export function compactBundleAsKnowledge(knowledge = {}) {
  const evidenceBundle = knowledge?.tenantEvidence?.llmEvidenceBundle;
  if (!evidenceBundle) return knowledge;
  return Object.freeze({
    found: evidenceBundle.topEvidence.length > 0,
    route: 'knowledge_engine',
    tenantEvidence: Object.freeze({
      found: evidenceBundle.topEvidence.length > 0,
      sources: evidenceBundle.topEvidence,
      // Applicable guidance already influences publication/retrieval. The LLM
      // receives only hydrated answer evidence plus authorized Workflow data.
      guidanceEvidence: Object.freeze([]),
      actionEvidence: evidenceBundle.actionAuthorizationEvidence,
      entities: evidenceBundle.entities,
      evidenceIds: Object.freeze(evidenceBundle.topEvidence.map((source) => source.id)),
      publicationRevisions: knowledge.tenantEvidence?.publicationRevisions ?? [],
      llmEvidenceBundle: evidenceBundle,
    }),
  });
}
