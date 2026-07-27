export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE company_ambience_assets
      ADD COLUMN storage_version_id varchar(255),
      ADD COLUMN storage_etag varchar(255),
      ADD COLUMN storage_error_code varchar(100),
      ADD COLUMN storage_error_message varchar(1000),
      ADD COLUMN upload_token uuid,
      ADD COLUMN uploaded_at timestamptz;

    CREATE UNIQUE INDEX company_ambience_assets_workspace_checksum_unique_idx
      ON company_ambience_assets (tenant_id, workspace_id, checksum_sha256)
      WHERE deleted_at IS NULL AND checksum_sha256 IS NOT NULL;

    COMMENT ON COLUMN company_ambience_assets.storage_version_id IS
      'Private Backblaze B2 version identifier retained for exact cleanup; never exposed by company APIs.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS company_ambience_assets_workspace_checksum_unique_idx;
    ALTER TABLE company_ambience_assets
      DROP COLUMN IF EXISTS uploaded_at,
      DROP COLUMN IF EXISTS storage_error_message,
      DROP COLUMN IF EXISTS storage_error_code,
      DROP COLUMN IF EXISTS upload_token,
      DROP COLUMN IF EXISTS storage_etag,
      DROP COLUMN IF EXISTS storage_version_id;
  `);
}
