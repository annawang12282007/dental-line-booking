import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBookingAuth, assertMutation, readBookingJson } from '../server/booking-auth.mjs';
const OWNER = 'U'+'a'.repeat(32), PATIENT = 'U'+'b'.repeat(32), SECRET = 'x'.repeat(64);
const ORIGIN='https://booking.example.test';
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE booking_sessions(token_hash TEXT PRIMARY KEY,patient_key TEXT,line_cipher TEXT,expires_at INTEGER,created_at INTEGER); CREATE TABLE booking_rate_limits(key TEXT PRIMARY KEY,count INTEGER,expires_at INTEGER);');
  t.after(()=>sqlite.close());
  const statement=(sql,values=[])=>({sql,values,bind(...args){return statement(sql,args);},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){const r=sqlite.prepare(sql).run(...values);return{success:true,meta:{changes:Number(r.changes)}};}});
  const db={prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  let time=Date.parse('2026-10-13T09:00:00Z');
  const options={db,secret:SECRET,providerId:'1234567891',adminLineId:OWNER,now:()=>time};
  return{sqlite,db,options,auth:createBookingAuth(options),advance(ms){time+=ms;},expiresAt:Math.floor(time/1000)+3600};
}
const request=cookie=>new Request(ORIGIN,{headers:{cookie}});
test('sessions use secure opaque cookies, store no raw LINE subject or token, and survive new handler instances',async t=>{
  const f=fixture(t),created=await f.auth.establish({userId:PATIENT,expiresAt:f.expiresAt});
  assert.match(created.cookie,/__Host-dental_session=.+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const rows=JSON.stringify(f.sqlite.prepare('SELECT * FROM booking_sessions').all());
  assert.ok(!rows.includes(PATIENT));assert.ok(!rows.includes(created.token));
  const session=await createBookingAuth(f.options).read(request(created.cookie.split(';')[0]));
  assert.equal(session.patientKey,created.patientKey);assert.equal(session.isAdmin,false);assert.ok(session.csrfToken);
  assert.equal(await f.auth.decryptLineId(session.lineCipher),PATIENT);
});
test('admin privilege is limited to configured subject and never obtained by cookie editing',async t=>{
  const f=fixture(t);const owner=await f.auth.establish({userId:OWNER,expiresAt:f.expiresAt});
  assert.equal((await f.auth.read(request(owner.cookie.split(';')[0]))).isAdmin,true);
  assert.equal(await f.auth.read(request('__Host-dental_session='+OWNER)),null);
  assert.equal(await f.auth.read(request(owner.cookie.split(';')[0]+'; '+owner.cookie.split(';')[0])),null);
  const noAdmin=createBookingAuth({...f.options,adminLineId:undefined});
  assert.equal((await noAdmin.read(request(owner.cookie.split(';')[0]))).isAdmin,false);
});
test('expired and logged-out sessions are rejected',async t=>{
  const f=fixture(t);const created=await f.auth.establish({userId:PATIENT,expiresAt:f.expiresAt});
  const req=request(created.cookie.split(';')[0]);const session=await f.auth.read(req);
  await f.auth.logout(session);assert.equal(await f.auth.read(req),null);
  const next=await f.auth.establish({userId:PATIENT,expiresAt:f.expiresAt});
  f.advance(3600001);assert.equal(await f.auth.read(request(next.cookie.split(';')[0])),null);
  await assert.rejects(f.auth.establish({userId:PATIENT,expiresAt:f.expiresAt}),{code:'LOGIN_EXPIRED'});
});
test('encrypted subjects reject tampering, another provider, and another key',async t=>{
  const f=fixture(t),cipher=await f.auth.encryptLineId(PATIENT);
  const changed=cipher.slice(0,20)+(cipher[20]==='A'?'B':'A')+cipher.slice(21);
  for(const [auth,value]of[[f.auth,changed],[createBookingAuth({...f.options,providerId:'123'}),cipher],[createBookingAuth({...f.options,secret:'z'.repeat(64)}),cipher]]) await assert.rejects(auth.decryptLineId(value),{code:'IDENTITY_UNAVAILABLE'});
});
test('mutations require exact origin, JSON and the session-specific CSRF value',async t=>{
  const f=fixture(t),created=await f.auth.establish({userId:PATIENT,expiresAt:f.expiresAt});
  const session=await f.auth.read(request(created.cookie.split(';')[0]));
  const headers={'origin':ORIGIN,'content-type':'application/json','x-csrf-token':session.csrfToken};
  assert.doesNotThrow(()=>assertMutation(new Request(ORIGIN,{method:'POST',headers}),ORIGIN,session));
  for(const change of [{origin:'https://attacker.test'},{'x-csrf-token':'wrong'},{'content-type':'text/plain'}])assert.throws(()=>assertMutation(new Request(ORIGIN,{method:'POST',headers:{...headers,...change}}),ORIGIN,session));
});
test('rate limit is durable across instances, atomic, and expires without storing raw identifiers',async t=>{
  const f=fixture(t);await f.auth.rateLimit('login','192.0.2.1',2,60000);await createBookingAuth(f.options).rateLimit('login','192.0.2.1',2,60000);
  await assert.rejects(f.auth.rateLimit('login','192.0.2.1',2,60000),{code:'RATE_LIMITED'});
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM booking_rate_limits').all()).includes('192.0.2.1'));
  f.advance(60001);await f.auth.rateLimit('login','192.0.2.1',2,60000);
});
test('bounded body reader rejects arrays, malformed JSON and oversized streamed content',async()=>{
  for(const body of ['[]','oops',JSON.stringify({value:'x'.repeat(200)})])await assert.rejects(readBookingJson(new Request(ORIGIN,{method:'POST',body}),100),{code:'INVALID_REQUEST'});
  assert.deepEqual(await readBookingJson(new Request(ORIGIN,{method:'POST',body:'{"consent":false}'})),{consent:false});
});
