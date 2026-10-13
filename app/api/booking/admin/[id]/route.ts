import { env } from 'cloudflare:workers';
import { createBookingApi } from '../../../../../server/booking-api.mjs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return createBookingApi(env)(request, { action: 'admin-appointment', id: (await context.params).id });
}
