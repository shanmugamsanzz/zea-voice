export async function up(pgm) {
  // NULL preserves all existing role-based access; [] explicitly grants no tabs.
  pgm.sql(`ALTER TABLE tenant_memberships ADD COLUMN tab_access jsonb
    CHECK (tab_access IS NULL OR jsonb_typeof(tab_access) = 'array');`);
}
export async function down(pgm) {
  pgm.sql('ALTER TABLE tenant_memberships DROP COLUMN tab_access');
}
