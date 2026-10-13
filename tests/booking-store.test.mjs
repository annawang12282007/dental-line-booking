import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createBookingStore } from '../server/booking-store.mjs';

const TIME=Date.parse('2026-10-13T00:00:00Z');
const SCHEMA=(await Promise.all((await readdir(new URL('../drizzle/',import.meta.url)))
  .filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')))).join('\n');

// Real SQLite transactions mirror D1 batch atomicity. Threaded tests use
// separate connections to one disk database to exercise actual write races.
function adapter(sqlite,{failAt=-1}={}){
  const run=({sql,bindings})=>{const query=sqlite.prepare(sql);
    if(/^\s*SELECT/i.test(sql))return {success:true,results:query.all(...bindings)};
    const r=query.run(...bindings);return {success:true,results:[],meta:{changes:Number(r.changes)}};};
  return {
    prepare(sql){return {bind(...bindings){return {sql,bindings,
      async first(){return sqlite.prepare(sql).get(...bindings)??null;},
      async all(){return run({sql,bindings});},
    };}};},
    async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{
      const results=statements.map((s,index)=>{if(index===failAt)throw new Error('private database failure');return run(s);});
      sqlite.exec('COMMIT');return results;
    }catch(error){sqlite.exec('ROLLBACK');throw error;}},
  };
}
async function fixture(t){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(SCHEMA);t.after(()=>sqlite.close());
  let time=TIME;const store=createBookingStore(adapter(sqlite),{now:()=>time});
  await store.seedDemo();const {clinics}=await store.catalogue();
  const slots=await store.slots({clinicId:clinics[0].id,doctorId:clinics[0].doctors[0].id,date:'2026-10-13'});
  const input={patientKey:'hmac-patient-one',lineCipher:'encrypted-line-subject',slotId:slots[0].id,name:'測試病患',phone:'0912345678',consent:true,idempotencyKey:'request-one'};
  return {sqlite,store,clinics,slots,input,setTime:value=>{time=value;}};
}
const count=(sqlite,table)=>sqlite.prepare(`SELECT count(*) AS total FROM ${table}`).get().total;
const code=(expected,status)=>error=>error.code===expected&&(status===undefined||error.status===status)&&!error.message.includes('private');

test('migrations are empty; explicit demo seed is idempotent and extends schedules without erasing appointments',async(t)=>{
  const empty=new DatabaseSync(':memory:');empty.exec(SCHEMA);assert.equal(count(empty,'booking_clinics'),0);assert.equal(count(empty,'booking_slots'),0);empty.close();
  const {store,sqlite,input,setTime}=await fixture(t);assert.equal(count(sqlite,'booking_clinics'),2);assert.equal(count(sqlite,'booking_doctors'),4);assert.equal(count(sqlite,'booking_slots'),672);
  assert.equal((await store.seedDemo()).insertedSlots,0);const booked=await store.book(input);
  setTime(TIME+86_400_000);assert.equal((await store.seedDemo()).insertedSlots,48);
  assert.equal((await store.listMine(input.patientKey))[0].id,booked.id);assert.equal(count(sqlite,'booking_slots'),720);
});

test('catalogue and available slots obey clinic, doctor, Taiwan date and future boundaries',async(t)=>{
  const {store,clinics,slots,setTime}=await fixture(t);assert.equal(clinics.length,2);assert.equal(clinics[0].timeZone,'Asia/Taipei');assert.equal(slots.length,12);
  assert.equal(slots[0].startAt,'2026-10-13T01:00:00.000Z');assert.equal(slots[0].endAt,'2026-10-13T01:30:00.000Z');
  assert.deepEqual(await store.slots({clinicId:clinics[1].id,doctorId:clinics[0].doctors[0].id,date:'2026-10-13'}),[]);
  for(const date of ['2026-02-30','bad','2026-1-1'])await assert.rejects(store.slots({clinicId:clinics[0].id,doctorId:clinics[0].doctors[0].id,date}),code('INVALID_DATE',400));
  setTime(Date.parse(slots[0].startAt));assert.equal((await store.slots({clinicId:clinics[0].id,doctorId:clinics[0].doctors[0].id,date:'2026-10-13'})).length,11);
});

test('booking atomically creates appointment, audit and minimal notification; public data excludes identity secrets',async(t)=>{
  const {store,sqlite,input,clinics}=await fixture(t);const result=await store.book({...input,phone:'+886 912-345-678'});
  assert.equal(result.status,'pending');assert.equal(result.revision,1);assert.equal(result.phone,'0912345678');assert.equal(result.notificationStatus,'pending');
  for(const key of ['patientKey','patient_key','lineCipher','line_cipher','payload_hash','last_action_id'])assert.equal(Object.hasOwn(result,key),false);
  assert.equal(count(sqlite,'booking_audits'),1);assert.equal(count(sqlite,'booking_outbox'),1);
  const payload=JSON.parse(sqlite.prepare('SELECT payload FROM booking_outbox').get().payload);
  assert.deepEqual(Object.keys(payload).sort(),['appointmentId','clinicName','doctorName','revision','startAt','status']);
  assert.equal(payload.appointmentId,result.id);assert.equal(payload.startAt,result.startAt);assert.equal(JSON.stringify(payload).includes(input.phone),false);
  assert.equal((await store.listMine(input.patientKey)).length,1);assert.deepEqual(await store.listMine('other-patient'),[]);
  assert.equal((await store.listAdmin(clinics[0].id))[0].id,result.id);assert.deepEqual(await store.listAdmin(clinics[1].id),[]);
});

test('notification consent false creates no delivery task across all transitions',async(t)=>{
  const {store,sqlite,input}=await fixture(t);const result=await store.book({...input,consent:false});assert.equal(result.notificationStatus,'skipped');
  const confirmed=await store.transition({id:result.id,clinicId:result.clinicId,actorKey:'admin-hash',status:'confirmed',expectedRevision:1});
  assert.equal(confirmed.notificationStatus,'skipped');assert.equal(count(sqlite,'booking_outbox'),0);assert.equal(count(sqlite,'booking_audits'),2);
});

test('stable idempotency replays one booking but changed payload fails without audit or outbox duplication',async(t)=>{
  const {store,sqlite,input,slots}=await fixture(t);const original=await store.book(input);assert.deepEqual(await store.book(input),original);
  for(const change of [{name:'其他姓名'},{slotId:slots[1].id},{consent:false},{phone:'0987654321'}])await assert.rejects(store.book({...input,...change}),code('IDEMPOTENCY_CONFLICT',409));
  assert.equal(count(sqlite,'booking_appointments'),1);assert.equal(count(sqlite,'booking_audits'),1);assert.equal(count(sqlite,'booking_outbox'),1);
});

test('one active reservation holds a slot; cancellation releases it for a new booking',async(t)=>{
  const {store,sqlite,input}=await fixture(t);const original=await store.book(input);
  const second={...input,patientKey:'other-patient',idempotencyKey:'request-two'};
  await assert.rejects(store.book(second),code('SLOT_UNAVAILABLE',409));
  const cancelled=await store.transition({id:original.id,clinicId:original.clinicId,actorKey:input.patientKey,patientKey:input.patientKey,status:'cancelled',expectedRevision:1});
  assert.equal(cancelled.revision,2);assert.equal((await store.book(second)).status,'pending');assert.equal(count(sqlite,'booking_appointments'),2);
});

test('active patient bookings are bounded and past or missing slots cannot be booked',async(t)=>{
  const {store,input,slots,setTime}=await fixture(t);
  for(let i=0;i<3;i++)await store.book({...input,slotId:slots[i].id,idempotencyKey:`request-${i}`});
  await assert.rejects(store.book({...input,slotId:slots[3].id,idempotencyKey:'fourth'}),code('ACTIVE_BOOKING_LIMIT',409));
  await assert.rejects(store.book({...input,slotId:'missing',idempotencyKey:'missing'}),code('SLOT_NOT_FOUND',404));
  setTime(Date.parse(slots[0].startAt));await assert.rejects(store.book({...input,patientKey:'other',idempotencyKey:'past'}),code('SLOT_IN_PAST',409));
});

test('rolling creation allowance includes cancelled bookings across clinics, while replays and other patients do not consume it',async(t)=>{
  const {store,sqlite,input,clinics,slots}=await fixture(t);
  const otherClinicSlots=await store.slots({clinicId:clinics[1].id,doctorId:clinics[1].doctors[0].id,date:'2026-10-13'});
  const requests=[slots[0],otherClinicSlots[0],slots[1]].map((slot,index)=>({...input,slotId:slot.id,idempotencyKey:`daily-${index}`}));
  for(const request of requests){const booking=await store.book(request);await store.transition({id:booking.id,clinicId:booking.clinicId,
    patientKey:input.patientKey,actorKey:input.patientKey,status:'cancelled',expectedRevision:1});}
  await assert.rejects(store.book({...input,slotId:otherClinicSlots[1].id,idempotencyKey:'daily-fourth'}),code('DAILY_BOOKING_LIMIT',409));
  for(const request of requests)assert.equal((await store.book(request)).status,'cancelled');
  await assert.rejects(store.book({...requests[0],name:'其他姓名'}),code('IDEMPOTENCY_CONFLICT',409));
  assert.equal(count(sqlite,'booking_appointments'),3);assert.equal(count(sqlite,'booking_audits'),6);assert.equal(count(sqlite,'booking_outbox'),6);
  assert.equal((await store.book({...input,patientKey:'other-patient',slotId:otherClinicSlots[1].id,idempotencyKey:'daily-fourth'})).status,'pending');
});

test('rolling 24-hour quota survives midnight and releases each creation exactly at its individual boundary',async(t)=>{
  const {store,sqlite,input,clinics,slots,setTime}=await fixture(t);
  for(let index=0;index<3;index++){
    setTime(TIME+index);const booking=await store.book({...input,slotId:slots[index].id,idempotencyKey:`rolling-${index}`});
    await store.transition({id:booking.id,clinicId:booking.clinicId,patientKey:input.patientKey,actorKey:input.patientKey,status:'cancelled',expectedRevision:1});
  }
  const tomorrow=await store.slots({clinicId:clinics[0].id,doctorId:clinics[0].doctors[0].id,date:'2026-10-14'});
  const request={...input,slotId:tomorrow[0].id,idempotencyKey:'after-boundary'};
  setTime(TIME+16*3_600_000);await assert.rejects(store.book(request),code('DAILY_BOOKING_LIMIT',409));
  setTime(TIME+86_400_000-1);await assert.rejects(store.book(request),code('DAILY_BOOKING_LIMIT',409));
  setTime(TIME+86_400_000);assert.equal((await store.book(request)).status,'pending');
  await assert.rejects(store.book({...input,slotId:tomorrow[1].id,idempotencyKey:'still-three'}),code('DAILY_BOOKING_LIMIT',409));
  assert.equal(count(sqlite,'booking_appointments'),4);
});

test('active-first lists retain pending and confirmed bookings despite long cancellation histories; ownership lookup is unbounded',async(t)=>{
  const {store,sqlite,input,slots,clinics}=await fixture(t);
  const pending=await store.book(input),second=await store.book({...input,slotId:slots[1].id,idempotencyKey:'second-active'});
  const confirmed=await store.transition({id:second.id,clinicId:second.clinicId,actorKey:'admin-hash',status:'confirmed',expectedRevision:1});
  const later=sqlite.prepare('SELECT id FROM booking_slots WHERE clinic_id=? ORDER BY start_at DESC LIMIT 1').get(clinics[0].id);
  const clone=sqlite.prepare(`INSERT INTO booking_appointments
    (id,clinic_id,slot_id,patient_key,line_cipher,name,phone,status,revision,notification_consent,idempotency_key,payload_hash,created_at,updated_at,last_action_id)
    SELECT ?,clinic_id,?,patient_key,line_cipher,name,phone,'cancelled',1,0,?,payload_hash,created_at,updated_at,? FROM booking_appointments WHERE id=?`);
  for(let index=0;index<220;index++)clone.run(`history-${index}`,later.id,`history-${index}`,`history-${index}`,pending.id);
  const mine=await store.listMine(input.patientKey),admin=await store.listAdmin(clinics[0].id);
  assert.equal(mine.length,100);assert.equal(admin.length,200);
  for(const list of [mine,admin])assert.deepEqual(list.slice(0,2).map(booking=>booking.id),[confirmed.id,pending.id]);
  const lookedUp=await store.findMine('history-219',input.patientKey);assert.equal(lookedUp.id,'history-219');
  assert.equal(Object.hasOwn(lookedUp,'patient_key'),false);assert.equal(Object.hasOwn(lookedUp,'line_cipher'),false);
  assert.equal(await store.findMine(pending.id,'other-patient'),null);assert.equal(await store.findMine('missing',input.patientKey),null);
});

test('invalid contact and identity input never stores a booking',async(t)=>{
  const {store,sqlite,input}=await fixture(t);
  for(const [change,expected] of [[{name:''},'INVALID_NAME'],[{name:'bad\nname'},'INVALID_NAME'],[{phone:'123'},'INVALID_PHONE'],[{phone:'02-12345678'},'INVALID_PHONE'],[{consent:'true'},'INVALID_CONSENT'],[{lineCipher:''},'INVALID_LINE_IDENTITY'],[{patientKey:''},'INVALID_INPUT'],[{idempotencyKey:'bad\n'},'INVALID_INPUT']])
    await assert.rejects(store.book({...input,...change}),code(expected,400));
  assert.equal(count(sqlite,'booking_appointments'),0);
});

test('transitions enforce patient ownership, clinic scope, optimistic revision and irreversible cancellation',async(t)=>{
  const {store,sqlite,input,clinics}=await fixture(t);const original=await store.book(input);
  const action={id:original.id,clinicId:original.clinicId,actorKey:'admin-hash',status:'confirmed',expectedRevision:1};
  await assert.rejects(store.transition({...action,clinicId:clinics[1].id}),code('APPOINTMENT_NOT_FOUND',404));
  await assert.rejects(store.transition({...action,patientKey:'other',actorKey:'other',status:'cancelled'}),code('APPOINTMENT_NOT_FOUND',404));
  await assert.rejects(store.transition({...action,patientKey:input.patientKey,actorKey:input.patientKey}),code('FORBIDDEN',403));
  const confirmed=await store.transition(action);assert.equal(confirmed.revision,2);assert.equal(confirmed.status,'confirmed');
  await assert.rejects(store.transition({...action,status:'cancelled'}),code('REVISION_CONFLICT',409));
  const cancelled=await store.transition({...action,status:'cancelled',expectedRevision:2});assert.equal(cancelled.revision,3);
  await assert.rejects(store.transition({...action,expectedRevision:3}),code('INVALID_TRANSITION',409));
  assert.equal(count(sqlite,'booking_audits'),3);assert.equal(count(sqlite,'booking_outbox'),3);
});

test('failure in audit/outbox rolls back booking and transition changes as one transaction',async(t)=>{
  const {store,sqlite,input}=await fixture(t);
  for(const failAt of [1,2]){const failing=createBookingStore(adapter(sqlite,{failAt}),{now:()=>TIME});
    await assert.rejects(failing.book(input),code('BOOKING_STORAGE_UNAVAILABLE',503));assert.equal(count(sqlite,'booking_appointments'),0);}
  const original=await store.book(input);const failing=createBookingStore(adapter(sqlite,{failAt:2}),{now:()=>TIME});
  await assert.rejects(failing.transition({id:original.id,clinicId:original.clinicId,actorKey:'admin-hash',status:'confirmed',expectedRevision:1}),code('BOOKING_STORAGE_UNAVAILABLE',503));
  assert.equal((await store.listMine(input.patientKey))[0].status,'pending');assert.equal(count(sqlite,'booking_audits'),1);assert.equal(count(sqlite,'booking_outbox'),1);
});

test('database reopen preserves reservations and replay identity',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'booking-persistence-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=join(directory,'booking.sqlite');
  let sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);let store=createBookingStore(adapter(sqlite),{now:()=>TIME});await store.seedDemo();
  const {clinics}=await store.catalogue(),slots=await store.slots({clinicId:clinics[0].id,doctorId:clinics[0].doctors[0].id,date:'2026-10-13'});
  const input={patientKey:'patient-hash',lineCipher:'ciphertext',slotId:slots[0].id,name:'測試',phone:'0912345678',consent:true,idempotencyKey:'persistent-request'};
  const original=await store.book(input);sqlite.close();sqlite=new DatabaseSync(filename);store=createBookingStore(adapter(sqlite),{now:()=>TIME});
  try{assert.deepEqual(await store.book(input),original);assert.equal(count(sqlite,'booking_appointments'),1);}finally{sqlite.close();}
});

test('simultaneous clients competing for one slot create exactly one appointment, audit and notification',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'booking-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=join(directory,'booking.sqlite');
  const sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);const store=createBookingStore(adapter(sqlite),{now:()=>TIME});await store.seedDemo();
  const slot=sqlite.prepare('SELECT id FROM booking_slots ORDER BY start_at LIMIT 1').get();sqlite.close();
  const source=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
    const adapter=${adapter.toString()};(async()=>{const {createBookingStore}=await import(workerData.module);
      const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=5000');
      const store=createBookingStore(adapter(db),{now:()=>workerData.now});
      parentPort.once('message',async()=>{try{const result=await store.book(workerData.input);parentPort.postMessage({ok:true,id:result.id});}
        catch(error){parentPort.postMessage({ok:false,code:error.code});}finally{db.close();parentPort.close();}});parentPort.postMessage({ready:true});})();`;
  const workers=[1,2].map(number=>new Worker(source,{eval:true,workerData:{module:new URL('../server/booking-store.mjs',import.meta.url).href,
    filename,now:TIME,input:{patientKey:`patient-${number}`,lineCipher:'ciphertext',slotId:slot.id,name:'測試',phone:'0912345678',consent:true,idempotencyKey:'race'}}}));
  t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',m=>m.ready?resolve():reject(new Error('worker not ready')));})));
  const done=Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);})));workers.forEach(worker=>worker.postMessage('start'));
  const results=await done;assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'SLOT_UNAVAILABLE');
  const readback=new DatabaseSync(filename);try{for(const table of ['booking_appointments','booking_audits','booking_outbox'])assert.equal(count(readback,table),1);}finally{readback.close();}
});

async function concurrentJobs(t,filename,jobs){
  const source=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
    const adapter=${adapter.toString()};(async()=>{const {createBookingStore}=await import(workerData.module);
      const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=5000');
      const store=createBookingStore(adapter(db),{now:()=>workerData.now});
      parentPort.once('message',async()=>{try{const result=await store[workerData.method](workerData.input);parentPort.postMessage({ok:true,result});}
        catch(error){parentPort.postMessage({ok:false,code:error.code});}finally{db.close();parentPort.close();}});parentPort.postMessage({ready:true});})();`;
  const workers=jobs.map(job=>new Worker(source,{eval:true,workerData:{module:new URL('../server/booking-store.mjs',import.meta.url).href,filename,now:TIME,...job}}));
  t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',m=>m.ready?resolve():reject(new Error('worker not ready')));})));
  const done=Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);})));workers.forEach(worker=>worker.postMessage('start'));return done;
}

test('concurrent booking-limit and optimistic-transition races cannot bypass atomic predicates',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'booking-predicate-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=join(directory,'booking.sqlite');
  let sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);const store=createBookingStore(adapter(sqlite),{now:()=>TIME});await store.seedDemo();
  const slots=sqlite.prepare('SELECT id FROM booking_slots ORDER BY start_at,id LIMIT 4').all();
  const input={patientKey:'patient-race',lineCipher:'ciphertext',name:'測試',phone:'0912345678',consent:true};
  const existing=[];for(let i=0;i<2;i++)existing.push(await store.book({...input,slotId:slots[i].id,idempotencyKey:`before-${i}`}));sqlite.close();
  const bookingResults=await concurrentJobs(t,filename,[2,3].map(i=>({method:'book',input:{...input,slotId:slots[i].id,idempotencyKey:`race-${i}`}})));
  assert.equal(bookingResults.filter(r=>r.ok).length,1);assert.equal(bookingResults.find(r=>!r.ok).code,'ACTIVE_BOOKING_LIMIT');
  const transitionResults=await concurrentJobs(t,filename,['confirmed','cancelled'].map(status=>({method:'transition',input:{
    id:existing[0].id,clinicId:existing[0].clinicId,actorKey:'admin-hash',expectedRevision:1,status}})));
  assert.equal(transitionResults.filter(r=>r.ok).length,1);assert.equal(transitionResults.find(r=>!r.ok).code,'REVISION_CONFLICT');
  sqlite=new DatabaseSync(filename);try{
    assert.equal(count(sqlite,'booking_appointments'),3);assert.equal(count(sqlite,'booking_audits'),4);assert.equal(count(sqlite,'booking_outbox'),4);
    assert.equal(sqlite.prepare('SELECT revision FROM booking_appointments WHERE id=?').get(existing[0].id).revision,2);
  }finally{sqlite.close();}
});

test('simultaneous creations cannot exceed the daily allowance after earlier bookings were cancelled',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'booking-daily-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=join(directory,'booking.sqlite');
  let sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);const store=createBookingStore(adapter(sqlite),{now:()=>TIME});await store.seedDemo();
  const slots=sqlite.prepare('SELECT id FROM booking_slots ORDER BY start_at,id LIMIT 4').all();
  const input={patientKey:'patient-daily-race',lineCipher:'ciphertext',name:'測試',phone:'0912345678',consent:true};
  for(let index=0;index<2;index++){
    const booking=await store.book({...input,slotId:slots[index].id,idempotencyKey:`before-daily-${index}`});
    await store.transition({id:booking.id,clinicId:booking.clinicId,patientKey:input.patientKey,actorKey:input.patientKey,status:'cancelled',expectedRevision:1});
  }
  sqlite.close();const results=await concurrentJobs(t,filename,[2,3].map(index=>({method:'book',input:{...input,slotId:slots[index].id,idempotencyKey:`daily-race-${index}`}})));
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(results.find(result=>!result.ok).code,'DAILY_BOOKING_LIMIT');
  sqlite=new DatabaseSync(filename);try{
    assert.equal(count(sqlite,'booking_appointments'),3);assert.equal(count(sqlite,'booking_audits'),5);assert.equal(count(sqlite,'booking_outbox'),5);
    assert.equal(sqlite.prepare("SELECT count(*) AS total FROM booking_appointments WHERE status IN ('pending','confirmed')").get().total,1);
  }finally{sqlite.close();}
});
