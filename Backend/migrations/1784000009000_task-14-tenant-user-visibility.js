export const shorthands = undefined;
export async function up(pgm) { pgm.sql(`
  DROP POLICY users_select_policy ON users;
  CREATE POLICY users_select_policy ON users FOR SELECT TO zea_voice_runtime USING (
    zea_is_platform_admin() OR zea_is_auth_service() OR id=zea_current_user_id()
    OR (zea_can_manage_users() AND EXISTS (
      SELECT 1 FROM tenant_memberships m
      WHERE m.user_id=users.id AND m.tenant_id=zea_current_tenant_id() AND m.deleted_at IS NULL
    ))
  );
`); }
export async function down(pgm) { pgm.sql(`
  DROP POLICY users_select_policy ON users;
  CREATE POLICY users_select_policy ON users FOR SELECT TO zea_voice_runtime
    USING (zea_is_platform_admin() OR zea_is_auth_service() OR id=zea_current_user_id());
`); }
