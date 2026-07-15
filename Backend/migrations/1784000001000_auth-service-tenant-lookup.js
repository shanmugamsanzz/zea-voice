export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE POLICY tenants_auth_service_select_policy
      ON tenants
      FOR SELECT
      TO zea_voice_runtime
      USING (zea_is_auth_service());

    CREATE POLICY workspaces_auth_service_select_policy
      ON workspaces
      FOR SELECT
      TO zea_voice_runtime
      USING (zea_is_auth_service());
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP POLICY IF EXISTS workspaces_auth_service_select_policy ON workspaces;
    DROP POLICY IF EXISTS tenants_auth_service_select_policy ON tenants;
  `);
}
