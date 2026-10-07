export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_ai_summaries ADD COLUMN processing_token uuid;
    CREATE FUNCTION zea_conversation_summary_completed() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      IF NEW.status='completed' THEN
        UPDATE contact_conversations cv SET updated_at=now()
          FROM conversation_call_links l
          WHERE l.call_session_id=NEW.call_session_id AND l.tenant_id=NEW.tenant_id
            AND cv.id=l.conversation_id AND cv.tenant_id=l.tenant_id;
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION zea_conversation_summary_completed() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION zea_conversation_summary_completed() TO zea_voice_runtime;
    CREATE TRIGGER call_ai_summaries_conversation_context AFTER UPDATE OF status ON call_ai_summaries
      FOR EACH ROW WHEN (NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION zea_conversation_summary_completed();
  `);
}
export async function down(pgm) {
  pgm.sql(`DROP TRIGGER call_ai_summaries_conversation_context ON call_ai_summaries;
    DROP FUNCTION zea_conversation_summary_completed();
    ALTER TABLE call_ai_summaries DROP COLUMN processing_token;`);
}
