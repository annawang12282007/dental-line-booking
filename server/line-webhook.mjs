import {verifyWebhookSignature,parseWebhook} from './line.mjs';

const MAX_BYTES=1024*1024;
const json=(status,code)=>Response.json({code},{status,headers:{'Cache-Control':'no-store'}});

async function rawBytes(request){
  const declared=request.headers.get('content-length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES))throw Object.assign(new Error('BODY_TOO_LARGE'),{status:413});
  if(!request.body)return new Uint8Array();
  const reader=request.body.getReader();const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Object.assign(new Error('BODY_TOO_LARGE'),{status:413});}chunks.push(value);}}
  finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}

/**
 * Integration boundary, not a deployed server. Pass this handler the validated
 * connection key captured from a route, never a tenant ID supplied in the body.
 *
 * resolveConnection(key) -> {tenantId,providerId,botUserId,channelSecret,enabled,
 *                           allowDestinationEnrollment?}
 * repository.acceptWebhookEvents({connectionKey,tenantId,providerId,destination,events})
 * must durably and atomically insert an inbox before resolving. Use a unique key
 * (connectionKey, webhookEventId). This gateway records receipts without dispatch.
 * The repository must not forward messages or silently substitute memory storage.
 * Raw message text/reply tokens are removed before the repository sees the input.
 * An absent botUserId fails closed unless enrollment is explicitly enabled and a
 * durable binder exists. Enrollment accepts only channel-signed empty Verify
 * requests; normal events cannot choose a destination or establish a connection.
 */
export function createLineWebhookHandler({resolveConnection,repository}){
  if(typeof resolveConnection!=='function')throw new TypeError('CONNECTION_RESOLVER_REQUIRED');
  return async function handle(request,connectionKey){
    if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
    if(typeof connectionKey!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(connectionKey))return json(404,'NOT_FOUND');
    let connection;
    try{connection=await resolveConnection(connectionKey);}catch{return json(503,'CONFIGURATION_UNAVAILABLE');}
    if(!connection?.enabled)return json(404,'NOT_FOUND');
    const canEnroll=!connection.botUserId&&connection.allowDestinationEnrollment===true&&typeof repository?.bindVerifiedDestination==='function';
    if(!connection.tenantId||!connection.providerId||!connection.channelSecret||(!connection.botUserId&&!canEnroll))return json(503,'CONFIGURATION_INCOMPLETE');
    const signature=request.headers.get('x-line-signature');
    let raw;
    try{raw=await rawBytes(request);}catch(e){return json(e?.status===413?413:400,e?.status===413?'BODY_TOO_LARGE':'INVALID_BODY');}
    if(!await verifyWebhookSignature(raw,signature,connection.channelSecret))return json(401,'INVALID_SIGNATURE');
    let parsed;
    try{parsed=parseWebhook(raw,connection.botUserId||undefined);}catch(e){return json(e?.status===403?403:400,'INVALID_WEBHOOK');}
    if(!connection.botUserId){
      if(parsed.events.length!==0)return json(503,'DESTINATION_NOT_ENROLLED');
      if(!/^U[0-9a-f]{32}$/.test(parsed.destination))return json(400,'INVALID_WEBHOOK');
      try{await repository.bindVerifiedDestination({connectionKey,tenantId:connection.tenantId,providerId:connection.providerId,destination:parsed.destination});}
      catch{return json(503,'DESTINATION_ENROLLMENT_UNAVAILABLE');}
      return json(200,'VERIFIED');
    }
    // LINE's Verify request has no events. Confirm signature/config independently.
    if(parsed.events.length===0)return json(200,'VERIFIED');
    if(typeof repository?.acceptWebhookEvents!=='function')return json(503,'DURABLE_INBOX_REQUIRED');
    try{await repository.acceptWebhookEvents({connectionKey,tenantId:connection.tenantId,providerId:connection.providerId,destination:parsed.destination,events:parsed.events});}
    catch{return json(503,'INBOX_UNAVAILABLE');}
    return json(200,'ACCEPTED');
  };
}
