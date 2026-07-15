import { z } from 'zod';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

const uuid = z.string().uuid();

export async function requireTenantContext(request, _response, next) {
  try {
    if (!request.auth) throw new AppError(401, 'Authentication is required', 'UNAUTHENTICATED');

    const requestedTenantId = request.headers['x-tenant-id']?.toString();
    const requestedWorkspaceId = request.headers['x-workspace-id']?.toString();

    if (requestedTenantId && !uuid.safeParse(requestedTenantId).success) {
      throw new AppError(400, 'x-tenant-id must be a UUID', 'INVALID_TENANT_ID');
    }
    if (requestedWorkspaceId && !uuid.safeParse(requestedWorkspaceId).success) {
      throw new AppError(400, 'x-workspace-id must be a UUID', 'INVALID_WORKSPACE_ID');
    }

    if (request.auth.role === 'SUPER_ADMIN') {
      if (!requestedTenantId || !requestedWorkspaceId) {
        throw new AppError(400, 'Super Admin tenant routes require x-tenant-id and x-workspace-id', 'TENANT_CONTEXT_REQUIRED');
      }
      const exists = await withPlatformAdminContext(request.auth.userId, async (client) => {
        const result = await client.query(
          `SELECT 1
           FROM workspaces w
           JOIN tenants t ON t.id = w.tenant_id
           WHERE w.id = $1 AND w.tenant_id = $2
             AND w.status = 'active' AND w.deleted_at IS NULL
             AND t.status = 'active' AND t.deleted_at IS NULL`,
          [requestedWorkspaceId, requestedTenantId],
        );
        return result.rowCount === 1;
      });
      if (!exists) throw new AppError(404, 'Tenant workspace was not found', 'WORKSPACE_NOT_FOUND');
      request.tenant = { tenantId: requestedTenantId, workspaceId: requestedWorkspaceId };
      next();
      return;
    }

    if (!request.auth.tenantId || !request.auth.workspaceId) {
      throw new AppError(403, 'No active company membership was found', 'NO_ACTIVE_MEMBERSHIP');
    }
    if (requestedTenantId && requestedTenantId !== request.auth.tenantId) {
      throw new AppError(403, 'Cross-tenant access is not allowed', 'TENANT_ACCESS_DENIED');
    }
    if (requestedWorkspaceId && requestedWorkspaceId !== request.auth.workspaceId) {
      throw new AppError(403, 'Workspace access is not allowed', 'WORKSPACE_ACCESS_DENIED');
    }

    const workspaceActive = await withTenantContext(request.auth, async (client) => {
      const result = await client.query(
        `SELECT 1 FROM workspaces
         WHERE id = $1 AND tenant_id = $2
           AND status = 'active' AND deleted_at IS NULL`,
        [request.auth.workspaceId, request.auth.tenantId],
      );
      return result.rowCount === 1;
    });
    if (!workspaceActive) throw new AppError(403, 'Workspace is not active', 'WORKSPACE_INACTIVE');

    request.tenant = {
      tenantId: request.auth.tenantId,
      workspaceId: request.auth.workspaceId,
    };
    next();
  } catch (error) {
    next(error);
  }
}
