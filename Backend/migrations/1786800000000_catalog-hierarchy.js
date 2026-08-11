export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE structured_items
      ADD COLUMN category_key varchar(160),
      ADD COLUMN parent_category_key varchar(160),
      ADD COLUMN category_description text,
      ADD COLUMN category_selection_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN relationships jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN selection_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD CONSTRAINT structured_items_category_key_not_blank
        CHECK (category_key IS NULL OR btrim(category_key) <> ''),
      ADD CONSTRAINT structured_items_parent_category_key_not_blank
        CHECK (parent_category_key IS NULL OR btrim(parent_category_key) <> ''),
      ADD CONSTRAINT structured_items_category_selection_rules_object
        CHECK (jsonb_typeof(category_selection_rules) = 'object'),
      ADD CONSTRAINT structured_items_relationships_object
        CHECK (jsonb_typeof(relationships) = 'object'),
      ADD CONSTRAINT structured_items_selection_rules_object
        CHECK (jsonb_typeof(selection_rules) = 'object');

    CREATE INDEX structured_items_category_hierarchy_idx
      ON structured_items (
        tenant_id, knowledge_base_id, lower(category_key), lower(parent_category_key)
      ) WHERE category_key IS NOT NULL AND status <> 'archived';

    CREATE INDEX structured_items_relationships_gin_idx
      ON structured_items USING gin (relationships jsonb_path_ops);

    COMMENT ON COLUMN structured_items.category_key IS
      'Tenant-defined stable key for the immediate Catalog category containing this item.';
    COMMENT ON COLUMN structured_items.parent_category_key IS
      'Optional tenant-defined parent key for nested Catalog category relationships.';
    COMMENT ON COLUMN structured_items.category_selection_rules IS
      'Optional document-defined rules for choosing among child items in this category.';
    COMMENT ON COLUMN structured_items.relationships IS
      'Generic document-defined relationships to other approved Catalog entities.';
    COMMENT ON COLUMN structured_items.selection_rules IS
      'Optional document-defined rules controlling when this item may be selected.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS structured_items_relationships_gin_idx;
    DROP INDEX IF EXISTS structured_items_category_hierarchy_idx;
    ALTER TABLE structured_items
      DROP CONSTRAINT IF EXISTS structured_items_selection_rules_object,
      DROP CONSTRAINT IF EXISTS structured_items_relationships_object,
      DROP CONSTRAINT IF EXISTS structured_items_category_selection_rules_object,
      DROP CONSTRAINT IF EXISTS structured_items_parent_category_key_not_blank,
      DROP CONSTRAINT IF EXISTS structured_items_category_key_not_blank,
      DROP COLUMN IF EXISTS selection_rules,
      DROP COLUMN IF EXISTS relationships,
      DROP COLUMN IF EXISTS category_selection_rules,
      DROP COLUMN IF EXISTS category_description,
      DROP COLUMN IF EXISTS parent_category_key,
      DROP COLUMN IF EXISTS category_key;
  `);
}
