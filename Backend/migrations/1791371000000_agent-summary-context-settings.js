export async function up(pgm) {
  pgm.sql(`ALTER TABLE voice_agents
    ADD COLUMN previous_summary_count integer NOT NULL DEFAULT 2 CHECK (previous_summary_count BETWEEN 0 AND 10),
    ADD COLUMN previous_summary_max_chars integer NOT NULL DEFAULT 6000 CHECK (previous_summary_max_chars BETWEEN 500 AND 20000);`);
}
export async function down(pgm) {
  pgm.sql('ALTER TABLE voice_agents DROP COLUMN previous_summary_count, DROP COLUMN previous_summary_max_chars;');
}
