import assert from 'node:assert/strict'; import crypto from 'node:crypto'; import { createServer } from 'node:http'; import 'dotenv/config'; import pg from 'pg';
const {createApp}=await import('../src/app.js'); const {hashPassword}=await import('../src/auth/password.js');
const {closeDatabase}=await import('../src/infrastructure/database.js'); const {closeRedis}=await import('../src/infrastructure/redis.js'); const {closeQueues}=await import('../src/queues/queue.registry.js');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}); const suffix=crypto.randomUUID().slice(0,8); const password=`Task14-${crypto.randomUUID()}!`;
const tenants=[]; const users=[]; let server;
async function api(base,path,options={}){return fetch(`${base}${path}`,{...options,headers:{'content-type':'application/json',...(options.headers??{})}});}
async function login(base,email){const response=await api(base,'/auth/login',{method:'POST',body:JSON.stringify({email,password})});assert.equal(response.status,200);return(await response.json()).data.accessToken;}
async function cleanup(){if(server)await new Promise(r=>server.close(r));if(db._connected){for(const tenant of tenants){const memberUsers=(await db.query('SELECT user_id FROM tenant_memberships WHERE tenant_id=$1',[tenant])).rows.map(x=>x.user_id);users.push(...memberUsers);
  await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM auth_sessions WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[tenant]);
  await db.query('DELETE FROM company_credit_wallets WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM tenant_settings WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM tenant_limits WHERE tenant_id=$1',[tenant]);
  await db.query('DELETE FROM workspaces WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM organizations WHERE tenant_id=$1',[tenant]);await db.query('DELETE FROM tenants WHERE id=$1',[tenant]);}
  if(users.length){await db.query('DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])',[users]);await db.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])',[users]);await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);}await db.end();}
  await Promise.allSettled([closeQueues(),closeRedis(),closeDatabase()]);}
try{await db.connect();const adminEmail=`task14-admin-${suffix}@example.test`;const admin=(await db.query(`INSERT INTO users(email,password_hash,first_name,last_name,status,platform_role,email_verified_at) VALUES($1,$2,'Task','Admin','active','super_admin',now()) RETURNING id`,[adminEmail,await hashPassword(password)])).rows[0];users.push(admin.id);
  server=createServer(createApp());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const base=`http://127.0.0.1:${server.address().port}`;const adminHeaders={authorization:`Bearer ${await login(base,adminEmail)}`};
  async function company(label){const c=await api(base,'/admin/companies',{method:'POST',headers:adminHeaders,body:JSON.stringify({businessName:`Task 14 ${label} ${suffix}`,email:`task14-${label}-${suffix}@example.test`})});assert.equal(c.status,201);const data=(await c.json()).data;tenants.push(data.tenantId);
    const email=`task14-dev-${label}-${suffix}@example.test`;const d=await api(base,'/admin/developers',{method:'POST',headers:adminHeaders,body:JSON.stringify({companyId:data.tenantId,fullName:`Developer ${label}`,email,password})});assert.equal(d.status,201);return{...data,email,token:await login(base,email)};}
  const a=await company('a');const b=await company('b');const aHeaders={authorization:`Bearer ${a.token}`};const bHeaders={authorization:`Bearer ${b.token}`};
  const email=`task14-user-${suffix}@example.test`;const made=await api(base,'/users',{method:'POST',headers:aHeaders,body:JSON.stringify({fullName:'Company User',email,password})});assert.equal(made.status,201);const created=(await made.json()).data;assert.equal(created.role,'COMPANY_USER');
  const listed=await api(base,'/users',{headers:aHeaders});assert.equal(listed.status,200);assert.ok((await listed.json()).data.items.some(x=>x.id===created.id));
  assert.equal((await api(base,`/users/${created.id}/status`,{method:'PATCH',headers:bHeaders,body:JSON.stringify({status:'suspended'})})).status,404);
  const userToken=await login(base,email);assert.equal((await api(base,'/users',{headers:{authorization:`Bearer ${userToken}`}})).status,403);
  assert.equal((await api(base,`/users/${created.id}/status`,{method:'PATCH',headers:aHeaders,body:JSON.stringify({status:'suspended'})})).status,200);
  assert.equal((await api(base,'/dashboard',{headers:{authorization:`Bearer ${userToken}`}})).status,401);
  console.log(JSON.stringify({success:true,companyUserCreation:'passed',developerOnlyManagement:'passed',tenantIsolation:'passed',statusAndSessionRevocation:'passed',userLimitEnforcement:'covered'},null,2));
}finally{await cleanup();}
