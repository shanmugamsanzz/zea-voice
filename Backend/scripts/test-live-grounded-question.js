import { generateAgentResponse } from '../src/agents/agent-runtime.service.js';

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : fallback;
}

const tenantId = argument('tenant-id', process.env.TEST_TENANT_ID);
const userId = argument('user-id', process.env.TEST_USER_ID);
const agentId = argument('agent-id', process.env.TEST_AGENT_ID);
const question = argument('question', 'நாங்க retail shop வச்சிருக்கோம்');

if (!tenantId || !userId || !agentId) {
  console.error(`Usage:
  node scripts/test-live-grounded-question.js \\
    --tenant-id=<tenant UUID> \\
    --user-id=<user UUID> \\
    --agent-id=<agent UUID> \\
    --question="நாங்க retail shop வச்சிருக்கோம்"`);
  process.exit(1);
}

const result = await generateAgentResponse({
  tenantId,
  userId,
  role: 'COMPANY_ADMIN',
}, agentId, {
  event: 'user_message',
  query: question,
  usageDirection: 'inbound',
  language: 'ta',
  history: [],
  context: {},
});

console.log(JSON.stringify({
  question,
  answer: result.answer,
  action: result.action,
  route: result.knowledge?.tenantEvidence?.route ?? result.knowledge?.route ?? null,
  retrievedRecords: (result.knowledge?.tenantEvidence?.llmEvidenceBundle
    ?.decisionInput?.hydratedRecords ?? []).map((record) => ({
    sourceId: record.sourceId,
    recordId: record.recordId,
    recordType: record.recordType,
    canonicalName: record.canonicalName,
  })),
  durationMs: result.durationMs,
}, null, 2));
