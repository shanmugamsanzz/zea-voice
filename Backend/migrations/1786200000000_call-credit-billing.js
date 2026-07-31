export const shorthands = undefined;

// Restores the call linkage and idempotency constraint already applied to the
// shared database. Actual debit execution is connected in a later task.
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE credit_ledger_entries
      ADD COLUMN IF NOT EXISTS call_session_id uuid;

    DO $$ BEGIN
      ALTER TABLE credit_ledger_entries
        ADD CONSTRAINT credit_ledger_entries_call_session_id_fkey
        FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_entries_usage_call_unique
      ON credit_ledger_entries (call_session_id)
      WHERE call_session_id IS NOT NULL AND entry_type = 'usage_debit';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS credit_ledger_entries_usage_call_unique;
    ALTER TABLE credit_ledger_entries
      DROP CONSTRAINT IF EXISTS credit_ledger_entries_call_session_id_fkey;
    ALTER TABLE credit_ledger_entries DROP COLUMN IF EXISTS call_session_id;
  `);
}

