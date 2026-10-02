export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TYPE ai_provider_type ADD VALUE IF NOT EXISTS 'audio_to_audio';

    ALTER TABLE ai_providers
      ADD COLUMN IF NOT EXISTS runtime_connection_type varchar(80);
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE ai_providers
      DROP COLUMN IF EXISTS runtime_connection_type;
  `);
}
