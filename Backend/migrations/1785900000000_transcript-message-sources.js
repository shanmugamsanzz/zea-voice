export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_transcript_entries
      ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE call_transcript_entries
      ADD CONSTRAINT call_transcript_entries_sources_array
      CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 50);

    COMMENT ON COLUMN call_transcript_entries.sources IS
      'Ordered, tenant-isolated evidence used to produce this transcript message.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE call_transcript_entries
      DROP CONSTRAINT IF EXISTS call_transcript_entries_sources_array;
    ALTER TABLE call_transcript_entries DROP COLUMN IF EXISTS sources;
  `);
}
