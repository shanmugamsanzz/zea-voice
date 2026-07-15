import { database } from './database.js';
import { measureSql } from '../performance/performance-context.js';
import { logger } from '../config/logger.js';

const falseString = 'false';

export async function withDatabaseContext(context, operation) {
  const client = await database.connect();
  let connectionError = null;
  const handleConnectionError = (error) => {
    connectionError = error;
    logger.error({ err: error }, 'Checked-out PostgreSQL connection failed');
  };
  // pg-pool removes its idle error listener while a client is checked out.
  // Without an application listener, a transient socket failure becomes an
  // unhandled EventEmitter error and terminates the entire Node.js process.
  client.on('error', handleConnectionError);
  const measuredClient = Object.create(client);
  measuredClient.query = (query, values) => {
    const text = typeof query === 'string' ? query : query?.text;
    const queryName = String(text ?? 'query').trim().split(/\s+/, 1)[0]?.toUpperCase() || 'QUERY';
    return measureSql(() => client.query(query, values), queryName);
  };

  try {
    await measuredClient.query('BEGIN');
    await measuredClient.query(
      `SELECT
        set_config('app.current_tenant_id', $1, true),
        set_config('app.current_user_id', $2, true),
        set_config('app.is_platform_admin', $3, true),
        set_config('app.is_auth_service', $4, true),
        set_config('app.can_manage_users', $5, true)`,
      [
        context.tenantId ?? '',
        context.userId ?? '',
        context.isPlatformAdmin ? 'true' : falseString,
        context.isAuthService ? 'true' : falseString,
        context.canManageUsers ? 'true' : falseString,
      ],
    );

    const result = await operation(measuredClient);
    await measuredClient.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await measuredClient.query('ROLLBACK');
    } catch (rollbackError) {
      logger.warn({ err: rollbackError }, 'PostgreSQL transaction rollback could not be completed');
    }
    throw error;
  } finally {
    client.removeListener('error', handleConnectionError);
    // Passing the connection error tells pg-pool to destroy this client rather
    // than returning a broken socket to the idle pool.
    client.release(connectionError ?? undefined);
  }
}

export function withAuthServiceContext(operation) {
  return withDatabaseContext({ isAuthService: true }, operation);
}

export function withPlatformAdminContext(userId, operation) {
  return withDatabaseContext({ userId, isPlatformAdmin: true, canManageUsers: true }, operation);
}

export function withParallelPlatformAdminContext(userId, operations) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 5) {
    throw new Error('Parallel platform query groups must contain between 1 and 5 operations');
  }
  return Promise.all(operations.map((operation) => withPlatformAdminContext(userId, operation)));
}

export function withTenantContext(auth, operation) {
  return withDatabaseContext({
    tenantId: auth.tenantId,
    userId: auth.userId,
    isPlatformAdmin: auth.role === 'SUPER_ADMIN',
    canManageUsers: auth.role === 'SUPER_ADMIN' || auth.role === 'COMPANY_DEVELOPER',
  }, operation);
}
