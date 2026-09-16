export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql('ALTER TABLE browser_test_share_links ALTER COLUMN expires_at DROP NOT NULL;');
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM browser_test_share_links WHERE expires_at IS NULL;
    ALTER TABLE browser_test_share_links ALTER COLUMN expires_at SET NOT NULL;
  `);
}
