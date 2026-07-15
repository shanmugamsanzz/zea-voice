import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { performDummyPasswordCheck, verifyPassword } from './password.js';
import { generateOpaqueToken, hashToken } from './tokens.js';

const ACCESS_TOKEN_TYPE = 'Bearer';

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function roleFor(user, membership) {
  if (user.platform_role === 'super_admin') return 'SUPER_ADMIN';
  if (membership?.role === 'company_developer') return 'COMPANY_DEVELOPER';
  return 'COMPANY_USER';
}

function publicUser(user, membership) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    role: roleFor(user, membership),
    tenantId: membership?.tenant_id ?? null,
    workspaceId: membership?.workspace_id ?? null,
  };
}

function createTokenPair(now = new Date()) {
  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  return {
    accessToken,
    refreshToken,
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    accessExpiresAt: addMinutes(now, env.ACCESS_TOKEN_TTL_MINUTES),
    refreshExpiresAt: addDays(now, env.REFRESH_TOKEN_TTL_DAYS),
  };
}

async function selectMembership(client, user, tenantId) {
  if (user.platform_role === 'super_admin') return { membership: null };

  const memberships = await client.query(
    `SELECT m.id, m.tenant_id, m.workspace_id, m.role, m.status,
            t.name AS tenant_name, w.name AS workspace_name
     FROM tenant_memberships m
     JOIN tenants t ON t.id = m.tenant_id
     JOIN workspaces w ON w.id = m.workspace_id AND w.tenant_id = m.tenant_id
     WHERE m.user_id = $1
       AND m.status = 'active'
       AND m.deleted_at IS NULL
       AND t.status = 'active'
       AND t.deleted_at IS NULL
       AND w.status = 'active'
       AND w.deleted_at IS NULL
     ORDER BY m.created_at`,
    [user.id],
  );

  if (memberships.rowCount === 0) {
    return { error: 'NO_ACTIVE_MEMBERSHIP' };
  }

  if (tenantId) {
    const membership = memberships.rows.find((item) => item.tenant_id === tenantId);
    return membership ? { membership } : { error: 'TENANT_ACCESS_DENIED' };
  }

  if (memberships.rowCount > 1) {
    return {
      error: 'TENANT_SELECTION_REQUIRED',
      tenants: memberships.rows.map((item) => ({
        tenantId: item.tenant_id,
        tenantName: item.tenant_name,
        workspaceId: item.workspace_id,
        workspaceName: item.workspace_name,
      })),
    };
  }

  return { membership: memberships.rows[0] };
}

export async function login({ email, password, tenantId, ipAddress, userAgent }) {
  const outcome = await withAuthServiceContext(async (client) => {
    const userResult = await client.query(
      `SELECT id, email::text, password_hash, first_name, last_name, status,
              platform_role, failed_login_attempts, locked_until
       FROM users
       WHERE email = $1 AND deleted_at IS NULL
       LIMIT 1
       FOR UPDATE`,
      [email],
    );

    if (userResult.rowCount === 0) {
      await performDummyPasswordCheck(password);
      return { error: 'INVALID_CREDENTIALS' };
    }

    const user = userResult.rows[0];
    const now = new Date();

    if (user.status !== 'active') return { error: 'ACCOUNT_INACTIVE' };
    if (user.locked_until && new Date(user.locked_until) > now) {
      return { error: 'ACCOUNT_LOCKED', lockedUntil: user.locked_until };
    }

    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      const attempts = user.failed_login_attempts + 1;
      const lockedUntil = attempts >= env.LOGIN_MAX_ATTEMPTS
        ? addMinutes(now, env.LOGIN_LOCK_MINUTES)
        : null;
      await client.query(
        `UPDATE users
         SET failed_login_attempts = $2, locked_until = $3
         WHERE id = $1`,
        [user.id, attempts, lockedUntil],
      );
      await client.query(
        `INSERT INTO audit_logs
          (actor_user_id, actor_type, action, entity_type, entity_id, outcome, ip_address, user_agent)
         VALUES ($1::uuid, 'user', 'AUTH_LOGIN_FAILED', 'user', $1::uuid::text, 'failure', $2, $3)`,
        [user.id, ipAddress, userAgent],
      );
      return { error: 'INVALID_CREDENTIALS' };
    }

    const membershipResult = await selectMembership(client, user, tenantId);
    if (membershipResult.error) return membershipResult;

    const membership = membershipResult.membership;
    const tokens = createTokenPair(now);
    const sessionResult = await client.query(
      `INSERT INTO auth_sessions
        (user_id, membership_id, tenant_id, workspace_id,
         access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at,
         ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        user.id,
        membership?.id ?? null,
        membership?.tenant_id ?? null,
        membership?.workspace_id ?? null,
        tokens.accessTokenHash,
        tokens.refreshTokenHash,
        tokens.accessExpiresAt,
        tokens.refreshExpiresAt,
        ipAddress,
        userAgent,
      ],
    );

    await client.query(
      `UPDATE users
       SET failed_login_attempts = 0, locked_until = NULL, last_login_at = $2
       WHERE id = $1`,
      [user.id, now],
    );
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, outcome, ip_address, user_agent)
       VALUES ($1, $2, $3, 'user', 'AUTH_LOGIN_SUCCEEDED',
               'auth_session', $4, 'success', $5, $6)`,
      [membership?.tenant_id ?? null, membership?.workspace_id ?? null,
        user.id, sessionResult.rows[0].id, ipAddress, userAgent],
    );

    return {
      sessionId: sessionResult.rows[0].id,
      tokenType: ACCESS_TOKEN_TYPE,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      user: publicUser(user, membership),
    };
  });

  if (outcome.error === 'INVALID_CREDENTIALS') {
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (outcome.error === 'ACCOUNT_INACTIVE') {
    throw new AppError(403, 'This account is not active', 'ACCOUNT_INACTIVE');
  }
  if (outcome.error === 'ACCOUNT_LOCKED') {
    throw new AppError(423, 'This account is temporarily locked', 'ACCOUNT_LOCKED', {
      lockedUntil: outcome.lockedUntil,
    });
  }
  if (outcome.error === 'NO_ACTIVE_MEMBERSHIP') {
    throw new AppError(403, 'No active company membership was found', 'NO_ACTIVE_MEMBERSHIP');
  }
  if (outcome.error === 'TENANT_ACCESS_DENIED') {
    throw new AppError(403, 'You do not have access to the selected company', 'TENANT_ACCESS_DENIED');
  }
  if (outcome.error === 'TENANT_SELECTION_REQUIRED') {
    throw new AppError(409, 'Select a company to continue', 'TENANT_SELECTION_REQUIRED', {
      tenants: outcome.tenants,
    });
  }

  return outcome;
}

export async function authenticateAccessToken(accessToken) {
  const accessTokenHash = hashToken(accessToken);
  const auth = await withAuthServiceContext(async (client) => {
    const result = await client.query(
      `SELECT s.id AS session_id, s.user_id, s.membership_id, s.tenant_id,
              s.workspace_id, s.access_expires_at, s.refresh_expires_at,
              u.email::text, u.first_name, u.last_name, u.status AS user_status,
              u.platform_role, m.role AS membership_role, m.status AS membership_status
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       CROSS JOIN platform_settings ps
       LEFT JOIN tenant_memberships m ON m.id = s.membership_id
       WHERE s.access_token_hash = $1
         AND s.revoked_at IS NULL
         AND s.created_at + make_interval(secs => ps.max_session_timeout_seconds) > now()
       LIMIT 1`,
      [accessTokenHash],
    );

    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (row.user_status !== 'active') return null;
    if (row.membership_id && row.membership_status !== 'active') return null;
    if (new Date(row.access_expires_at) <= new Date()) return null;

    await client.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [row.session_id]);
    return {
      authType: 'session',
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.platform_role === 'super_admin'
        ? 'SUPER_ADMIN'
        : row.membership_role === 'company_developer'
          ? 'COMPANY_DEVELOPER'
          : 'COMPANY_USER',
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
    };
  });

  if (!auth) throw new AppError(401, 'Authentication is required', 'UNAUTHENTICATED');
  return auth;
}

export async function refreshSession(refreshToken, { ipAddress, userAgent }) {
  const refreshTokenHash = hashToken(refreshToken);
  const outcome = await withAuthServiceContext(async (client) => {
    const result = await client.query(
      `SELECT s.*, u.status AS user_status, u.platform_role,
              u.email::text, u.first_name, u.last_name,
              m.role AS membership_role, m.status AS membership_status
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       CROSS JOIN platform_settings ps
       LEFT JOIN tenant_memberships m ON m.id = s.membership_id
       WHERE s.refresh_token_hash = $1
         AND s.created_at + make_interval(secs => ps.max_session_timeout_seconds) > now()
       LIMIT 1
       FOR UPDATE OF s`,
      [refreshTokenHash],
    );

    if (result.rowCount === 0) return null;
    const session = result.rows[0];
    if (session.revoked_at || new Date(session.refresh_expires_at) <= new Date()) return null;
    if (session.user_status !== 'active') return null;
    if (session.membership_id && session.membership_status !== 'active') return null;

    const tokens = createTokenPair();
    await client.query(
      `UPDATE auth_sessions
       SET access_token_hash = $2,
           refresh_token_hash = $3,
           access_expires_at = $4,
           refresh_expires_at = $5,
           last_used_at = now(),
           ip_address = $6,
           user_agent = $7
       WHERE id = $1`,
      [session.id, tokens.accessTokenHash, tokens.refreshTokenHash,
        tokens.accessExpiresAt, tokens.refreshExpiresAt, ipAddress, userAgent],
    );

    return {
      sessionId: session.id,
      tokenType: ACCESS_TOKEN_TYPE,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      user: {
        id: session.user_id,
        email: session.email,
        firstName: session.first_name,
        lastName: session.last_name,
        role: session.platform_role === 'super_admin'
          ? 'SUPER_ADMIN'
          : session.membership_role === 'company_developer'
            ? 'COMPANY_DEVELOPER'
            : 'COMPANY_USER',
        tenantId: session.tenant_id,
        workspaceId: session.workspace_id,
      },
    };
  });

  if (!outcome) throw new AppError(401, 'Refresh session is invalid or expired', 'INVALID_REFRESH_TOKEN');
  return outcome;
}

export async function logoutSession({ accessToken, refreshToken }) {
  const accessHash = accessToken ? hashToken(accessToken) : null;
  const refreshHash = refreshToken ? hashToken(refreshToken) : null;
  if (!accessHash && !refreshHash) return;

  await withAuthServiceContext((client) => client.query(
    `UPDATE auth_sessions
     SET revoked_at = now(), revoke_reason = 'user_logout'
     WHERE revoked_at IS NULL
       AND (($1::text IS NOT NULL AND access_token_hash = $1)
         OR ($2::text IS NOT NULL AND refresh_token_hash = $2))`,
    [accessHash, refreshHash],
  ));
}
