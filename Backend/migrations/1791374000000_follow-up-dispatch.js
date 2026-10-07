export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE campaign_tasks ADD CONSTRAINT campaign_tasks_follow_up_scope UNIQUE(tenant_id,workspace_id,id);
    ALTER TABLE scheduled_follow_up_tasks ADD COLUMN campaign_task_id uuid,
      ADD COLUMN campaign_origin_attempt_id uuid REFERENCES campaign_task_attempts(id),
      ADD CONSTRAINT follow_up_campaign_scope FOREIGN KEY(tenant_id,workspace_id,campaign_task_id)
        REFERENCES campaign_tasks(tenant_id,workspace_id,id);
    CREATE UNIQUE INDEX follow_up_active_time_unique ON scheduled_follow_up_tasks(tenant_id,conversation_id,kind,requested_for)
      WHERE status IN ('scheduled','queued','dispatching','initiated');
    ALTER TABLE agent_phone_test_requests ADD COLUMN follow_up_task_id uuid,
      ADD CONSTRAINT phone_queue_follow_up_scope FOREIGN KEY(tenant_id,workspace_id,follow_up_task_id)
        REFERENCES scheduled_follow_up_tasks(tenant_id,workspace_id,id);
    CREATE UNIQUE INDEX phone_queue_follow_up_unique ON agent_phone_test_requests(follow_up_task_id) WHERE follow_up_task_id IS NOT NULL;

    CREATE FUNCTION zea_follow_up_queue_status() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      IF NEW.follow_up_task_id IS NOT NULL THEN
        UPDATE scheduled_follow_up_tasks SET status=NEW.status,
          last_error_code=NEW.last_error,
          finished_at=CASE WHEN NEW.status IN ('failed','canceled') THEN now() ELSE finished_at END
        WHERE id=NEW.follow_up_task_id AND tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id
          AND status IN ('scheduled','queued','dispatching','initiated');
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER phone_queue_follow_up_status AFTER UPDATE OF status ON agent_phone_test_requests
      FOR EACH ROW EXECUTE FUNCTION zea_follow_up_queue_status();

    CREATE FUNCTION zea_follow_up_call_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      IF NEW.ended_at IS NOT NULL THEN
        UPDATE scheduled_follow_up_tasks t SET status=CASE WHEN NEW.status::text IN ('completed','no_answer','busy','canceled')
          THEN NEW.status::text ELSE 'failed' END,finished_at=now()
        FROM follow_up_call_attempts a WHERE a.call_session_id=NEW.id AND a.tenant_id=NEW.tenant_id
          AND t.id=a.follow_up_task_id AND t.tenant_id=a.tenant_id AND t.campaign_task_id IS NULL
          AND t.status IN ('queued','dispatching','initiated');
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER call_follow_up_outcome AFTER UPDATE OF ended_at ON call_sessions
      FOR EACH ROW EXECUTE FUNCTION zea_follow_up_call_outcome();

    CREATE FUNCTION zea_campaign_follow_up_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
    DECLARE task scheduled_follow_up_tasks%ROWTYPE;
    BEGIN
      IF NEW.call_session_id IS NULL THEN RETURN NEW; END IF;
      FOR task IN SELECT * FROM scheduled_follow_up_tasks WHERE campaign_task_id=NEW.task_id AND tenant_id=NEW.tenant_id
        AND campaign_origin_attempt_id<>NEW.id AND status IN ('scheduled','queued','dispatching','initiated') FOR UPDATE LOOP
        INSERT INTO follow_up_call_attempts(tenant_id,workspace_id,follow_up_task_id,call_session_id,attempt_number)
          SELECT task.tenant_id,task.workspace_id,task.id,NEW.call_session_id,COALESCE(max(attempt_number),0)+1
          FROM follow_up_call_attempts WHERE follow_up_task_id=task.id ON CONFLICT(call_session_id) DO NOTHING;
        UPDATE conversation_call_links SET call_purpose=left(task.purpose,80)
          WHERE call_session_id=NEW.call_session_id AND tenant_id=task.tenant_id;
      END LOOP; RETURN NEW;
    END $$;
    CREATE TRIGGER campaign_follow_up_attempt AFTER UPDATE OF call_session_id ON campaign_task_attempts
      FOR EACH ROW EXECUTE FUNCTION zea_campaign_follow_up_attempt();

    CREATE FUNCTION zea_campaign_follow_up_status() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      UPDATE scheduled_follow_up_tasks SET status=CASE NEW.status::text
        WHEN 'running' THEN 'initiated' WHEN 'paused' THEN 'queued'
        WHEN 'rejected' THEN 'failed' WHEN 'unavailable' THEN 'failed' WHEN 'manual_follow_up_required' THEN 'completed'
        WHEN 'archived' THEN 'canceled' ELSE NEW.status::text END,
        finished_at=CASE WHEN NEW.status::text IN ('completed','failed','busy','no_answer','rejected','unavailable','canceled','archived','manual_follow_up_required') THEN now() ELSE NULL END
      WHERE campaign_task_id=NEW.id AND tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id
        AND status IN ('scheduled','queued','dispatching','initiated');
      RETURN NEW;
    END $$;
    CREATE TRIGGER campaign_follow_up_status AFTER UPDATE OF status ON campaign_tasks
      FOR EACH ROW EXECUTE FUNCTION zea_campaign_follow_up_status();
  `);
  for(const name of ['zea_follow_up_queue_status','zea_follow_up_call_outcome','zea_campaign_follow_up_attempt','zea_campaign_follow_up_status'])pgm.sql(`REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${name}() TO zea_voice_runtime;`);
}
export async function down(pgm) {
  pgm.sql(`DROP TRIGGER campaign_follow_up_status ON campaign_tasks; DROP FUNCTION zea_campaign_follow_up_status();
    DROP TRIGGER campaign_follow_up_attempt ON campaign_task_attempts; DROP FUNCTION zea_campaign_follow_up_attempt();
    DROP TRIGGER call_follow_up_outcome ON call_sessions; DROP FUNCTION zea_follow_up_call_outcome();
    DROP TRIGGER phone_queue_follow_up_status ON agent_phone_test_requests; DROP FUNCTION zea_follow_up_queue_status();
    ALTER TABLE agent_phone_test_requests DROP COLUMN follow_up_task_id;
    DROP INDEX follow_up_active_time_unique;
    ALTER TABLE scheduled_follow_up_tasks DROP COLUMN campaign_task_id,DROP COLUMN campaign_origin_attempt_id;
    ALTER TABLE campaign_tasks DROP CONSTRAINT campaign_tasks_follow_up_scope;`);
}
