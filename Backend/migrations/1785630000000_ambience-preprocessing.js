export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE company_ambience_assets
      ADD COLUMN normalized_storage_version_id varchar(255),
      ADD COLUMN normalized_storage_etag varchar(255),
      ADD COLUMN normalized_size_bytes bigint,
      ADD COLUMN normalized_at timestamptz;

    COMMENT ON COLUMN company_ambience_assets.normalized_object_key IS
      'Private raw 8 kHz mono mu-law object used directly by the real-time Plivo ambience mixer.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE company_ambience_assets
      DROP COLUMN IF EXISTS normalized_at,
      DROP COLUMN IF EXISTS normalized_size_bytes,
      DROP COLUMN IF EXISTS normalized_storage_etag,
      DROP COLUMN IF EXISTS normalized_storage_version_id;
  `);
}
