export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE ambience_asset_status AS ENUM ('active', 'inactive', 'archived');
    CREATE TYPE ambience_storage_status AS ENUM ('pending', 'ready', 'failed');

    CREATE TABLE company_ambience_assets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL,
      name varchar(160) NOT NULL,
      description varchar(1000),
      status ambience_asset_status NOT NULL DEFAULT 'active',
      storage_status ambience_storage_status NOT NULL DEFAULT 'pending',
      original_file_name varchar(255),
      object_key varchar(1000),
      normalized_object_key varchar(1000),
      mime_type varchar(100),
      size_bytes bigint,
      duration_ms integer,
      checksum_sha256 char(64),
      audio_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      listening_volume_percent smallint NOT NULL DEFAULT 10,
      speaking_volume_percent smallint NOT NULL DEFAULT 5,
      continue_during_silence boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT company_ambience_assets_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT company_ambience_assets_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT company_ambience_assets_size_valid CHECK (size_bytes IS NULL OR size_bytes > 0),
      CONSTRAINT company_ambience_assets_duration_valid CHECK (duration_ms IS NULL OR duration_ms > 0),
      CONSTRAINT company_ambience_assets_listening_volume_range
        CHECK (listening_volume_percent BETWEEN 0 AND 100),
      CONSTRAINT company_ambience_assets_speaking_volume_range
        CHECK (speaking_volume_percent BETWEEN 0 AND 100),
      CONSTRAINT company_ambience_assets_checksum_format
        CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT company_ambience_assets_tenant_workspace_id_unique
        UNIQUE (tenant_id, workspace_id, id)
    );

    CREATE UNIQUE INDEX company_ambience_assets_workspace_name_unique_idx
      ON company_ambience_assets (tenant_id, workspace_id, lower(name))
      WHERE deleted_at IS NULL;
    CREATE INDEX company_ambience_assets_workspace_status_idx
      ON company_ambience_assets (tenant_id, workspace_id, status, updated_at DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX company_ambience_assets_storage_status_idx
      ON company_ambience_assets (storage_status, updated_at)
      WHERE deleted_at IS NULL AND storage_status <> 'ready';

    CREATE TRIGGER company_ambience_assets_set_updated_at
      BEFORE UPDATE ON company_ambience_assets
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE company_ambience_assets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE company_ambience_assets FORCE ROW LEVEL SECURITY;

    CREATE POLICY company_ambience_assets_isolation_policy
      ON company_ambience_assets FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT USAGE ON TYPE ambience_asset_status, ambience_storage_status TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON company_ambience_assets TO zea_voice_runtime;

    COMMENT ON TABLE company_ambience_assets IS
      'Workspace-isolated ambience audio metadata owned by one company; private B2 objects are attached in the storage task.';
    COMMENT ON COLUMN company_ambience_assets.object_key IS
      'Private tenant-scoped source object key. Never return this value from public company APIs.';
    COMMENT ON COLUMN company_ambience_assets.normalized_object_key IS
      'Private provider-ready normalized audio object key created by the preprocessing worker.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS company_ambience_assets;
    DROP TYPE IF EXISTS ambience_storage_status;
    DROP TYPE IF EXISTS ambience_asset_status;
  `);
}
