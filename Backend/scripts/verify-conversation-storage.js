import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up, down } from '../migrations/1791370000000_contact-conversations-follow-ups.js';
import { up as linkUp, down as linkDown } from '../migrations/1791372000000_continuous-conversation-linking.js';
import { up as summaryUp, down as summaryDown } from '../migrations/1791373000000_conversation-summary-context.js';

const statements = [];
await up({ sql: text => statements.push(text) });
const sql = statements.join('\n');
const rollback = [];
await down({ sql: text => rollback.push(text) });
assert.match(sql, /inbound_prompt=prompt, outbound_prompt=prompt/);
assert.match(sql, /inbound_welcome_message=welcome_message, outbound_welcome_message=welcome_message/);
assert.doesNotMatch(sql, /(?:DROP|DELETE FROM|TRUNCATE) (?:call_sessions|call_transcript_entries|call_ai_summaries|conversation_memories)/i);
for (const table of ['conversation_contacts','contact_conversations','conversation_call_links','scheduled_follow_up_tasks','follow_up_call_attempts']) {
  assert.ok(sql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  assert.ok(sql.includes(`GRANT SELECT,INSERT,UPDATE ON ${table}`));
  assert.ok(rollback.join('\n').includes(`DROP TABLE ${table}`));
}
assert.match(sql, /UNIQUE \(tenant_id, phone_e164\)/);
assert.match(sql, /UNIQUE \(tenant_id, contact_id\)/);
assert.match(sql, /UNIQUE \(tenant_id,request_key\)/);
assert.match(sql, /REFERENCES conversation_call_links\(tenant_id,conversation_id,call_session_id\)/);
console.log('PASS migration contract: additive storage, legacy backfill, tenant constraints, RLS and rollback');

// Never connect to the application's DATABASE_URL implicitly.
const url = process.env.CONVERSATION_SCHEMA_TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP live PostgreSQL checks: set CONVERSATION_SCHEMA_TEST_DATABASE_URL to an isolated test database');
  process.exit(0);
}
const { Client } = await import('pg');
const client = new Client({ connectionString: url });
await client.connect();
const schema = `conversation_test_${randomUUID().replaceAll('-', '')}`;
const ids = Array.from({ length: 14 }, () => randomUUID());
const [tenantA, tenantB, workspaceA, workspaceB, agentA, agentB, callA, callB, contactA, contactB, threadA, threadB, taskA, requestKey] = ids;
async function rejectsSql(statement, params, code) {
  await client.query('SAVEPOINT expected_failure');
  let failure;
  try { await client.query(statement, params); } catch (error) { failure = error; }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  assert.equal(failure?.code, code);
}
try {
  await client.query('BEGIN');
  // Existing project runtime role is required to exercise actual RLS.
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname='zea_voice_runtime' AND NOT rolbypassrls AND NOT rolsuper")).rows[0].count, 1);
  await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},public;
    GRANT USAGE ON SCHEMA ${schema} TO zea_voice_runtime;
    CREATE FUNCTION zea_current_tenant_id() RETURNS uuid LANGUAGE sql AS
      $$SELECT nullif(current_setting('app.current_tenant_id',true),'')::uuid$$;
    CREATE FUNCTION zea_is_platform_admin() RETURNS boolean LANGUAGE sql AS
      $$SELECT coalesce(current_setting('app.is_platform_admin',true),'false')='true'$$;
    CREATE FUNCTION zea_is_auth_service() RETURNS boolean LANGUAGE sql AS
      $$SELECT coalesce(current_setting('app.is_auth_service',true),'false')='true'$$;
    CREATE FUNCTION zea_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN NEW.updated_at=now(); RETURN NEW; END$$;
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,UNIQUE(tenant_id,id));
    CREATE TABLE voice_agents(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,workspace_id uuid NOT NULL,
      prompt text NOT NULL,welcome_message text,UNIQUE(tenant_id,id));
    CREATE TABLE call_sessions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,workspace_id uuid NOT NULL,UNIQUE(id,tenant_id));`);
  await client.query('INSERT INTO tenants VALUES ($1),($2)', [tenantA,tenantB]);
  await client.query('INSERT INTO workspaces VALUES ($1,$2),($3,$4)',[workspaceA,tenantA,workspaceB,tenantB]);
  await client.query("INSERT INTO voice_agents VALUES ($1,$2,$3,'legacy prompt','legacy welcome'),($4,$5,$6,'other prompt',NULL)",[agentA,tenantA,workspaceA,agentB,tenantB,workspaceB]);
  await client.query('INSERT INTO call_sessions VALUES ($1,$2,$3),($4,$5,$6)',[callA,tenantA,workspaceA,callB,tenantB,workspaceB]);
  await client.query(sql);
  const agent = (await client.query('SELECT * FROM voice_agents WHERE id=$1',[agentA])).rows[0];
  assert.equal(agent.prompt, 'legacy prompt');
  assert.equal(agent.inbound_prompt, agent.prompt);
  assert.equal(agent.outbound_prompt, agent.prompt);
  assert.equal(agent.inbound_welcome_message, agent.welcome_message);
  assert.equal(agent.outbound_welcome_message, agent.welcome_message);
  assert.equal((await client.query('SELECT outbound_welcome_message FROM voice_agents WHERE id=$1',[agentB])).rows[0].outbound_welcome_message,null);
  await client.query("INSERT INTO conversation_contacts(id,tenant_id,phone_e164) VALUES ($1,$2,'+919123456789'),($3,$4,'+919123456789')",[contactA,tenantA,contactB,tenantB]);
  await rejectsSql("INSERT INTO conversation_contacts(tenant_id,phone_e164) VALUES ($1,'+919123456789')",[tenantA],'23505');
  await client.query('INSERT INTO contact_conversations(id,tenant_id,contact_id) VALUES ($1,$2,$3),($4,$5,$6)',[threadA,tenantA,contactA,threadB,tenantB,contactB]);
  await rejectsSql('INSERT INTO contact_conversations(tenant_id,contact_id) VALUES ($1,$2)',[tenantA,contactB],'23503');
  await client.query('INSERT INTO conversation_call_links(call_session_id,tenant_id,workspace_id,conversation_id) VALUES ($1,$2,$3,$4)',[callA,tenantA,workspaceA,threadA]);
  await rejectsSql('INSERT INTO conversation_call_links(call_session_id,tenant_id,workspace_id,conversation_id) VALUES ($1,$2,$3,$4)',[callB,tenantA,workspaceA,threadA],'23503');
  const insertTask = `INSERT INTO scheduled_follow_up_tasks(id,tenant_id,workspace_id,agent_id,conversation_id,origin_call_session_id,request_key,kind,purpose,requested_for,scheduled_for,time_zone)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'callback','Appointment inquiry',now()+interval '10 minutes',now()+interval '10 minutes','Asia/Calcutta')`;
  await client.query(insertTask,[taskA,tenantA,workspaceA,agentA,threadA,callA,requestKey]);
  await rejectsSql(insertTask,[randomUUID(),tenantA,workspaceA,agentB,threadA,callA,randomUUID()],'23503');
  await rejectsSql(insertTask,[randomUUID(),tenantA,workspaceA,agentA,threadA,callA,requestKey],'23505');
  await client.query('SET LOCAL ROLE zea_voice_runtime');
  await client.query("SELECT set_config('app.current_tenant_id',$1,true),set_config('app.is_platform_admin','false',true),set_config('app.is_auth_service','false',true)",[tenantA]);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM conversation_contacts')).rows[0].count,1);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM contact_conversations')).rows[0].count,1);
  await rejectsSql("INSERT INTO conversation_contacts(tenant_id,phone_e164) VALUES ($1,'+919999999999')",[tenantB],'42501');
  await client.query('RESET ROLE');
  await client.query(`ALTER TABLE call_sessions
    ADD COLUMN direction text DEFAULT 'inbound',
    ADD COLUMN from_number text DEFAULT '+919123456789',
    ADD COLUMN to_number text DEFAULT '+918000000000',
    ADD COLUMN provider_metadata jsonb DEFAULT '{}',
    ADD COLUMN started_at timestamptz DEFAULT now(),
    ADD COLUMN created_at timestamptz DEFAULT now();`);
  const linkStatements=[];
  await linkUp({sql:value=>linkStatements.push(value)});
  await client.query(linkStatements.join('\n'));
  await client.query("UPDATE conversation_contacts SET display_name='Caller Name',name_source='caller' WHERE id=$1",[contactA]);
  const inbound=randomUUID(),outbound=randomUUID(),otherCompany=randomUUID(),browser=randomUUID();
  await client.query(`INSERT INTO call_sessions(id,tenant_id,workspace_id,direction,from_number,to_number,provider_metadata)
    VALUES ($1,$2,$3,'inbound','+919123456789','+918000000000','{}'),
           ($4,$2,$3,'outbound','+918000000000','+919123456789','{}'),
           ($5,$6,$7,'inbound','+919123456789','+918000000000','{}'),
           ($8,$2,$3,'outbound','+918000000000','+919123456789','{"source":"browser_test"}')`,
    [inbound,tenantA,workspaceA,outbound,otherCompany,tenantB,workspaceB,browser]);
  assert.equal((await client.query('SELECT conversation_id FROM conversation_call_links WHERE call_session_id=$1',[inbound])).rows[0].conversation_id,threadA);
  assert.equal((await client.query('SELECT conversation_id FROM conversation_call_links WHERE call_session_id=$1',[outbound])).rows[0].conversation_id,threadA);
  assert.equal((await client.query('SELECT conversation_id FROM conversation_call_links WHERE call_session_id=$1',[otherCompany])).rows[0].conversation_id,threadB);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM conversation_call_links WHERE call_session_id=$1',[browser])).rows[0].count,0);
  await client.query('SELECT zea_link_call_conversation($1)',[inbound]);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM conversation_call_links WHERE call_session_id=$1',[inbound])).rows[0].count,1);
  assert.equal((await client.query('SELECT display_name FROM conversation_contacts WHERE id=$1',[contactA])).rows[0].display_name,'Caller Name');
  await client.query('SELECT zea_link_call_conversation($1)',[callB]);
  assert.equal((await client.query('SELECT conversation_id FROM conversation_call_links WHERE call_session_id=$1',[callB])).rows[0].conversation_id,threadB);
  await client.query(`CREATE TABLE call_ai_summaries(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,
    call_session_id uuid NOT NULL,status text NOT NULL);
    CREATE TABLE context_updates(conversation_id uuid);
    CREATE FUNCTION observe_context_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO context_updates VALUES(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER observe_context_update AFTER UPDATE ON contact_conversations
      FOR EACH ROW EXECUTE FUNCTION observe_context_update();`);
  const summaryStatements=[];
  await summaryUp({sql:value=>summaryStatements.push(value)});
  await client.query(summaryStatements.join('\n'));
  const summaryId=randomUUID();
  await client.query("INSERT INTO call_ai_summaries VALUES($1,$2,$3,'processing',NULL)",[summaryId,tenantA,inbound]);
  await client.query("UPDATE call_ai_summaries SET status='completed' WHERE id=$1",[summaryId]);
  assert.deepEqual((await client.query('SELECT conversation_id FROM context_updates')).rows,[{conversation_id:threadA}]);
  await client.query("UPDATE call_ai_summaries SET status='completed' WHERE id=$1",[summaryId]);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM context_updates')).rows[0].count,1);
  await client.query("UPDATE call_ai_summaries SET status='failed' WHERE id=$1",[summaryId]);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM context_updates')).rows[0].count,1);
  const summaryRollback=[];
  await summaryDown({sql:value=>summaryRollback.push(value)});
  await client.query(summaryRollback.join('\n'));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM call_ai_summaries')).rows[0].count,1);
  const linkRollback=[];
  await linkDown({sql:value=>linkRollback.push(value)});
  await client.query(linkRollback.join('\n'));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM conversation_call_links')).rows[0].count,5);
  await client.query(rollback.join('\n'));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM call_sessions')).rows[0].count,6);
  assert.equal((await client.query('SELECT prompt FROM voice_agents WHERE id=$1',[agentA])).rows[0].prompt,'legacy prompt');
  console.log('PASS PostgreSQL: backfill, same-number company isolation, duplicate protection, foreign keys, RLS and rollback');
  console.log('PASS PostgreSQL summary context trigger: company isolation, completion-only updates, duplicate protection and data-preserving rollback');
} finally {
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
}
