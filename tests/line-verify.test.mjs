import test from 'node:test';
import assert from 'node:assert/strict';
import {createLineVerifyHandler} from '../server/line-verify.mjs';
import {bookingBrand} from '../lib/booking-brand.mjs';
const origin='https://gateway.example';
const req=(body,headers={})=>new Request(origin+'/api/line/verify',{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('valid verification discloses no LINE subject or token',async()=>{
 const seen=[];const handler=createLineVerifyHandler({publicOrigin:origin,channelId:'123',verify:async a=>{seen.push(a);return {userId:'private-user',expiresAt:123};}});
 const res=await handler(req({idToken:'secret-token'}));assert.equal(res.status,200);assert.deepEqual(await res.json(),{verified:true,accountId:bookingBrand.lineAccountId});assert.deepEqual(seen,[{idToken:'secret-token',channelId:'123'}]);assert.equal(res.headers.get('cache-control'),'no-store');
});
test('cross-origin rejected before LINE call',async()=>{
 const handler=createLineVerifyHandler({publicOrigin:origin,channelId:'123',verify:()=>assert.fail('must not run')});assert.equal((await handler(req({idToken:'a'},{origin:'https://elsewhere.example'}))).status,403);
});
test('unconfigured fails closed',async()=>assert.equal((await createLineVerifyHandler({})(req({idToken:'a'}))).status,503));
test('profile substitution and unbounded input rejected',async()=>{
 const handler=createLineVerifyHandler({publicOrigin:origin,channelId:'123',verify:()=>assert.fail('must not run')});
 for(const body of [{userId:'forged'}, {idToken:'a',userId:'forged'}, {idToken:'a'.repeat(25000)},null,[]])assert.equal((await handler(req(body))).status,400);
});
test('provider errors do not echo submitted token',async()=>{
 const handler=createLineVerifyHandler({publicOrigin:origin,channelId:'123',verify:async()=>{throw Object.assign(new Error('secret-token'),{status:400});}});const response=await handler(req({idToken:'secret-token'}));assert.equal(response.status,401);assert.equal((await response.text()).includes('secret-token'),false);
});
test('LINE throttling remains retryable rather than a rejected identity',async()=>{
 const handler=createLineVerifyHandler({publicOrigin:origin,channelId:'123',verify:async()=>{throw Object.assign(new Error('upstream'),{status:429});}});const response=await handler(req({idToken:'secret-token'}));assert.equal(response.status,429);assert.deepEqual(await response.json(),{code:'LINE_TEMPORARILY_UNAVAILABLE'});
});
