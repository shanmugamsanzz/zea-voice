export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_id_tenant_unique UNIQUE (id, tenant_id);
    ALTER TABLE call_transcript_entries DROP CONSTRAINT call_transcript_entries_call_session_id_fkey;
    ALTER TABLE call_transcript_entries ADD CONSTRAINT call_transcript_entries_call_tenant_fk
      FOREIGN KEY (call_session_id, tenant_id) REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE;
    ALTER TABLE call_control_events DROP CONSTRAINT call_control_events_call_session_id_fkey;
    ALTER TABLE call_control_events ADD CONSTRAINT call_control_events_call_tenant_fk
      FOREIGN KEY (call_session_id, tenant_id) REFERENCES call_sessions(id, tenant_id) ON DELETE CASCADE;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE call_control_events DROP CONSTRAINT call_control_events_call_tenant_fk;
    ALTER TABLE call_control_events ADD CONSTRAINT call_control_events_call_session_id_fkey
      FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE CASCADE;
    ALTER TABLE call_transcript_entries DROP CONSTRAINT call_transcript_entries_call_tenant_fk;
    ALTER TABLE call_transcript_entries ADD CONSTRAINT call_transcript_entries_call_session_id_fkey
      FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE CASCADE;
    ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_id_tenant_unique;
  `);
}
