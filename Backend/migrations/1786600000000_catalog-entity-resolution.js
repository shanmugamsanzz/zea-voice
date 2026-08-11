export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE structured_items
      ADD COLUMN category varchar(240),
      ADD COLUMN aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT structured_items_category_not_blank
        CHECK (category IS NULL OR btrim(category) <> ''),
      ADD CONSTRAINT structured_items_aliases_array
        CHECK (jsonb_typeof(aliases) = 'array');

    CREATE INDEX structured_items_category_lookup_idx
      ON structured_items (tenant_id, knowledge_base_id, lower(category))
      WHERE category IS NOT NULL AND status <> 'archived';

    CREATE INDEX structured_items_aliases_gin_idx
      ON structured_items USING gin (aliases jsonb_path_ops);

    COMMENT ON COLUMN structured_items.category IS
      'Optional tenant-defined Catalog category used by the generic entity resolver.';
    COMMENT ON COLUMN structured_items.aliases IS
      'Tenant-defined spoken or written aliases indexed with the canonical Catalog item name.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS structured_items_aliases_gin_idx;
    DROP INDEX IF EXISTS structured_items_category_lookup_idx;
    ALTER TABLE structured_items
      DROP CONSTRAINT IF EXISTS structured_items_aliases_array,
      DROP CONSTRAINT IF EXISTS structured_items_category_not_blank,
      DROP COLUMN IF EXISTS aliases,
      DROP COLUMN IF EXISTS category;
  `);
}
