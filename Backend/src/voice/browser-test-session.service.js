import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withAuthServiceContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { activeCallSessions } from './call-session-store.js';
import { createBrowserTestMediaToken, hashBrowserTestNonce } from './browser-test-token.js';

const browserSource = 'browser_test';
const browserFrom = '+10000000000';
const browserTo = '+10000000001';

function publicSession(row, token = null) {
  return Object.freeze({
    testCallId: row.id,
    callId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    direction: row.direction,
    status: row.status,
    expiresAt: row.provider_metadata?.browserTest?.expiresAt ?? null,
    mediaPath: '/voice/browser-test/media',
    protocol: 'zea.browser-voice.v1',
    inputFormat: Object.freeze({ encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }),
    outputFormat: Object.freeze({ encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }),
    ...(token ? { token } : {}),
  });
}

function mappedCall(row) {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    providerCallId: row.provider_call_id,
    agentId: row.agent_id,
    from: row.from_number,
    to: row.to_number,
    direction: row.direction,
    status: row.status,
    providerMetadata: row.provider_metadata ?? {},
    created: false,
  });
}

export function createBrowserTestSession(auth, agentId, input = {}, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  const now = dependencies.now?.() ?? new Date();
  return contextRunner(auth, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      [auth.tenantId, 'browser-test-sessions']);
    const agent = await client.query(`SELECT id,name,status,usage_direction
      FROM voice_agents
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL FOR SHARE`,
    [auth.tenantId, auth.workspaceId, agentId]);
    if (!agent.rowCount) {
      throw new AppError(404, 'Agent was not found in the active tenant workspace',
        'BROWSER_TEST_AGENT_NOT_FOUND');
    }
    if (agent.rows[0].status !== 'active') {
      throw new AppError(409, 'Only an active agent can start a browser test',
        'BROWSER_TEST_AGENT_INACTIVE');
    }
    const supported = agent.rows[0].usage_direction;
    const direction = input.direction ?? (supported === 'outbound' ? 'outbound' : 'inbound');
    if (supported !== 'both' && supported !== direction) {
      throw new AppError(409, 'The requested test direction is not enabled for this agent',
        'BROWSER_TEST_DIRECTION_UNAVAILABLE');
    }
    await client.query(`UPDATE call_sessions
      SET status='failed',ended_at=now(),duration_seconds=0,
          provider_metadata=provider_metadata||'{"browserTest":{"expired":true}}'::jsonb
      WHERE tenant_id=$1 AND status IN ('ringing','connected') AND ended_at IS NULL
        AND provider_metadata->>'source'=$2
        AND (provider_metadata->'browserTest'->>'expiresAt')::timestamptz <= now()`,
    [auth.tenantId, browserSource]);
    const active = await client.query(`SELECT count(*)::int AS count FROM call_sessions
      WHERE tenant_id=$1 AND status IN ('ringing','connected') AND ended_at IS NULL
        AND provider_metadata->>'source'=$2`, [auth.tenantId, browserSource]);
    const limit = dependencies.concurrencyLimit ?? env.BROWSER_TEST_MAX_CONCURRENT_PER_TENANT;
    if (active.rows[0].count >= limit) {
      throw new AppError(429, 'Company browser-test concurrency limit has been reached',
        'BROWSER_TEST_CONCURRENCY_LIMIT', { limit });
    }
    const callId = crypto.randomUUID();
    const nonce = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime()
      + (dependencies.maximumSeconds ?? env.BROWSER_TEST_SESSION_MAX_SECONDS) * 1000);
    const providerCallId = `browser-test-${callId}`;
    const metadata = {
      source: browserSource,
      browserTest: {
        version: 1,
        testCallId: callId,
        userId: auth.userId,
        tokenNonceHash: hashBrowserTestNonce(nonce),
        expiresAt: expiresAt.toISOString(),
        connectedAt: null,
        inputFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        outputFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    };
    const inserted = await client.query(`INSERT INTO call_sessions
      (id,tenant_id,workspace_id,provider_call_id,agent_id,agent_name,
       from_number,to_number,direction,status,ringing_at,answered_at,provider_metadata,
       reserved_credits,credits_charged,credit_billing_finalized)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ringing',$10,NULL,$11::jsonb,0,0,true)
      RETURNING *`, [
      callId, auth.tenantId, auth.workspaceId, providerCallId, agentId, agent.rows[0].name,
      direction === 'inbound' ? browserFrom : browserTo,
      direction === 'inbound' ? browserTo : browserFrom,
      direction, now, JSON.stringify(metadata),
    ]);
    const token = (dependencies.createToken ?? createBrowserTestMediaToken)({
      callId, testCallId: callId, tenantId: auth.tenantId, workspaceId: auth.workspaceId,
      agentId, userId: auth.userId, nonce,
    }, dependencies.tokenOptions ?? {});
    return publicSession(inserted.rows[0], token);
  });
}

export function claimBrowserTestMediaSession(callId, claims, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const nonceHash = hashBrowserTestNonce(claims.nonce);
    const result = await client.query(`UPDATE call_sessions
      SET status='connected',answered_at=COALESCE(answered_at,now()),
          provider_metadata=jsonb_set(provider_metadata,'{browserTest,connectedAt}',to_jsonb(now()),true)
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND agent_id=$4
        AND status='ringing' AND ended_at IS NULL
        AND provider_metadata->>'source'=$5
        AND provider_metadata->'browserTest'->>'testCallId'=$1::text
        AND provider_metadata->'browserTest'->>'userId'=$6
        AND provider_metadata->'browserTest'->>'tokenNonceHash'=$7
        AND provider_metadata->'browserTest'->>'connectedAt' IS NULL
        AND (provider_metadata->'browserTest'->>'expiresAt')::timestamptz > now()
      RETURNING *`, [
      callId, claims.tenantId, claims.workspaceId, claims.agentId,
      browserSource, claims.userId, nonceHash,
    ]);
    if (!result.rowCount) {
      throw new AppError(409, 'Browser test session is unavailable, expired, or already connected',
        'BROWSER_TEST_SESSION_UNAVAILABLE');
    }
    return mappedCall(result.rows[0]);
  });
}

export function endBrowserTestSession(auth, agentId, testCallId, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  const sessionStore = dependencies.sessionStore ?? activeCallSessions;
  return contextRunner(auth, async (client) => {
    const selected = await client.query(`SELECT * FROM call_sessions
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND agent_id=$4
        AND provider_metadata->>'source'=$5 FOR UPDATE`,
    [testCallId, auth.tenantId, auth.workspaceId, agentId, browserSource]);
    if (!selected.rowCount) {
      throw new AppError(404, 'Browser test session was not found', 'BROWSER_TEST_SESSION_NOT_FOUND');
    }
    const activeSession = sessionStore.get(testCallId, { touch: false });
    if (activeSession?.transport === browserSource) {
      activeSession.close(1000, 'browser test ended by user');
      return publicSession(selected.rows[0]);
    }
    const ended = await client.query(`UPDATE call_sessions
      SET status=CASE WHEN ended_at IS NULL THEN 'canceled'::call_status ELSE status END,
          ended_at=COALESCE(ended_at,now()),
          duration_seconds=CASE WHEN ended_at IS NULL
            THEN GREATEST(duration_seconds,floor(extract(epoch FROM (now()-COALESCE(answered_at,started_at))))::int)
            ELSE duration_seconds END,
          credit_billing_finalized=true,reserved_credits=0,credits_charged=0,
          provider_metadata=provider_metadata||'{"browserTest":{"endedByUser":true}}'::jsonb
      WHERE id=$1 RETURNING *`, [testCallId]);
    return publicSession(ended.rows[0]);
  });
}

export async function finalizeBrowserTestBilling(client, { call }) {
  await client.query(`UPDATE call_sessions
    SET reserved_credits=0,credits_charged=0,credit_billing_finalized=true,
        provider_metadata=provider_metadata||'{"browserTestBilling":{"billable":false,"finalized":true}}'::jsonb
    WHERE id=$1`, [call.id]);
  return { idempotent: call.credit_billing_finalized === true, creditsCharged: 0 };
}
