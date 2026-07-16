export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE agent_usage_direction AS ENUM ('inbound', 'outbound', 'both');
    ALTER TABLE voice_agents
      ADD COLUMN usage_direction agent_usage_direction NOT NULL DEFAULT 'both';
    CREATE INDEX voice_agents_tenant_usage_idx
      ON voice_agents (tenant_id, usage_direction, status)
      WHERE deleted_at IS NULL;
    GRANT USAGE ON TYPE agent_usage_direction TO zea_voice_runtime;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS voice_agents_tenant_usage_idx;
    ALTER TABLE voice_agents DROP COLUMN IF EXISTS usage_direction;
    DROP TYPE IF EXISTS agent_usage_direction;
  `);
}
