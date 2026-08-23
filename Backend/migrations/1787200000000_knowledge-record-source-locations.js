export const shorthands = undefined;

const tables = [
  'faq_entries', 'structured_items', 'workflow_rules',
  'conversation_flows', 'knowledge_chunks',
];

export async function up(pgm) {
  for (const table of tables) {
    pgm.sql(`
      ALTER TABLE ${table}
        ADD COLUMN source_section varchar(240),
        ADD COLUMN source_line_start integer,
        ADD COLUMN source_line_end integer,
        ADD CONSTRAINT ${table}_source_lines_valid CHECK (
          (source_line_start IS NULL AND source_line_end IS NULL)
          OR (source_line_start >= 1 AND source_line_end >= source_line_start)
        );
    `);
  }
}

export async function down(pgm) {
  for (const table of [...tables].reverse()) {
    pgm.sql(`
      ALTER TABLE ${table}
        DROP CONSTRAINT IF EXISTS ${table}_source_lines_valid,
        DROP COLUMN IF EXISTS source_line_end,
        DROP COLUMN IF EXISTS source_line_start,
        DROP COLUMN IF EXISTS source_section;
    `);
  }
}
