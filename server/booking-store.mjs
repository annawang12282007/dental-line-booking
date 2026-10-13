const DAY = 86_400_000;
const TAIPEI_OFFSET = 8 * 60 * 60 * 1000;
const ACTIVE_LIMIT = 3;
const DAILY_LIMIT = 3;
const APPOINTMENT_ORDER = "CASE WHEN a.status IN ('pending','confirmed') THEN 0 ELSE 1 END,s.start_at DESC";
const DEMO = [
  {id:'demo-clinic-taipei',name:'示範｜齒間台北診所',timeZone:'Asia/Taipei',doctors:[
    {id:'demo-taipei-lin',name:'林醫師（示範）'},{id:'demo-taipei-chen',name:'陳醫師（示範）'}]},
  {id:'demo-clinic-taichung',name:'示範｜齒間台中診所',timeZone:'Asia/Taipei',doctors:[
    {id:'demo-taichung-wang',name:'王醫師（示範）'},{id:'demo-taichung-hsu',name:'許醫師（示範）'}]},
];
const PROJECTION = `SELECT a.id,a.clinic_id,a.slot_id,a.name,a.phone,a.status,a.revision,
  a.notification_consent,a.created_at,a.payload_hash,a.last_action_id,c.name AS clinic_name,d.name AS doctor_name,s.start_at,s.end_at,
  COALESCE((SELECT o.status FROM booking_outbox o WHERE o.appointment_id=a.id
    AND o.appointment_revision=a.revision AND o.kind=a.status LIMIT 1),'skipped') AS notification_status
  FROM booking_appointments a JOIN booking_clinics c ON c.id=a.clinic_id
  JOIN booking_slots s ON s.id=a.slot_id JOIN booking_doctors d ON d.id=s.doctor_id`;
const AUDIT = `INSERT INTO booking_audits (id,appointment_id,clinic_id,actor_key,status,revision,created_at)
  SELECT ?,id,clinic_id,?,status,revision,? FROM booking_appointments WHERE id=? AND last_action_id=?`;
const OUTBOX = `INSERT INTO booking_outbox
  (id,appointment_id,appointment_revision,kind,retry_key,payload,line_cipher,status,attempts,next_attempt_at,created_at)
  SELECT ?,a.id,a.revision,a.status,?,json_object('appointmentId',a.id,'clinicName',c.name,
    'doctorName',d.name,'startAt',strftime('%Y-%m-%dT%H:%M:%fZ',s.start_at/1000.0,'unixepoch'),
    'status',a.status,'revision',a.revision),a.line_cipher,'pending',0,?,?
  FROM booking_appointments a JOIN booking_clinics c ON c.id=a.clinic_id
  JOIN booking_slots s ON s.id=a.slot_id JOIN booking_doctors d ON d.id=s.doctor_id
  WHERE a.id=? AND a.last_action_id=? AND a.notification_consent=1`;

function fault(code,status=400){return Object.assign(new Error(code),{code,status});}
function identifier(value,max=160){return typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);}
function requireId(value,code='INVALID_INPUT'){if(!identifier(value))throw fault(code);return value;}
function iso(value){return new Date(value).toISOString();}
function publicAppointment(row){return {id:row.id,clinicId:row.clinic_id,clinicName:row.clinic_name,
  doctorName:row.doctor_name,slotId:row.slot_id,startAt:iso(row.start_at),endAt:iso(row.end_at),
  name:row.name,phone:row.phone,status:row.status,revision:row.revision,
  notificationConsent:row.notification_consent===1,notificationStatus:row.notification_status,createdAt:iso(row.created_at)};}
function dateStart(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fault('INVALID_DATE');
  const result=Date.parse(`${value}T00:00:00+08:00`);
  if(!Number.isFinite(result)||iso(result+TAIPEI_OFFSET).slice(0,10)!==value)throw fault('INVALID_DATE');
  return result;
}
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
function validResults(results,length){return Array.isArray(results)&&results.length===length&&results.every(r=>r?.success===true);}

/** All writes use atomic D1 batches. Authentication and clinic authorization
 * belong at the API boundary. Patient keys and encrypted LINE IDs are private;
 * public projections never return either value. No medical history is stored. */
export function createBookingStore(db,{now=Date.now}={}){
  if(!db||typeof db.prepare!=='function'||typeof db.batch!=='function')throw new TypeError('DURABLE_D1_REQUIRED');
  const statement=(sql,...bindings)=>db.prepare(sql).bind(...bindings);
  async function first(sql,...bindings){try{return await statement(sql,...bindings).first();}catch{throw fault('BOOKING_STORAGE_UNAVAILABLE',503);}}
  async function all(sql,...bindings){try{const r=await statement(sql,...bindings).all();if(r?.success!==true||!Array.isArray(r.results))throw new Error();return r.results;}catch{throw fault('BOOKING_STORAGE_UNAVAILABLE',503);}}
  async function batch(statements){try{const r=await db.batch(statements);if(!validResults(r,statements.length))throw new Error();return r;}catch{throw fault('BOOKING_STORAGE_UNAVAILABLE',503);}}
  function auditAndOutbox(id,action,actor,time){return [statement(AUDIT,crypto.randomUUID(),actor,time,id,action),
    statement(OUTBOX,crypto.randomUUID(),crypto.randomUUID(),time,time,id,action)];}
  return {
    async catalogue(){
      const clinics=await all('SELECT id,name,time_zone FROM booking_clinics ORDER BY id');
      const doctors=await all('SELECT id,clinic_id,name FROM booking_doctors ORDER BY id');
      return {clinics:clinics.map(c=>({id:c.id,name:c.name,timeZone:c.time_zone,doctors:doctors.filter(d=>d.clinic_id===c.id).map(d=>({id:d.id,name:d.name}))}))};
    },
    async slots({clinicId,doctorId,date}={}){
      requireId(clinicId);requireId(doctorId);const start=dateStart(date),time=now();
      const rows=await all(`SELECT s.id,s.clinic_id,s.doctor_id,s.start_at,s.end_at FROM booking_slots s
        WHERE s.clinic_id=? AND s.doctor_id=? AND s.start_at>=? AND s.start_at<? AND s.start_at>?
        AND NOT EXISTS (SELECT 1 FROM booking_appointments a WHERE a.slot_id=s.id AND a.status IN ('pending','confirmed')) ORDER BY s.start_at`,clinicId,doctorId,start,start+DAY,time);
      return rows.map(s=>({id:s.id,clinicId:s.clinic_id,doctorId:s.doctor_id,startAt:iso(s.start_at),endAt:iso(s.end_at)}));
    },
    async listMine(patientKey){requireId(patientKey);return (await all(`${PROJECTION} WHERE a.patient_key=? ORDER BY ${APPOINTMENT_ORDER} LIMIT 100`,patientKey)).map(publicAppointment);},
    async findMine(id,patientKey){requireId(id);requireId(patientKey);const row=await first(`${PROJECTION} WHERE a.id=? AND a.patient_key=?`,id,patientKey);return row?publicAppointment(row):null;},
    async listAdmin(clinicId){requireId(clinicId);return (await all(`${PROJECTION} WHERE a.clinic_id=? ORDER BY ${APPOINTMENT_ORDER} LIMIT 200`,clinicId)).map(publicAppointment);},
    async seedDemo(){
      // Call only from a separately authenticated administrator endpoint. IDs
      // are deterministic so retries add future slots without replacing records.
      const time=now(),today=Math.floor((time+TAIPEI_OFFSET)/DAY)*DAY-TAIPEI_OFFSET;
      const init=[statement('INSERT OR IGNORE INTO booking_clinics (id,name,time_zone,demo) VALUES (?,?,?,1),(?,?,?,1)',...DEMO.flatMap(c=>[c.id,c.name,c.timeZone])),
        statement('INSERT OR IGNORE INTO booking_doctors (id,clinic_id,name) VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)',...DEMO.flatMap(c=>c.doctors.flatMap(d=>[d.id,c.id,d.name])))];
      const rows=[];
      for(let day=0;day<14;day++){
        for(const c of DEMO)for(const d of c.doctors)for(const hour of [9,9.5,10,10.5,11,11.5,14,14.5,15,15.5,16,16.5]){
          const start=today+day*DAY+hour*3_600_000;if(start<=time)continue;
          rows.push([`${d.id}-${start}`,c.id,d.id,start,start+1_800_000]);
        }
      }
      // At most 100 bindings per statement and fewer than 50 statements for
      // the entire seed; the single batch also rolls back incomplete seeding.
      for(let offset=0;offset<rows.length;offset+=20){const chunk=rows.slice(offset,offset+20);
        init.push(statement(`INSERT OR IGNORE INTO booking_slots (id,clinic_id,doctor_id,start_at,end_at) VALUES ${chunk.map(()=>'(?,?,?,?,?)').join(',')}`,...chunk.flat()));}
      const results=await batch(init),insertedSlots=results.slice(2).reduce((sum,r)=>sum+(r.meta?.changes??0),0);
      const totals=await first('SELECT (SELECT count(*) FROM booking_clinics) AS clinics,(SELECT count(*) FROM booking_doctors) AS doctors,(SELECT count(*) FROM booking_slots WHERE start_at>?) AS slots',time);
      return {...totals,insertedSlots};
    },
    async book({patientKey,lineCipher,slotId,name,phone,consent,idempotencyKey}={}){
      requireId(patientKey);requireId(slotId);requireId(idempotencyKey);
      if(typeof lineCipher!=='string'||lineCipher.length<8||lineCipher.length>8192||/[\u0000-\u001f]/u.test(lineCipher))throw fault('INVALID_LINE_IDENTITY');
      if(typeof name!=='string'||!name.trim()||name.trim().length>60||/[\u0000-\u001f\u007f]/u.test(name))throw fault('INVALID_NAME');
      name=name.trim();phone=typeof phone==='string'?phone.replace(/[\s-]/g,'').replace(/^\+886/,'0'):'';
      if(!/^09\d{8}$/.test(phone))throw fault('INVALID_PHONE');if(typeof consent!=='boolean')throw fault('INVALID_CONSENT');
      const payloadHash=await digest(JSON.stringify({slotId,name,phone,consent}));
      const id=crypto.randomUUID(),action=crypto.randomUUID(),time=now();
      const inserted=statement(`INSERT INTO booking_appointments
        (id,clinic_id,slot_id,patient_key,line_cipher,name,phone,status,revision,notification_consent,idempotency_key,payload_hash,created_at,updated_at,last_action_id)
        SELECT ?,s.clinic_id,s.id,?,?,?,?,'pending',1,?,?,?,?,?,? FROM booking_slots s
        WHERE s.id=? AND s.start_at>? AND
        (SELECT count(*) FROM booking_appointments a JOIN booking_slots used ON used.id=a.slot_id
         WHERE a.patient_key=? AND a.status IN ('pending','confirmed') AND used.start_at>?)<? AND
        (SELECT count(*) FROM booking_appointments recent WHERE recent.patient_key=? AND recent.created_at>?)<?
        ON CONFLICT DO NOTHING`,id,patientKey,lineCipher,name,phone,consent?1:0,idempotencyKey,payloadHash,time,time,action,slotId,time,patientKey,time,ACTIVE_LIMIT,patientKey,time-DAY,DAILY_LIMIT);
      const results=await batch([inserted,...auditAndOutbox(id,action,patientKey,time),
        statement(`${PROJECTION} WHERE a.patient_key=? AND a.idempotency_key=?`,patientKey,idempotencyKey)]);
      if(!Array.isArray(results[3].results))throw fault('BOOKING_STORAGE_UNAVAILABLE',503);
      const existing=results[3].results?.[0];
      if(existing){if(existing.payload_hash!==payloadHash)throw fault('IDEMPOTENCY_CONFLICT',409);
        return publicAppointment(existing);}
      const slot=await first('SELECT start_at FROM booking_slots WHERE id=?',slotId);
      if(!slot)throw fault('SLOT_NOT_FOUND',404);if(slot.start_at<=time)throw fault('SLOT_IN_PAST',409);
      const active=await first(`SELECT count(*) AS total FROM booking_appointments a JOIN booking_slots s ON s.id=a.slot_id WHERE a.patient_key=? AND a.status IN ('pending','confirmed') AND s.start_at>?`,patientKey,time);
      if(active.total>=ACTIVE_LIMIT)throw fault('ACTIVE_BOOKING_LIMIT',409);
      // Count creations across every clinic and status. Cancelling frees the
      // slot, but never refunds the rolling 24-hour anti-abuse allowance.
      const recent=await first('SELECT count(*) AS total FROM booking_appointments WHERE patient_key=? AND created_at>?',patientKey,time-DAY);
      if(recent.total>=DAILY_LIMIT)throw fault('DAILY_BOOKING_LIMIT',409);
      throw fault('SLOT_UNAVAILABLE',409);
    },
    async transition({id,clinicId,actorKey,status,expectedRevision,patientKey}={}){
      requireId(id);requireId(clinicId);requireId(actorKey);
      if(!['confirmed','cancelled'].includes(status)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fault('INVALID_TRANSITION');
      if(patientKey!==undefined){requireId(patientKey);if(status!=='cancelled'||actorKey!==patientKey)throw fault('FORBIDDEN',403);}
      const time=now(),action=crypto.randomUUID(),scope=patientKey===undefined?'':' AND patient_key=?';
      const bindings=[status,time,action,id,clinicId,expectedRevision,...(patientKey===undefined?[]:[patientKey])];
      const from=status==='confirmed'?"status='pending'":"status IN ('pending','confirmed')";
      const results=await batch([statement(`UPDATE booking_appointments SET status=?,revision=revision+1,updated_at=?,last_action_id=?
        WHERE id=? AND clinic_id=? AND revision=?${scope} AND ${from}`,...bindings),...auditAndOutbox(id,action,actorKey,time),
        statement(`${PROJECTION} WHERE a.id=? AND a.clinic_id=?${patientKey===undefined?'':' AND a.patient_key=?'}`,id,clinicId,...(patientKey===undefined?[]:[patientKey]))]);
      if(!Array.isArray(results[3].results))throw fault('BOOKING_STORAGE_UNAVAILABLE',503);
      const row=results[3].results?.[0];
      if(!row)throw fault('APPOINTMENT_NOT_FOUND',404);
      if(row.last_action_id!==action){if(row.revision!==expectedRevision)throw fault('REVISION_CONFLICT',409);throw fault('INVALID_TRANSITION',409);}
      return publicAppointment(row);
    },
  };
}
