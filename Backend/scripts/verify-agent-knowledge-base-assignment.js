import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { env } from '../src/config/env.js';
import {
  assignKnowledgeBaseToAgent,
  listAgentKnowledgeBases,
  unassignKnowledgeBaseFromAgent,
} from '../src/agents/agent-knowledge-base.service.js';

const { Client } = pg;

async function createProviderModel(client, type, suffix) {
  const provider = await client.query(
    `INSERT INTO ai_providers (name, slug, type, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [`Assignment ${type} ${suffix}`, `assignment-${type}-${suffix}`, type],
  );
  return (await client.query(
    `INSERT INTO provider_models (provider_id, model_key, display_name, status)
     VALUES ($1,$2,$3,'active') RETURNING id`,
    [provider.rows[0].id, `${type}-${suffix}`, `Assignment ${type}`],
  )).rows[0].id;
}

async function createTenant(client, suffix) {
  const tenantId = (await client.query(
    `INSERT INTO tenants (name, slug, status) VALUES ($1,$2,'active') RETURNING id`,
    [`Assignment ${suffix}`, `assignment-${suffix}`],
  )).rows[0].id;
  const organizationId = (await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1,$2,'active') RETURNING id`,
    [tenantId, `Assignment ${suffix}`],
  )).rows[0].id;
  const workspaceId = (await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1,$2,'Default','default','active',true) RETURNING id`,
    [tenantId, organizationId],
  )).rows[0].id;
  return { tenantId, workspaceId };
}

async function createAgent(client, tenant, models, suffix, usageDirection) {
  return (await client.query(
    `INSERT INTO voice_agents (
       tenant_id, workspace_id, name, language, usage_direction, status,
       stt_model_id, llm_model_id, tts_model_id, voice_id, prompt
     ) VALUES ($1,$2,$3,'English (US)',$4,'active',$5,$6,$7,'voice','Assist callers.')
     RETURNING id`,
    [tenant.tenantId, tenant.workspaceId, `Assignment Agent ${suffix}`, usageDirection,
      models.stt, models.llm, models.tts],
  )).rows[0].id;
}

async function createKnowledgeBase(client, tenant, suffix, status, usageDirection) {
  return (await client.query(
    `INSERT INTO knowledge_bases (
       tenant_id, workspace_id, name, status, usage_direction,
       publication_revision, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenant.tenantId, tenant.workspaceId, `Assignment KB ${suffix}`, status, usageDirection,
      status === 'published' ? 1 : 0, status === 'published' ? new Date() : null],
  )).rows[0].id;
}

const client = new Client({
  connectionString: env.DATABASE_URL,
  application_name: 'zea-voice-agent-kb-assignment-verification',
});
let transactionStarted = false;

try {
  await client.connect();
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");

  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase();
  const models = {
    stt: await createProviderModel(client, 'stt', `${suffix}-stt`),
    llm: await createProviderModel(client, 'llm', `${suffix}-llm`),
    tts: await createProviderModel(client, 'tts', `${suffix}-tts`),
  };
  const tenantA = await createTenant(client, `${suffix}-a`);
  const tenantB = await createTenant(client, `${suffix}-b`);
  const inboundAgent = await createAgent(client, tenantA, models, `${suffix}-in`, 'inbound');
  const outboundAgent = await createAgent(client, tenantA, models, `${suffix}-out`, 'outbound');
  const bothKb = await createKnowledgeBase(client, tenantA, `${suffix}-both`, 'published', 'both');
  const inboundKb = await createKnowledgeBase(client, tenantA, `${suffix}-in`, 'published', 'inbound');
  const draftKb = await createKnowledgeBase(client, tenantA, `${suffix}-draft`, 'draft', 'both');
  const foreignKb = await createKnowledgeBase(client, tenantB, `${suffix}-foreign`, 'published', 'both');
  const auth = { ...tenantA, userId: null, role: 'COMPANY_DEVELOPER', authType: 'user' };
  const contextRunner = (_auth, operation) => operation(client);
  let invalidations = 0;
  const invalidate = async (tenantId) => {
    assert.equal(tenantId, tenantA.tenantId);
    invalidations += 1;
    return { deletedKeys: 0 };
  };

  const assigned = await assignKnowledgeBaseToAgent(
    auth, inboundAgent, bothKb, { priority: 25 }, contextRunner, invalidate,
  );
  assert.equal(assigned.created, true);
  assert.equal(assigned.usageDirection, 'inbound');
  assert.equal(assigned.priority, 25);

  const duplicate = await assignKnowledgeBaseToAgent(
    auth, inboundAgent, bothKb, { priority: 99 }, contextRunner, invalidate,
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.priority, 25, 'Duplicate assignment must not overwrite the original');
  assert.equal(invalidations, 1, 'Idempotent duplicate must not invalidate runtime cache');

  const listed = await listAgentKnowledgeBases(auth, inboundAgent, contextRunner);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].knowledgeBaseId, bothKb);
  assert.equal(listed[0].knowledgeBaseStatus, 'published');

  await assert.rejects(
    assignKnowledgeBaseToAgent(auth, outboundAgent, inboundKb, { priority: 100 }, contextRunner, invalidate),
    (error) => error.code === 'AGENT_KNOWLEDGE_BASE_DIRECTION_MISMATCH',
  );
  await assert.rejects(
    assignKnowledgeBaseToAgent(auth, inboundAgent, draftKb, { priority: 100 }, contextRunner, invalidate),
    (error) => error.code === 'AGENT_KNOWLEDGE_BASE_NOT_PUBLISHED',
  );
  await assert.rejects(
    assignKnowledgeBaseToAgent(auth, inboundAgent, foreignKb, { priority: 100 }, contextRunner, invalidate),
    (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND',
  );

  const removed = await unassignKnowledgeBaseFromAgent(
    auth, inboundAgent, bothKb, contextRunner, invalidate,
  );
  assert.equal(removed.deleted, true);
  assert.equal((await listAgentKnowledgeBases(auth, inboundAgent, contextRunner)).length, 0);
  assert.equal(invalidations, 2);
  await assert.rejects(
    unassignKnowledgeBaseFromAgent(auth, inboundAgent, bothKb, contextRunner, invalidate),
    (error) => error.code === 'AGENT_KNOWLEDGE_BASE_ASSIGNMENT_NOT_FOUND',
  );

  const audit = await client.query(
    `SELECT action FROM audit_logs
      WHERE tenant_id=$1 AND entity_type='agent_knowledge_base'`,
    [tenantA.tenantId],
  );
  assert.deepEqual(audit.rows.map((row) => row.action).sort(), [
    'AGENT_KNOWLEDGE_BASE_ASSIGNED',
    'AGENT_KNOWLEDGE_BASE_UNASSIGNED',
  ].sort());

  console.log(JSON.stringify({
    ok: true,
    task: 'Agent Knowledge UI Task 1 - Agent Knowledge Base assignment API',
    verified: {
      listAssignments: true,
      assignPublishedKnowledgeBase: true,
      idempotentDuplicateProtection: true,
      automaticUsageDirectionIntersection: true,
      incompatibleDirectionRejected: true,
      unpublishedKnowledgeBaseRejected: true,
      tenantIsolation: true,
      unassign: true,
      auditTrail: true,
      runtimeCacheInvalidation: true,
    },
    databaseFixturesPersisted: false,
  }, null, 2));
} finally {
  if (transactionStarted) await client.query('ROLLBACK');
  await client.end();
}
