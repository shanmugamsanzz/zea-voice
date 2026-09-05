import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  knowledgeResolutionActions,
  resolvePublishedEntityRoute,
} from '../src/knowledge-engine/entity-route-resolver.js';
import {
  activeIsolatedCallMemoryCount,
  openIsolatedCallMemory,
} from '../src/knowledge-engine/call-memory.js';
import { mergeToolFieldSchemas } from '../src/voice/interaction/tool-field-schema.js';
import { extractSchemaFieldValue } from '../src/voice/interaction/schema-field-value-extractor.js';
import { resolveRuntimeMessage } from '../src/voice/interaction/configured-runtime-messages.js';
import { canonicalToolArguments } from '../src/voice/realtime-conversation-orchestrator.js';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));

function publicationIdentity(prefix) {
  return Object.freeze({
    tenantId: `${prefix}000000-0000-4000-8000-000000000001`,
    agentId: `${prefix}000000-0000-4000-8000-000000000002`,
    callId: `${prefix}000000-0000-4000-8000-000000000003`,
    knowledgeBaseId: `${prefix}000000-0000-4000-8000-000000000004`,
  });
}

function publicationRecord(identity, suffix, definition) {
  return {
    record_id: `${identity.tenantId.slice(0, 8)}-0000-4000-8001-${String(suffix).padStart(12, '0')}`,
    record_type: 'catalog_item',
    document_id: `${identity.tenantId.slice(0, 8)}-0000-4000-8002-${String(suffix).padStart(12, '0')}`,
    document_version_id: `${identity.tenantId.slice(0, 8)}-0000-4000-8003-${String(suffix).padStart(12, '0')}`,
    usage_direction: 'both', language: 'mul', source_page_start: 1,
    question: definition.name,
    answer: definition.answer,
    content: definition.answer,
    entity_name: definition.name,
    entity_aliases: definition.aliases,
    entity_category: definition.category,
    entity_category_aliases: definition.categoryAliases ?? [],
    entity_metadata: {
      itemKey: definition.key,
      categoryKey: definition.categoryKey,
    },
  };
}

function tenantFixture({ prefix, product, tool }) {
  const identity = publicationIdentity(prefix);
  const sourceRecord = publicationRecord(identity, 11, product);
  const publication = buildPublicationIndexes({
    tenant_id: identity.tenantId,
    knowledge_base_id: identity.knowledgeBaseId,
    targetRevision: 1,
    knowledge_base_usage: 'both',
    assigned_agent_ids: [identity.agentId],
  }, [sourceRecord]);
  return Object.freeze({ identity, sourceRecord, publication, tool });
}

function engineInput(tenant, utterance, memory = {}) {
  return createKnowledgeEngineInput({
    tenantId: tenant.identity.tenantId,
    agentId: tenant.identity.agentId,
    callId: tenant.identity.callId,
    utterance,
    usageDirection: 'inbound',
    memory,
  });
}

const tenants = [
  tenantFixture({
    prefix: '61',
    product: {
      name: 'Nebula Torque Kit', key: 'nebula-torque-kit', aliases: ['orbit drive set'],
      category: 'Factory Components', categoryKey: 'factory-components',
      answer: 'The published assembly includes the configured torque components.',
    },
    tool: {
      name: 'submit_assembly_request',
      inputSchema: {
        type: 'object', required: ['component', 'finish', 'batch_size'],
        properties: {
          component: {
            type: 'string', format: 'catalog-reference',
            title: 'Component', question: 'Which published component?',
          },
          finish: {
            type: 'string', title: 'Finish', question: 'Which finish?',
            enum: ['matte', 'polished'],
            'x-enum-aliases': { matte: ['soft surface'], polished: ['bright surface'] },
          },
          batch_size: { type: 'integer', title: 'Batch size', question: 'How many units?' },
        },
      },
    },
  }),
  tenantFixture({
    prefix: '72',
    product: {
      name: 'Lumen Language Lab', key: 'lumen-language-lab', aliases: ['speech studio'],
      category: 'Learning Tracks', categoryKey: 'learning-tracks',
      answer: 'The published learning track includes guided language sessions.',
    },
    tool: {
      name: 'enrol_learning_track',
      inputSchema: {
        type: 'object', required: ['track', 'delivery_mode', 'learner_email'],
        properties: {
          track: {
            type: 'string', 'x-catalog-reference': true,
            title: 'Learning track', question: 'Which published learning track?',
          },
          delivery_mode: {
            type: 'string', title: 'Delivery mode', question: 'Which delivery mode?',
            enum: ['remote', 'studio'],
            'x-enum-aliases': { remote: ['online'], studio: ['in person'] },
          },
          learner_email: {
            type: 'string', format: 'email', title: 'Learner email',
            question: 'What is the learner email?',
          },
        },
      },
    },
  }),
  tenantFixture({
    prefix: '83',
    product: {
      name: 'Harbor Route Beacon', key: 'harbor-route-beacon', aliases: ['dock signal unit'],
      category: 'Marine Navigation', categoryKey: 'marine-navigation',
      answer: 'The published navigation unit includes the configured route signalling features.',
    },
    tool: {
      name: 'reserve_navigation_unit',
      inputSchema: {
        type: 'object', required: ['unit', 'port_zone', 'quantity'],
        properties: {
          unit: {
            type: 'string', format: 'catalog-reference',
            title: 'Navigation unit', question: 'Which published navigation unit?',
          },
          port_zone: {
            type: 'string', title: 'Port zone', question: 'Which port zone?',
            enum: ['north', 'south'],
            'x-enum-aliases': { north: ['upper port'], south: ['lower port'] },
          },
          quantity: { type: 'integer', title: 'Quantity', question: 'How many units?' },
        },
      },
    },
  }),
];

for (let repeat = 1; repeat <= 3; repeat += 1) for (const tenant of tenants) {
  const resolution = resolvePublishedEntityRoute(
    engineInput(tenant, tenant.sourceRecord.entity_aliases[0]), tenant.publication,
  );
  assert.equal(resolution.action, 'CONTINUE');
  assert.equal(resolution.candidate.recordId, tenant.sourceRecord.record_id);
  assert.equal(resolution.candidate.label, tenant.sourceRecord.entity_name);

  const fields = mergeToolFieldSchemas([], [tenant.tool]);
  assert.deepEqual(fields.map((field) => field.key), tenant.tool.inputSchema.required,
    'Tool fields must be derived from the current tenant UI schema');
  const catalogField = fields.find((field) => field.type === 'catalog_reference');
  const enumField = fields.find((field) => field.type === 'select');
  assert.ok(catalogField?.question);
  assert.ok(enumField?.options?.length === 2);

  const entity = {
    recordId: resolution.candidate.recordId,
    recordType: resolution.candidate.recordType,
    key: resolution.candidate.itemKey,
    name: resolution.candidate.label,
    aliases: tenant.sourceRecord.entity_aliases,
    confidenceLevel: 'HIGH',
  };
  assert.equal(extractSchemaFieldValue(catalogField, tenant.sourceRecord.entity_aliases[0], {
    resolvedEntities: [entity],
  }), tenant.sourceRecord.entity_name,
  'Catalog-reference values must come from the current tenant publication');
  assert.equal(extractSchemaFieldValue(enumField, enumField.options[1].aliases[0]),
    enumField.options[1].value,
  'Enum values must come from the current tenant UI schema');

  const argumentsWithCanonicalEntity = canonicalToolArguments({
    name: tenant.tool.name, arguments: {},
  }, [tenant.tool], entity);
  assert.equal(argumentsWithCanonicalEntity[catalogField.key], tenant.sourceRecord.record_id);

  const memory = openIsolatedCallMemory(tenant.identity, {});
  memory.beginTurn('canonical-turn');
  memory.applyResolvedContext({
    explicitEntity: true,
    entity: {
      id: entity.recordId, recordId: entity.recordId, key: entity.key, name: entity.name,
      category: tenant.sourceRecord.entity_category,
      categoryKey: tenant.sourceRecord.entity_metadata.categoryKey,
    },
  }, { turnToken: 'canonical-turn' });
  const memorySnapshot = memory.snapshot();
  assert.equal(memorySnapshot.activeEntity.id, tenant.sourceRecord.record_id,
    'Contextual follow-up memory must retain the canonical tenant record');
  const followUp = resolvePublishedEntityRoute(engineInput(
    tenant, 'Tell me more about this', memorySnapshot,
  ), tenant.publication);
  assert.equal(followUp.candidate, null,
    'The resolver must not guess that a current question refers to stale memory');
  memory.close();

  const unknown = resolvePublishedEntityRoute(
    engineInput(tenant, 'unpublished value with no supporting evidence'), tenant.publication,
  );
  assert.equal(unknown.action, knowledgeResolutionActions.CLARIFY);
  assert.equal(unknown.candidate, null);
  const clarification = resolveRuntimeMessage({
    agent: { settings: { knowledgeClarificationMessage: catalogField.question } },
  }, 'clarification');
  assert.equal(clarification, catalogField.question,
    'Unknown values must use the tenant-configured targeted field question');
}

const [factoryTenant, learningTenant] = tenants;
assert.equal(resolvePublishedEntityRoute(
  engineInput(learningTenant, factoryTenant.sourceRecord.entity_name), learningTenant.publication,
).candidate, null, 'A tenant must not resolve another tenant publication value');
assert.throws(() => resolvePublishedEntityRoute(
  engineInput(factoryTenant, factoryTenant.sourceRecord.entity_name), learningTenant.publication,
), /same tenant/iu, 'Cross-tenant publication bundles must be rejected');

const isolatedMemory = openIsolatedCallMemory({
  ...factoryTenant.identity, tenantId: learningTenant.identity.tenantId,
}, {});
assert.equal(isolatedMemory.snapshot().activeEntity, null,
  'Canonical memory must not cross tenant boundaries');
isolatedMemory.close();
assert.equal(activeIsolatedCallMemoryCount(), 0);

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && extname(entry.name) === '.js' ? [path] : [];
  }));
  return nested.flat();
}

const runtimeRoots = [
  join(backendRoot, 'src'),
];
const prohibitedBusinessLiterals = [
  'shanmuga hospital', 'silver package', 'gold package', 'platinum package',
  'onco care', 'organ-specific health check', 'diabetic health check',
  ...tenants.flatMap((tenant) => [
    tenant.sourceRecord.entity_name,
    ...tenant.sourceRecord.entity_aliases,
    tenant.sourceRecord.entity_category,
    tenant.sourceRecord.answer,
    tenant.tool.name,
    ...Object.values(tenant.tool.inputSchema.properties)
      .map((property) => property.question).filter(Boolean),
  ]),
];
const prohibitedBusinessIdentifiers = tenants.flatMap((tenant) => [
  tenant.tool.name,
  ...Object.keys(tenant.tool.inputSchema.properties),
]).filter((identifier) => /[._:-]/u.test(identifier));
const violations = [];
for (const path of (await Promise.all(runtimeRoots.map(javascriptFiles))).flat()) {
  const source = (await readFile(path, 'utf8')).toLocaleLowerCase();
  for (const literal of prohibitedBusinessLiterals) {
    if (source.includes(literal.toLocaleLowerCase())) {
      violations.push({ file: relative(backendRoot, path), literal });
    }
  }
  for (const identifier of prohibitedBusinessIdentifiers) {
    const literal = identifier.toLocaleLowerCase();
    if (source.includes(`'${literal}'`) || source.includes(`"${literal}"`)
      || source.includes(`\`${literal}\``)) {
      violations.push({ file: relative(backendRoot, path), literal: identifier });
    }
  }
}
assert.deepEqual(violations, [],
  `Runtime source contains prohibited business literals: ${JSON.stringify(violations)}`);

console.log(JSON.stringify({
  gate: 'universal-hardcoding', passed: true, syntheticTenants: tenants.length,
  repeats: 3,
  schemaDrivenTools: tenants.map((tenant) => tenant.tool.name),
  canonicalMemoryVerified: true, crossTenantLeakage: false,
  targetedClarificationVerified: true, sourceFilesScanned: (
    await Promise.all(runtimeRoots.map(javascriptFiles))
  ).flat().length,
  prohibitedBusinessLiteralMatches: violations.length,
  productionScope: 'Backend/src',
}, null, 2));
