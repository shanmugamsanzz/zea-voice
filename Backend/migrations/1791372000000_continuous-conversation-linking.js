export async function up(pgm) {
  pgm.sql(`
    -- SECURITY INVOKER keeps the existing call/contact row-level policies active.
    CREATE FUNCTION zea_link_call_conversation(p_call_id uuid) RETURNS uuid
      LANGUAGE plpgsql SECURITY INVOKER AS $$
    DECLARE
      v_call call_sessions%ROWTYPE;
      v_phone varchar(16);
      v_contact uuid;
      v_thread uuid;
      v_existing conversation_call_links%ROWTYPE;
    BEGIN
      SELECT * INTO v_call FROM call_sessions WHERE id=p_call_id FOR UPDATE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF v_call.provider_metadata->>'source'='browser_test' THEN RETURN NULL; END IF;
      SELECT * INTO v_existing FROM conversation_call_links
        WHERE call_session_id=v_call.id AND tenant_id=v_call.tenant_id;
      IF FOUND THEN RETURN v_existing.conversation_id; END IF;
      v_phone := CASE WHEN v_call.direction='inbound' THEN v_call.from_number
                      WHEN v_call.direction='outbound' THEN v_call.to_number ELSE NULL END;
      -- call_sessions already enforces canonical E.164. Never guess a country.
      IF v_phone IS NULL OR v_phone !~ '^\\+[1-9][0-9]{6,14}$' THEN RETURN NULL; END IF;
      INSERT INTO conversation_contacts(tenant_id,phone_e164)
        VALUES(v_call.tenant_id,v_phone)
        ON CONFLICT(tenant_id,phone_e164) DO UPDATE SET phone_e164=EXCLUDED.phone_e164
        RETURNING id INTO v_contact;
      INSERT INTO contact_conversations(tenant_id,contact_id)
        VALUES(v_call.tenant_id,v_contact)
        ON CONFLICT(tenant_id,contact_id) DO UPDATE SET contact_id=EXCLUDED.contact_id
        RETURNING id INTO v_thread;
      INSERT INTO conversation_call_links(call_session_id,tenant_id,workspace_id,conversation_id,created_at)
        VALUES(v_call.id,v_call.tenant_id,v_call.workspace_id,v_thread,v_call.started_at);
      RETURN v_thread;
    END $$;
    REVOKE ALL ON FUNCTION zea_link_call_conversation(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION zea_link_call_conversation(uuid) TO zea_voice_runtime;

    CREATE FUNCTION zea_call_conversation_insert() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      PERFORM zea_link_call_conversation(NEW.id);
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION zea_call_conversation_insert() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION zea_call_conversation_insert() TO zea_voice_runtime;
    CREATE TRIGGER call_sessions_link_conversation AFTER INSERT ON call_sessions
      FOR EACH ROW EXECUTE FUNCTION zea_call_conversation_insert();
    CREATE INDEX call_sessions_conversation_backfill_idx ON call_sessions(created_at,id)
      WHERE COALESCE(provider_metadata->>'source','')<>'browser_test';
  `);
}
export async function down(pgm) {
  pgm.sql(`DROP TRIGGER call_sessions_link_conversation ON call_sessions;
    DROP FUNCTION zea_call_conversation_insert();
    DROP FUNCTION zea_link_call_conversation(uuid);
    DROP INDEX call_sessions_conversation_backfill_idx;`);
}
