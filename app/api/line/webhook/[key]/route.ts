import {env} from 'cloudflare:workers';
import {createLineWebhookHandler} from '../../../../../server/line-webhook.mjs';
import {createD1InboxRepository} from '../../../../../server/line-inbox.mjs';
import {createD1ConnectionRepository} from '../../../../../server/line-connection.mjs';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{key:string}>}){
  const {key}=await context.params;
  const repository={async acceptWebhookEvents(input:unknown){
    return createD1InboxRepository(env.DB,{hashSecret:env.LINE_INBOX_HASH_SECRET}).acceptWebhookEvents(input);
  },async bindVerifiedDestination(input:unknown){
    return createD1ConnectionRepository(env.DB).bindVerifiedDestination(input);
  }};
  const handler=createLineWebhookHandler({repository,resolveConnection:async (requestedKey:string)=>{
    if(env.LINE_WEBHOOK_ENABLED!=='true'||requestedKey!==env.LINE_CONNECTION_KEY)return null;
    const tenantId='demo-tenant';
    const providerId=env.LINE_PROVIDER_ID;
    const botUserId=await createD1ConnectionRepository(env.DB).resolveDestination({connectionKey:key,tenantId,providerId});
    return {tenantId,providerId,botUserId,channelSecret:env.LINE_CHANNEL_SECRET,allowDestinationEnrollment:true,enabled:true};
  }});
  return handler(request,key);
}
