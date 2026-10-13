import {verifyLineIdToken} from './line.mjs';
import {bookingBrand} from '../lib/booking-brand.mjs';

const reply=(status,data)=>{if(status>=400)console.warn('LINE_VERIFY_RESULT',{status,code:data.code});return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});};
const MAX_BYTES=20000;
async function readJson(request){
  const reader=request.body?.getReader();
  if(!reader)throw new Error('BODY_REQUIRED');
  let length=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw new Error('BODY_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

// This endpoint verifies a single test interaction. It does not create a session,
// grant booking access, retain an ID token or write a patient's LINE identifier.
export function createLineVerifyHandler({channelId,publicOrigin,verify=verifyLineIdToken}){
  return async request=>{
    if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
    if(!channelId||!publicOrigin)return reply(503,{code:'LINE_NOT_CONFIGURED'});
    if(request.headers.get('origin')!==publicOrigin)return reply(403,{code:'ORIGIN_REJECTED'});
    if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{code:'JSON_REQUIRED'});
    let body;try{body=await readJson(request);}catch{return reply(400,{code:'INVALID_REQUEST'});}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.idToken!=='string'||!body.idToken||body.idToken.length>16384)return reply(400,{code:'INVALID_REQUEST'});
    try{await verify({idToken:body.idToken,channelId});}
    catch(e){
      const code=typeof e?.code==='string'&&/^LINE_[A-Z_]{1,60}$/.test(e.code)?e.code:'LINE_VERIFY_ERROR';
      console.warn('LINE_TOKEN_VERIFY',{code,status:Number.isInteger(e?.status)?e.status:null});
      return reply(e?.status===429?429:e?.status===504?504:e?.status>=500?502:401,{code:e?.status===429?'LINE_TEMPORARILY_UNAVAILABLE':'LINE_VERIFICATION_FAILED'});
    }
    return reply(200,{verified:true,accountId:bookingBrand.lineAccountId});
  };
}
