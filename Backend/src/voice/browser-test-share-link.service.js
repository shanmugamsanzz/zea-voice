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
    permanent: row.expires_at == null, revokedAt: row.revoked_at, ...(token ? { token } : {}),
  });
}

export async function createBrowserTestShareLink(auth, agentId, input = {}) {
  return withTenantContext(auth, async (client) => {
    const agent = await client.query(`SELECT id FROM voice_agents
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='active' AND deleted_at IS NULL`,
    [agentId, auth.tenantId, auth.workspaceId]);
    if (!agent.rowCount) throw new AppError(404, 'Agent was not found', 'BROWSER_TEST_AGENT_NOT_FOUND');
    const token = tokenValue();
    const expiresAt = input.expiresIn === 'permanent'
      ? null : new Date(Date.now() + env.BROWSER_TEST_SHARE_LINK_TTL_SECONDS * 1000);
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
  const link = await withAuthServiceContext(async (client) => {
    const found = await client.query(`SELECT * FROM browser_test_share_links
      WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        `, [hash(value)]);
    if (!found.rowCount) throw new AppError(404, 'Shared browser test link is unavailable', 'BROWSER_TEST_SHARE_LINK_UNAVAILABLE');
    return found.rows[0];
  });
  const resolved = await withTenantContext(linkAuth(link), async (client) => {
    const agent = await client.query(`SELECT name,status,usage_direction FROM voice_agents
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND deleted_at IS NULL`,
    [link.agent_id, link.tenant_id, link.workspace_id]);
    if (!agent.rowCount || agent.rows[0].status !== 'active') {
      throw new AppError(404, 'Shared browser test link is unavailable', 'BROWSER_TEST_SHARE_LINK_UNAVAILABLE');
    }
    return Object.freeze({ ...link, agent_name: agent.rows[0].name,
      agent_status: agent.rows[0].status, usage_direction: agent.rows[0].usage_direction });
  });
  return Object.freeze({ token: value, link: resolved });
}

export async function getPublicBrowserTestShareLink(token) {
  const { link } = await resolveBrowserTestShareLink(token);
  return Object.freeze({
    agent: Object.freeze({ id: link.agent_id, name: link.agent_name, status: link.agent_status,
      agentUsage: link.usage_direction }),
    expiresAt: link.expires_at, permanent: link.expires_at == null,
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
