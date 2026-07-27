export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE campaign_tasks
      ADD COLUMN callback_requested_at timestamptz,
      ADD COLUMN callback_scheduled_for timestamptz,
      ADD COLUMN callback_origin_attempt_id uuid REFERENCES campaign_task_attempts(id) ON DELETE SET NULL,
      ADD COLUMN callback_request_text varchar(1000),
      ADD CONSTRAINT campaign_tasks_callback_dates CHECK (
        callback_scheduled_for IS NULL OR callback_requested_at IS NOT NULL
      );
    CREATE INDEX campaign_tasks_callback_schedule_idx
      ON campaign_tasks (tenant_id, callback_scheduled_for)
      WHERE callback_scheduled_for IS NOT NULL AND status='queued';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS campaign_tasks_callback_schedule_idx;
    ALTER TABLE campaign_tasks
      DROP CONSTRAINT IF EXISTS campaign_tasks_callback_dates,
      DROP COLUMN IF EXISTS callback_request_text,
      DROP COLUMN IF EXISTS callback_origin_attempt_id,
      DROP COLUMN IF EXISTS callback_scheduled_for,
      DROP COLUMN IF EXISTS callback_requested_at;
  `);
}
