import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const backend=fileURLToPath(new URL('../',import.meta.url));
const release=process.argv.includes('--release');
const liveRedis=process.argv.includes('--redis');
const report={passed:false,releaseReady:false,startedAt:new Date().toISOString(),checks:[],limitations:[
  'Local scheduling, callback and company isolation checks use database/provider fixtures.',
  'Physical restarts, live provider traffic and PostgreSQL concurrency require staging evidence.',
]};
const scripts=[
  'verify-conversation-rollout','verify-conversation-storage','verify-agent-conversation-configuration',
  'verify-update-contact','verify-conversation-thread-linking','verify-conversation-summary-context',
  'verify-dynamic-prompt-values','verify-directional-conversation-openings','verify-conversation-view',
  'verify-follow-up-scheduling','verify-callback-continuity','verify-agent-phone-test-queue',
  'verify-company-queue-settings-and-access','verify-outbound-capacity-queues',
  'verify-generic-runtime-contract','verify-template-engine-production-runtime',
  'verify-qdrant-architecture-e2e','verify-metered-call-billing-and-reports',
];
try {
  for(const script of scripts){
    const started=Date.now();
    const result=spawnSync(process.execPath,[`scripts/${script}.js`,...(liveRedis&&script==='verify-outbound-capacity-queues'?['--redis']:[])],{
      cwd:backend,encoding:'utf8',timeout:180000,env:{...process.env,
        VOICE_CONVERSATION_CONTINUITY_ENABLED:'true',VOICE_CONVERSATION_CONTINUITY_TENANT_IDS:'',
        VOICE_COMPANY_QUEUE_ENABLED:'true',VOICE_COMPANY_QUEUE_TENANT_IDS:''},
    });
    const passed=result.status===0&&!result.error;
    report.checks.push({name:script,passed,durationMs:Date.now()-started,
      liveChecksSkipped:result.stdout.includes('SKIP live PostgreSQL')});
    console.log(`${passed?'PASS':'FAIL'} ${script}`);
    if(!passed)throw new Error(`${script}: ${result.error?.message??result.stderr}\n${result.stdout}`);
  }
  for(const script of ['verify-generic-runtime-contract','verify-template-engine-production-runtime']){
    const result=spawnSync(process.execPath,[`scripts/${script}.js`],{cwd:backend,encoding:'utf8',timeout:180000,
      env:{...process.env,VOICE_CONVERSATION_CONTINUITY_ENABLED:'false',VOICE_CONVERSATION_CONTINUITY_TENANT_IDS:''}});
    const passed=result.status===0&&!result.error;
    report.checks.push({name:`${script} with continuity disabled`,passed});
    console.log(`${passed?'PASS':'FAIL'} ${script} with continuity disabled`);
    if(!passed)throw new Error(result.error?.message??`${result.stderr}\n${result.stdout}`);
  }
  if(release){
    assert.ok(liveRedis,'Release requires --redis; fixture checks cannot authorize rollout.');
    assert.ok(process.env.CONVERSATION_SCHEMA_TEST_DATABASE_URL,'Release requires isolated PostgreSQL conversation schema checks.');
    const {database,checkDatabase,closeDatabase}=await import('../src/infrastructure/database.js');
    try{
      await checkDatabase();
      const tables=await database.query(`SELECT to_regclass('public.scheduled_follow_up_tasks') AS tasks,
        to_regclass('public.conversation_contacts') AS contacts,to_regclass('public.conversation_call_links') AS links`);
      assert.ok(tables.rows[0].tasks&&tables.rows[0].contacts&&tables.rows[0].links,'Conversation migrations are missing.');
      const columns=await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
        AND table_name='scheduled_follow_up_tasks' AND column_name IN ('campaign_task_id','campaign_origin_attempt_id')`);
      assert.equal(columns.rowCount,2,'Apply Task 9 migration before rollout.');
      const triggers=await database.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('public.call_sessions'::regclass,'public.agent_phone_test_requests'::regclass,
          'public.campaign_tasks'::regclass,'public.campaign_task_attempts'::regclass)
        AND tgname IN ('call_follow_up_outcome','phone_queue_follow_up_status','campaign_follow_up_status','campaign_follow_up_attempt')`);
      assert.equal(triggers.rowCount,4,'Follow-up outcome/queue triggers are missing.');
    }finally{await closeDatabase();}
    assert.ok(process.env.CONVERSATION_STAGING_EVIDENCE,'Release requires CONVERSATION_STAGING_EVIDENCE.');
    const evidence=JSON.parse(await readFile(process.env.CONVERSATION_STAGING_EVIDENCE,'utf8'));
    const git=args=>spawnSync('git',args,{cwd:backend,encoding:'utf8'});
    const revision=git(['rev-parse','HEAD']);assert.equal(revision.status,0);
    assert.equal(evidence.commit,revision.stdout.trim(),'Staging evidence must match the release commit.');
    const dirty=git(['status','--porcelain','--untracked-files=normal']);assert.equal(dirty.status,0);
    assert.equal(dirty.stdout.trim(),'','Commit the tested release before authorizing rollout.');
    const age=Date.now()-new Date(evidence.testedAt).getTime();assert.ok(age>=0&&age<86400000,'Staging evidence must be less than 24 hours old.');
    for(const scenario of ['contactUpdates','history','scheduling','missedCallbackInbound','capacity','backendRestart','redisRestart','permissions','companyIsolation','campaignRetries','billing','rollback']){
      assert.equal(evidence.scenarios?.[scenario]?.passed,true,`Missing staging scenario: ${scenario}`);
      assert.ok(evidence.scenarios[scenario].evidence?.trim(),`Missing evidence for ${scenario}`);
    }
    report.releaseReady=true;
  }
  report.passed=true;
  if(!release)console.log('Local regression checks passed. Feature remains disabled pending live release gate and staging evidence.');
}catch(error){report.error=error.message;console.error(error.message);process.exitCode=1;}
finally{
  report.completedAt=new Date().toISOString();
  await mkdir(new URL('../reports/',import.meta.url),{recursive:true});
  await writeFile(new URL('../reports/conversation-release.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
}
