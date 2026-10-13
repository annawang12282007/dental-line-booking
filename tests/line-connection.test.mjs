import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createD1ConnectionRepository } from '../server/line-connection.mjs';

const SCHEMA=`CREATE TABLE line_connections (
  connection_key TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL,
  provider_id TEXT NOT NULL, bot_user_id TEXT NOT NULL
)`;
const context={connectionKey:'clinic-test',tenantId:'tenant-test',providerId:'provider-test'};
const bot='U'+'a'.repeat(32);

// This adapter is also executed in separate worker threads with separate SQLite
// connections, so the race test exercises actual concurrent database clients.
function adapter(sqlite,{failAt=-1}={}) {
  return {
    prepare(sql){return {bind(...bindings){return {
      sql,bindings,
      async first(){return sqlite.prepare(sql).get(...bindings)??null;},
    };}};},
    async batch(statements){
      sqlite.exec('BEGIN IMMEDIATE');
      try{
        const results=statements.map(({sql,bindings},index)=>{
          if(index===failAt)throw new Error('database details must remain private');
          if(/^SELECT/.test(sql))return {success:true,results:sqlite.prepare(sql).all(...bindings)};
          const result=sqlite.prepare(sql).run(...bindings);
          return {success:true,meta:{changes:Number(result.changes)}};
        });
        sqlite.exec('COMMIT');return results;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
}

function fixture(t,options){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(SCHEMA);t.after(()=>sqlite.close());
  return {sqlite,repository:createD1ConnectionRepository(adapter(sqlite,options))};
}

test('binds a destination durably and accepts repeated identical enrollment',async(t)=>{
  const {sqlite,repository}=fixture(t);
  assert.equal(await repository.resolveDestination(context),null);
  assert.deepEqual(await repository.bindVerifiedDestination({...context,destination:bot}),{botUserId:bot});
  assert.equal(await repository.resolveDestination(context),bot);
  await repository.bindVerifiedDestination({...context,destination:bot});
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_connections').get().count,1);
});

test('never changes a pinned destination, tenant, or provider',async(t)=>{
  const {sqlite,repository}=fixture(t);
  await repository.bindVerifiedDestination({...context,destination:bot});
  for(const change of [{destination:'U'+'b'.repeat(32)},{tenantId:'other-tenant'},{providerId:'other-provider'}]){
    await assert.rejects(repository.bindVerifiedDestination({...context,destination:bot,...change}),{message:'LINE_CONNECTION_MISMATCH'});
  }
  for(const change of [{tenantId:'other-tenant'},{providerId:'other-provider'}]){
    await assert.rejects(repository.resolveDestination({...context,...change}),{message:'LINE_CONNECTION_MISMATCH'});
  }
  const row=sqlite.prepare('SELECT * FROM line_connections').get();
  assert.deepEqual({...row},{connection_key:context.connectionKey,tenant_id:context.tenantId,provider_id:context.providerId,bot_user_id:bot});
});

test('rejects invalid inputs and does not retain arbitrary data',async(t)=>{
  const {sqlite,repository}=fixture(t);
  for(const change of [{destination:'owner@example.test'},{destination:'U123'},{destination:'U'+'A'.repeat(32)},{tenantId:''},{providerId:'bad\n'},{connectionKey:'bad/path'}]){
    await assert.rejects(repository.bindVerifiedDestination({...context,destination:bot,...change}),{message:'INVALID_CONNECTION_INPUT'});
  }
  await repository.bindVerifiedDestination({...context,destination:bot,channelSecret:'not-retained',message:'not-retained'});
  assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM line_connections').get()).includes('not-retained'),false);
});

test('database failure between insert and select rolls back enrollment',async(t)=>{
  const {sqlite,repository}=fixture(t,{failAt:1});
  await assert.rejects(repository.bindVerifiedDestination({...context,destination:bot}),{message:'CONNECTION_STORAGE_UNAVAILABLE'});
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_connections').get().count,0);
});

test('database read failures and malformed D1 results fail closed',async()=>{
  const prepare=()=>({bind:()=>({first:async()=>{throw new Error('private db details');}})});
  const reader=createD1ConnectionRepository({prepare,batch:async()=>[]});
  await assert.rejects(reader.resolveDestination(context),{message:'CONNECTION_STORAGE_UNAVAILABLE'});
  for(const results of [undefined,[],[{success:true},{success:false}],
    [{success:true},{success:true,results:[]}], [{success:true},{success:true,results:[{},{}]}]]){
    const repository=createD1ConnectionRepository({prepare,batch:async()=>results});
    await assert.rejects(repository.bindVerifiedDestination({...context,destination:bot}),{message:'CONNECTION_STORAGE_UNAVAILABLE'});
  }
});

test('binding survives reopening the database',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'line-connection-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filename=join(directory,'connections.sqlite');
  let sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);
  try{await createD1ConnectionRepository(adapter(sqlite)).bindVerifiedDestination({...context,destination:bot});}
  finally{sqlite.close();}
  sqlite=new DatabaseSync(filename);
  try{assert.equal(await createD1ConnectionRepository(adapter(sqlite)).resolveDestination(context),bot);}
  finally{sqlite.close();}
});

test('concurrent SQLite clients cannot overwrite a connection with a different destination',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'line-connection-race-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filename=join(directory,'connections.sqlite');
  const sqlite=new DatabaseSync(filename);sqlite.exec(SCHEMA);sqlite.close();
  const source=`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const adapter=${adapter.toString()};
    (async()=>{
      const {createD1ConnectionRepository}=await import(workerData.module);
      const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=5000');
      parentPort.once('message',async()=>{
        try{await createD1ConnectionRepository(adapter(db)).bindVerifiedDestination(workerData.input);
          parentPort.postMessage({ok:true,destination:workerData.input.destination});}
        catch(error){parentPort.postMessage({ok:false,error:error.message});}
        finally{db.close();parentPort.close();}
      });
      parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({error:error.message});parentPort.close();});
  `;
  const workers=[bot,'U'+'b'.repeat(32)].map(destination=>new Worker(source,{eval:true,workerData:{
    module:new URL('../server/line-connection.mjs',import.meta.url).href,filename,input:{...context,destination},
  }}));
  t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
    worker.once('error',reject);worker.once('message',message=>message.ready?resolve():reject(new Error(message.error)));
  })));
  const resultsPromise=Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
    worker.once('error',reject);worker.once('message',resolve);
  })));
  for(const worker of workers)worker.postMessage('start');
  const results=await resultsPromise;
  assert.equal(results.filter(result=>result.ok).length,1);
  assert.equal(results.find(result=>!result.ok).error,'LINE_CONNECTION_MISMATCH');
  const readback=new DatabaseSync(filename);
  try{
    assert.equal(readback.prepare('SELECT COUNT(*) AS count FROM line_connections').get().count,1);
    assert.equal(readback.prepare('SELECT bot_user_id FROM line_connections').get().bot_user_id,results.find(result=>result.ok).destination);
  }finally{readback.close();}
});
