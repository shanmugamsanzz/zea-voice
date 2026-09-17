export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE agent_live_data_tables
      ADD COLUMN IF NOT EXISTS sync_status varchar(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS sync_error varchar(500),
      ADD COLUMN IF NOT EXISTS synced_at timestamptz;

    ALTER TABLE agent_live_data_tables
      DROP CONSTRAINT IF EXISTS agent_live_data_tables_sync_status;
    ALTER TABLE agent_live_data_tables
      ADD CONSTRAINT agent_live_data_tables_sync_status
      CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed'));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE agent_live_data_tables
      DROP CONSTRAINT IF EXISTS agent_live_data_tables_sync_status,
      DROP COLUMN IF EXISTS synced_at,
      DROP COLUMN IF EXISTS sync_error,
      DROP COLUMN IF EXISTS sync_status;
  `);
}
