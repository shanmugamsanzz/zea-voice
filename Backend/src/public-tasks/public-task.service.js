import crypto from 'node:crypto';
import { createRealtimeTask } from '../campaigns/campaign-task.service.js';
import { normalizePhone } from '../campaigns/csv.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

function sameNumberArray(left, right) {
  return left.length === right.length && left.every((value, index) => Number(value) === Number(right[index]));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(actual, expected, message, code) {
  if (actual !== expected) throw new AppError(403, message, code);
}

async function loadOwnedCampaign(auth, campaignId, contextRunner) {
  return contextRunner(auth, async (client) => {
    const result = await client.query(`SELECT c.*, pn.e164 AS from_number, w.organization_id
      FROM campaigns c
      JOIN workspaces w ON w.id = c.workspace_id AND w.tenant_id = c.tenant_id
      JOIN phone_numbers pn ON pn.id = c.phone_number_id
      WHERE c.id = $1 AND c.tenant_id = $2 AND c.workspace_id = $3
        AND c.deleted_at IS NULL
        AND w.status = 'active' AND w.deleted_at IS NULL`,
    [campaignId, auth.tenantId, auth.workspaceId]);
    if (!result.rowCount) {
      throw new AppError(404, 'Campaign was not found in this API key workspace', 'PUBLIC_TASK_CAMPAIGN_NOT_FOUND');
    }
    return result.rows[0];
  });
}

export async function createPublicTask(auth, idempotencyKey, input, dependencies = {}) {
  if (auth.authType !== 'api_key' || !auth.apiKeyId) {
    throw new AppError(403, 'A company API key is required', 'COMPANY_API_KEY_REQUIRED');
  }
  if (!auth.tenantId || !auth.workspaceId) {
    throw new AppError(403, 'The API key is not bound to a company workspace', 'API_KEY_COMPANY_CONTEXT_REQUIRED');
  }

  assertEqual(input.workspace_id, auth.workspaceId,
    'workspace_id does not belong to this API key', 'PUBLIC_TASK_WORKSPACE_ACCESS_DENIED');
  if (input.tenant_id) assertEqual(input.tenant_id, auth.tenantId,
    'tenant_id does not belong to this API key', 'PUBLIC_TASK_TENANT_ACCESS_DENIED');

  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  const campaign = await loadOwnedCampaign(auth, input.campaign, contextRunner);
  if (input.organization_id) assertEqual(input.organization_id, campaign.organization_id,
    'organization_id does not belong to this API key workspace', 'PUBLIC_TASK_ORGANIZATION_ACCESS_DENIED');
  assertEqual(input.agent, campaign.agent_id,
    'The supplied agent does not match the campaign agent', 'PUBLIC_TASK_AGENT_MISMATCH');

  const from = normalizePhone(input.from);
  if (!from) throw new AppError(400, 'from must be a valid E.164 number', 'PUBLIC_TASK_FROM_INVALID');
  assertEqual(from, campaign.from_number,
    'The supplied from number does not match the campaign number', 'PUBLIC_TASK_FROM_MISMATCH');
  if (Number(campaign.retries) !== input.retries
    || !sameNumberArray((campaign.retry_intervals_ms ?? []).map(Number), input.intervals)) {
    throw new AppError(409,
      'The supplied retry policy does not match the campaign configuration',
      'PUBLIC_TASK_RETRY_POLICY_MISMATCH', {
        campaignRetries: Number(campaign.retries),
        campaignIntervals: (campaign.retry_intervals_ms ?? []).map(Number),
      });
  }

  const eventId = `public:${crypto.createHash('sha256')
    .update(`${auth.apiKeyId}:${idempotencyKey}`).digest('hex')}`;
  const createTask = dependencies.createTask ?? createRealtimeTask;
  const name = typeof input.context.lead_name === 'string'
    ? input.context.lead_name.trim().slice(0, 240) || undefined
    : undefined;
  const outcome = await createTask(auth, input.campaign, {
    eventId, phone: input.phone, name, context: input.context,
  });

  if (!outcome.created) {
    const sameRequest = outcome.task.phone === normalizePhone(input.phone)
      && canonicalJson(outcome.task.context ?? {}) === canonicalJson(input.context);
    if (!sameRequest) {
      throw new AppError(409,
        'Idempotency-Key was already used with a different request body',
        'IDEMPOTENCY_KEY_REUSED');
    }
  }

  return outcome;
}
