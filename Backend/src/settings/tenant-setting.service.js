import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

export function getTenantIdentitySettings(auth) {
  return withTenantContext(auth, async (client) => {
    const result = await client.query(
      "SELECT tenant.id AS tenant_id, organization.id AS organization_id, "
      + "organization.name AS organization_name, workspace.id AS workspace_id, "
      + "workspace.name AS workspace_name, organization.first_name, "
      + "organization.last_name, organization.primary_email "
      + "FROM tenants tenant "
      + "JOIN workspaces workspace ON workspace.tenant_id = tenant.id "
      + "AND workspace.id = $2 AND workspace.deleted_at IS NULL "
      + "JOIN organizations organization ON organization.tenant_id = tenant.id "
      + "AND organization.id = workspace.organization_id AND organization.deleted_at IS NULL "
      + "WHERE tenant.id = $1 AND tenant.deleted_at IS NULL",
      [auth.tenantId, auth.workspaceId],
    );
    if (!result.rowCount) {
      throw new AppError(404, 'Company workspace identity was not found', 'TENANT_IDENTITY_NOT_FOUND');
    }
    const row = result.rows[0];
    return {
      fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
      emailAddress: row.primary_email,
      organizationName: row.organization_name,
      workspaceName: row.workspace_name,
      organizationId: row.organization_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
    };
  });
}
