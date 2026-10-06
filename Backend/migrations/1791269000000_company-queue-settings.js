export async function up(pgm) {
  pgm.sql(`ALTER TABLE tenant_limits
    ADD COLUMN max_inbound_queue_size integer NOT NULL DEFAULT 100 CHECK (max_inbound_queue_size BETWEEN 1 AND 10000),
    ADD COLUMN max_inbound_wait_seconds integer NOT NULL DEFAULT 180 CHECK (max_inbound_wait_seconds BETWEEN 10 AND 3600),
    ADD COLUMN max_outbound_queued_tasks integer NOT NULL DEFAULT 10000 CHECK (max_outbound_queued_tasks BETWEEN 1 AND 100000);
    ALTER TYPE campaign_queue_reason ADD VALUE IF NOT EXISTS 'company_capacity';
    ALTER TYPE campaign_queue_reason ADD VALUE IF NOT EXISTS 'campaign_capacity';
    ALTER TYPE campaign_queue_reason ADD VALUE IF NOT EXISTS 'coordination_unavailable';
    CREATE INDEX campaign_tasks_company_queue_idx ON campaign_tasks(tenant_id,created_at,id)
      WHERE status='queued' AND archived_at IS NULL;
  `);
}

export async function down(pgm) {
  // Keep enum values: PostgreSQL cannot remove them safely while jobs use them.
  pgm.sql(`DROP INDEX IF EXISTS campaign_tasks_company_queue_idx;
    ALTER TABLE tenant_limits DROP COLUMN max_inbound_queue_size,
      DROP COLUMN max_inbound_wait_seconds, DROP COLUMN max_outbound_queued_tasks;`);
}
