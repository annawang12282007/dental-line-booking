import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createLineWebhookHandler} from '../server/line-webhook.mjs';
const config={tenantId:'tenant-test',providerId:'provider-test',botUserId:'U'+'1'.repeat(32),channelSecret:'fixture-only-channel-secret',enabled:true};
const payload={destination:config.botUserId,events:[{webhookEventId:'evt-1',type:'message',source:{type:'user',userId:'U'+'2'.repeat(32)},message:{text:'sensitive test text'},replyToken:'do-not-retain'}],tenantId:'attacker-tenant'};
function request(data=payload,secret=config.channelSecret){const raw=JSON.stringify(data);return new Request('https://example.test/integrations/line/test/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':createHmac('sha256',secret).update(raw).digest('base64')},body:raw});}
const resolver=async key=>key==='test'?config:null;
test('requires signed raw body and resolves tenant from server configuration',async()=>{let received;const handler=createLineWebhookHandler({resolveConnection:resolver,repository:{async acceptWebhookEvents(input){received=input;}}});const result=await handler(request(),'test');assert.equal(result.status,200);assert.equal(received.tenantId,'tenant-test');assert.equal(received.events[0].webhookEventId,'evt-1');assert.equal(JSON.stringify(received).includes('sensitive test text'),false);assert.equal(JSON.stringify(received).includes('do-not-retain'),false);});
test('wrong signatures never reach durable storage',async()=>{let called=false;const handler=createLineWebhookHandler({resolveConnection:resolver,repository:{async acceptWebhookEvents(){called=true;}}});assert.equal((await handler(request(payload,'wrong'),'test')).status,401);assert.equal(called,false);});
test('unknown connection and wrong bot destination are rejected',async()=>{const handler=createLineWebhookHandler({resolveConnection:resolver});assert.equal((await handler(request(),'other')).status,404);assert.equal((await handler(request({...payload,destination:'wrong-bot'}),'test')).status,403);});
test('only empty verify requests can succeed without a durable inbox',async()=>{const handler=createLineWebhookHandler({resolveConnection:resolver});assert.equal((await handler(request({...payload,events:[]}),'test')).status,200);assert.equal((await handler(request(),'test')).status,503);});
test('storage failures are retriable and do not acknowledge lost events or disclose details',async()=>{const handler=createLineWebhookHandler({resolveConnection:resolver,repository:{async acceptWebhookEvents(){throw new Error('database private details');}}});const result=await handler(request(),'test');assert.equal(result.status,503);assert.equal((await result.text()).includes('private'),false);});
test('rejects unsupported methods and oversized payloads',async()=>{const handler=createLineWebhookHandler({resolveConnection:resolver});assert.equal((await handler(new Request('https://example.test'),'test')).status,405);const req=new Request('https://example.test',{method:'POST',body:'x'.repeat(1024*1024+1)});assert.equal((await handler(req,'test')).status,413);});

const enrollmentConfig={...config,botUserId:undefined,allowDestinationEnrollment:true};
test('signed empty Verify can durably enroll only an explicitly enabled destination',async()=>{
  let bound;
  const handler=createLineWebhookHandler({resolveConnection:async()=>enrollmentConfig,repository:{async bindVerifiedDestination(input){bound=input;}}});
  const result=await handler(request({...payload,events:[]}), 'test');
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{code:'VERIFIED'});
  assert.deepEqual(bound,{connectionKey:'test',tenantId:config.tenantId,providerId:config.providerId,destination:config.botUserId});
});
test('unsigned and wrongly signed requests can never enroll a destination',async()=>{
  let calls=0;
  const handler=createLineWebhookHandler({resolveConnection:async()=>enrollmentConfig,repository:{async bindVerifiedDestination(){calls++;}}});
  const empty={...payload,events:[]};
  const unsigned=new Request('https://example.test',{method:'POST',body:JSON.stringify(empty)});
  assert.equal((await handler(unsigned,'test')).status,401);
  assert.equal((await handler(request(empty,'wrong'),'test')).status,401);
  assert.equal(calls,0);
});
test('missing destination requires a strict enrollment flag and durable binder',async()=>{
  let calls=0;
  for(const flag of [undefined,false,'true',1]){
    const handler=createLineWebhookHandler({resolveConnection:async()=>({...enrollmentConfig,allowDestinationEnrollment:flag}),repository:{async bindVerifiedDestination(){calls++;}}});
    assert.equal((await handler(request({...payload,events:[]}),'test')).status,503);
  }
  const handler=createLineWebhookHandler({resolveConnection:async()=>enrollmentConfig});
  assert.equal((await handler(request({...payload,events:[]}),'test')).status,503);
  assert.equal(calls,0);
});
test('enrollment does not bypass missing tenant, provider, or channel secret',async()=>{
  let calls=0;
  for(const key of ['tenantId','providerId','channelSecret']){
    const handler=createLineWebhookHandler({resolveConnection:async()=>({...enrollmentConfig,[key]:undefined}),repository:{async bindVerifiedDestination(){calls++;}}});
    assert.equal((await handler(request({...payload,events:[]}),'test')).status,503);
  }
  assert.equal(calls,0);
});
test('signed nonempty events cannot enroll and are not prematurely acknowledged',async()=>{
  let bound=false;let accepted=false;
  const handler=createLineWebhookHandler({resolveConnection:async()=>enrollmentConfig,repository:{async bindVerifiedDestination(){bound=true;},async acceptWebhookEvents(){accepted=true;}}});
  assert.equal((await handler(request(),'test')).status,503);
  assert.equal(bound,false);assert.equal(accepted,false);
});
test('enrollment requires a well formed bot user id and hides database failures',async()=>{
  let calls=0;
  const handler=createLineWebhookHandler({resolveConnection:async()=>enrollmentConfig,repository:{async bindVerifiedDestination(){calls++;throw new Error('private db detail');}}});
  for(const destination of ['owner@example.test','U123','u'+'1'.repeat(32),'U'+'A'.repeat(32)]){
    assert.equal((await handler(request({...payload,events:[],destination}),'test')).status,400);
  }
  assert.equal(calls,0);
  const result=await handler(request({...payload,events:[]}),'test');
  assert.equal(result.status,503);assert.equal((await result.text()).includes('private'),false);
  assert.equal(calls,1);
});
test('configured destinations remain pinned even when enrollment is enabled',async()=>{
  let called=false;
  const handler=createLineWebhookHandler({resolveConnection:async()=>({...config,allowDestinationEnrollment:true}),repository:{async bindVerifiedDestination(){called=true;}}});
  const result=await handler(request({...payload,events:[],destination:'U'+'3'.repeat(32)}),'test');
  assert.equal(result.status,403);assert.equal(called,false);
});
