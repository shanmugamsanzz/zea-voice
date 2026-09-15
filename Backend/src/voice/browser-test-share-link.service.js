import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withAuthServiceContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { createBrowserTestSession, endBrowserTestSession } from './browser-test-session.service.js';

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const tokenValue = () => crypto.randomBytes(32).toString('base64url');

function publicLink(row, token = null) {
  return Object.freeze({
    id: row.id, agentId: row.agent_id, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, ...(token ? { token } : {}),
  });
}

export async function createBrowserTestShareLink(auth, agentId) {
  return withTenantContext(auth, async (client) => {
    const agent = await client.query(`SELECT id FROM voice_agents
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='active' AND deleted_at IS NULL`,
    [agentId, auth.tenantId, auth.workspaceId]);
    if (!agent.rowCount) throw new AppError(404, 'Agent was not found', 'BROWSER_TEST_AGENT_NOT_FOUND');
    const token = tokenValue();
    const expiresAt = new Date(Date.now() + env.BROWSER_TEST_SHARE_LINK_TTL_SECONDS * 1000);
    const inserted = await client.query(`INSERT INTO browser_test_share_links
      (id,tenant_id,workspace_id,agent_id,created_by_user_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
      crypto.randomUUID(), auth.tenantId, auth.workspaceId, agentId, auth.userId, hash(token), expiresAt,
    ]);
    return publicLink(inserted.rows[0], token);
  });
}

async function resolveBrowserTestShareLink(token) {
  const value = String(token ?? '').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(value)) {
    throw new AppError(404, 'Shared browser test link is unavailable', 'BROWSER_TEST_SHARE_LINK_UNAVAILABLE');
  }
  return withAuthServiceContext(async (client) => {
    const found = await client.query(`SELECT link.*,agent.name AS agent_name,agent.status AS agent_status,
      agent.usage_direction FROM browser_test_share_links link
      JOIN voice_agents agent ON agent.id=link.agent_id AND agent.tenant_id=link.tenant_id
        AND agent.workspace_id=link.workspace_id
      WHERE link.token_hash=$1 AND link.revoked_at IS NULL AND link.expires_at > now()
        AND agent.deleted_at IS NULL`, [hash(value)]);
    if (!found.rowCount || found.rows[0].agent_status !== 'active') {
      throw new AppError(404, 'Shared browser test link is unavailable', 'BROWSER_TEST_SHARE_LINK_UNAVAILABLE');
    }
    return Object.freeze({ token: value, link: found.rows[0] });
  });
}

export async function getPublicBrowserTestShareLink(token) {
  const { link } = await resolveBrowserTestShareLink(token);
  return Object.freeze({
    agent: Object.freeze({ id: link.agent_id, name: link.agent_name, status: link.agent_status,
      agentUsage: link.usage_direction }),
    expiresAt: link.expires_at,
  });
}

function linkAuth(link) {
  return Object.freeze({ tenantId: link.tenant_id, workspaceId: link.workspace_id,
    userId: link.id, role: 'COMPANY_DEVELOPER' });
}

export async function createPublicBrowserTestSession(token, input) {
  const { link } = await resolveBrowserTestShareLink(token);
  return createBrowserTestSession(linkAuth(link), link.agent_id, input);
}

export async function endPublicBrowserTestSession(token, testCallId) {
  const { link } = await resolveBrowserTestShareLink(token);
  return endBrowserTestSession(linkAuth(link), link.agent_id, testCallId);
}
