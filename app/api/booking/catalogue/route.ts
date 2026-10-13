import { env } from 'cloudflare:workers';
import { createBookingApi } from '../../../../server/booking-api.mjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return createBookingApi(env)(request, { action: 'catalogue' });
}
