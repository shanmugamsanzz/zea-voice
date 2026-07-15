export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE ai_providers
      DROP CONSTRAINT IF EXISTS ai_providers_name_unique,
      DROP CONSTRAINT IF EXISTS ai_providers_slug_unique;

    CREATE UNIQUE INDEX ai_providers_active_name_unique
      ON ai_providers (name)
      WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX ai_providers_active_slug_unique
      ON ai_providers (slug)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS ai_providers_active_name_unique;
    DROP INDEX IF EXISTS ai_providers_active_slug_unique;

    UPDATE ai_providers
    SET name = left(name, 115) || ' [deleted ' || left(id::text, 8) || ']',
        slug = left(slug, 80) || '-deleted-' || left(replace(id::text, '-', ''), 8)
    WHERE deleted_at IS NOT NULL;

    ALTER TABLE ai_providers
      ADD CONSTRAINT ai_providers_name_unique UNIQUE (name),
      ADD CONSTRAINT ai_providers_slug_unique UNIQUE (slug);
  `);
}
