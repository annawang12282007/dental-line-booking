import {env} from 'cloudflare:workers';
import {publicLineConfiguration} from '@/lib/booking-brand.mjs';
export const dynamic='force-dynamic';
export async function GET(){
  return Response.json(publicLineConfiguration(env),{headers:{'Cache-Control':'no-store'}});
}
