import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharedPhoneCallForm, PublicPhoneCallView } from '../src/views/PublicPhoneCallView';
import { createPublicPhoneClient, sharedPhoneToken, sharedPhonePath, unavailablePhoneLink, PublicPhoneApiError, sharedPhoneStatus } from '../src/lib/publicPhoneCalls';
const token = 'a'.repeat(43);
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), {status,headers:{'content-type':'application/json'}});
test('shared route handles missing/malformed fragments without entering the dashboard', () => {
  assert.equal(sharedPhonePath('/shared/phone-call'),true); assert.equal(sharedPhonePath('/shared/phone-call/'),true);
  assert.equal(sharedPhonePath('/agents'),false);
  assert.equal(sharedPhoneToken(`#token=${token}`),token); assert.equal(sharedPhoneToken('#token=bad'),null);
  const html = renderToStaticMarkup(<PublicPhoneCallView token={null} />);
  assert.match(html,/Calling link unavailable/); assert.doesNotMatch(html,/Sign in|Dashboard|Campaigns|Knowledge Documents/);
});
test('visitor form renders only calling controls and clear queue/dialing states', () => {
  const props = { agent:{agentName:'Family Assistant',expiresAt:null,permanent:true},phone:'+919123456789',consent:true,
    busy:false,error:'',website:'',onWebsite:()=>{},onPhone:()=>{},onConsent:()=>{},onSubmit:()=>{},onNew:()=>{} };
  const html = renderToStaticMarkup(<SharedPhoneCallForm {...props} request={{id:'request',status:'queued'}} />);
  assert.match(html,/Call with Family Assistant/); assert.match(html,/Phone number/); assert.match(html,/my own phone number/);
  assert.match(html,/queued/); assert.match(html,/automatically/); assert.match(html,/Request another call/);
  assert.doesNotMatch(html,/Create link|Revoke|Dashboard|Campaigns|Credits used|Balance after|Knowledge Documents/);
  assert.match(sharedPhoneStatus({id:'request',status:'initiated'}),/answer your phone/);
  assert.match(sharedPhoneStatus({id:'request',status:'failed'}),/could not place/);
  assert.match(sharedPhoneStatus({id:'request',status:'canceled'}),/canceled/);
});
test('public client uses headers only, omits authenticated cookies, and observes queued -> dialing', async () => {
  const calls: {url:string;init:RequestInit}[] = [];
  const client = createPublicPhoneClient(token,{baseUrl:'/api',fetch:async (url,init) => {
    calls.push({url:String(url),init:init!});
    if (String(url).endsWith('/calls/request')) return envelope({id:'request',status:'initiated'});
    if (init?.method === 'POST') return envelope({id:'request',status:'queued',reason:'company_capacity'},201);
    return envelope({agentName:'Family Assistant',expiresAt:null,permanent:true});
  }});
  assert.equal((await client.metadata()).agentName,'Family Assistant');
  assert.equal((await client.call('+919123456789','client-receipt',true)).status,'queued');
  assert.equal((await client.status('request','client-receipt')).status,'initiated');
  for (const call of calls) {
    assert.equal(call.init.credentials,'omit'); assert.equal(call.init.cache,'no-store'); assert.equal(call.init.referrerPolicy,'no-referrer');
    assert.ok(!call.url.includes(token));
    const headers = new Headers(call.init.headers); assert.equal(headers.get('x-phone-test-share-token'),token);
    assert.equal(headers.has('authorization'),false); assert.equal(headers.has('x-tenant-id'),false);
  }
  assert.equal(new Headers(calls[2].init.headers).get('x-phone-test-request-key'),'client-receipt');
  const body = JSON.parse(String(calls[1].init.body)); assert.deepEqual(Object.keys(body).sort(),['consent','phone','requestId','website']);
  assert.equal(body.requestId,'client-receipt'); assert.equal(body.consent,true);
});
test('a retry preserves the caller receipt and never auto-submits a second call', async () => {
  const receipts: string[] = [];
  const client = createPublicPhoneClient(token,{baseUrl:'/api',fetch:async (_url,init) => {
    receipts.push(JSON.parse(String(init!.body)).requestId);
    if (receipts.length === 1) throw new TypeError('Network response lost');
    return envelope({id:'saved-request',status:'queued'});
  }});
  await assert.rejects(client.call('+919123456789','same-receipt',true),/Network response lost/);
  assert.equal(receipts.length,1);
  assert.equal((await client.call('+919123456789','same-receipt',true)).id,'saved-request');
  assert.deepEqual(receipts,['same-receipt','same-receipt']);
});
test('expired/revoked links become unavailable; quota errors retain retry delay without auth refresh', async () => {
  const client = createPublicPhoneClient(token,{baseUrl:'/api',fetch:async () => new Response(JSON.stringify({success:false,error:{message:'Link expired'}}),{status:404})});
  await assert.rejects(client.metadata(),error => unavailablePhoneLink(error));
  const limited = createPublicPhoneClient(token,{baseUrl:'/api',fetch:async () => new Response(JSON.stringify({success:false,error:{message:'Too many requests'}}),{status:429,headers:{'retry-after':'60'}})});
  await assert.rejects(limited.status('request','receipt'),error => error instanceof PublicPhoneApiError && error.retryAfterSeconds === 60 && !unavailablePhoneLink(error));
});
