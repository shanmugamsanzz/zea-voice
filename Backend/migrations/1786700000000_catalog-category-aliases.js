export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE structured_items
      ADD COLUMN category_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT structured_items_category_aliases_array
        CHECK (jsonb_typeof(category_aliases) = 'array');

    CREATE INDEX structured_items_category_aliases_gin_idx
      ON structured_items USING gin (category_aliases jsonb_path_ops);

    COMMENT ON COLUMN structured_items.category_aliases IS
      'Tenant-defined aliases for the Catalog category associated with this item.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS structured_items_category_aliases_gin_idx;
    ALTER TABLE structured_items
      DROP CONSTRAINT IF EXISTS structured_items_category_aliases_array,
      DROP COLUMN IF EXISTS category_aliases;
  `);
}
