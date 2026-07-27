export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TYPE call_status ADD VALUE IF NOT EXISTS 'manual_follow_up_required';
    ALTER TYPE campaign_task_status ADD VALUE IF NOT EXISTS 'manual_follow_up_required';
    ALTER TYPE campaign_attempt_status ADD VALUE IF NOT EXISTS 'manual_follow_up_required';
  `);
}

// PostgreSQL enum values are intentionally retained on rollback. Removing an enum
// value safely requires rebuilding dependent columns and can destroy historical data.
export async function down() {}
