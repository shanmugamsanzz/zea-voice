export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE pronunciation_group_status AS ENUM ('active', 'inactive', 'archived');
    CREATE TYPE pronunciation_match_type AS ENUM ('exact', 'whole_word');

    CREATE TABLE pronunciation_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(160) NOT NULL,
      language varchar(35) NOT NULL DEFAULT 'und',
      status pronunciation_group_status NOT NULL DEFAULT 'active',
      description varchar(1000),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT pronunciation_groups_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT pronunciation_groups_language_not_blank CHECK (btrim(language) <> ''),
      CONSTRAINT pronunciation_groups_tenant_id_id_unique UNIQUE (tenant_id, id)
    );

    CREATE UNIQUE INDEX pronunciation_groups_tenant_name_unique_idx
      ON pronunciation_groups (tenant_id, lower(name))
      WHERE deleted_at IS NULL;
    CREATE INDEX pronunciation_groups_tenant_status_idx
      ON pronunciation_groups (tenant_id, status, updated_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE pronunciation_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      group_id uuid NOT NULL,
      source_text varchar(500) NOT NULL,
      spoken_text varchar(500) NOT NULL,
      match_type pronunciation_match_type NOT NULL DEFAULT 'whole_word',
      case_sensitive boolean NOT NULL DEFAULT false,
      priority integer NOT NULL DEFAULT 100,
      enabled boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT pronunciation_rules_group_tenant_fk
        FOREIGN KEY (tenant_id, group_id)
        REFERENCES pronunciation_groups(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT pronunciation_rules_source_not_blank CHECK (btrim(source_text) <> ''),
      CONSTRAINT pronunciation_rules_spoken_not_blank CHECK (btrim(spoken_text) <> ''),
      CONSTRAINT pronunciation_rules_priority_range CHECK (priority BETWEEN 0 AND 10000),
      CONSTRAINT pronunciation_rules_tenant_group_id_unique
        UNIQUE (tenant_id, group_id, id)
    );

    CREATE UNIQUE INDEX pronunciation_rules_group_source_unique_idx
      ON pronunciation_rules (
        tenant_id,
        group_id,
        (CASE WHEN case_sensitive THEN source_text ELSE lower(source_text) END),
        match_type
      )
      WHERE deleted_at IS NULL;
    CREATE INDEX pronunciation_rules_group_priority_idx
      ON pronunciation_rules (tenant_id, group_id, enabled, priority, created_at)
      WHERE deleted_at IS NULL;

    CREATE TRIGGER pronunciation_groups_set_updated_at
      BEFORE UPDATE ON pronunciation_groups
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER pronunciation_rules_set_updated_at
      BEFORE UPDATE ON pronunciation_rules
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE pronunciation_groups ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pronunciation_groups FORCE ROW LEVEL SECURITY;
    ALTER TABLE pronunciation_rules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pronunciation_rules FORCE ROW LEVEL SECURITY;

    CREATE POLICY pronunciation_groups_isolation_policy
      ON pronunciation_groups FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());
    CREATE POLICY pronunciation_rules_isolation_policy
      ON pronunciation_rules FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    GRANT USAGE ON TYPE pronunciation_group_status, pronunciation_match_type
      TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON pronunciation_groups, pronunciation_rules
      TO zea_voice_runtime;

    COMMENT ON TABLE pronunciation_groups IS
      'Company-isolated reusable pronunciation and punctuation rule groups for TTS agents.';
    COMMENT ON TABLE pronunciation_rules IS
      'Ordered written-to-spoken substitutions belonging to a pronunciation group in the same company.';
    COMMENT ON COLUMN pronunciation_groups.language IS
      'BCP 47 language tag such as ta-IN or en-US; und means language-neutral.';
    COMMENT ON COLUMN pronunciation_rules.source_text IS
      'Text produced by the LLM that should be matched before TTS synthesis.';
    COMMENT ON COLUMN pronunciation_rules.spoken_text IS
      'Provider-independent spoken replacement passed only to TTS synthesis.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS pronunciation_rules;
    DROP TABLE IF EXISTS pronunciation_groups;
    DROP TYPE IF EXISTS pronunciation_match_type;
    DROP TYPE IF EXISTS pronunciation_group_status;
  `);
}
