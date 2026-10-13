import { createBookingAuth, bookingError, assertMutation, readBookingJson } from './booking-auth.mjs';
import { createBookingStore } from './booking-store.mjs';
import { dispatchBookingNotifications } from './booking-notifications.mjs';
import { verifyLineIdToken } from './line.mjs';
import { bookingBrand } from '../lib/booking-brand.mjs';

const DEMO_CLINICS = ['demo-clinic-taipei', 'demo-clinic-taichung'];
const TOKEN_REASONS = new Set(['EXPIRED', 'AUDIENCE_MISMATCH', 'ISSUER_MISMATCH', 'INVALID_TOKEN', 'OTHER']);
const MESSAGES = {
  LOGIN_REQUIRED: '請先使用 LINE 登入。', LOGIN_EXPIRED: '登入已到期，請重新連結 LINE。',
  ADMIN_REQUIRED: '此 LINE 帳號沒有診所管理權限。', CLINIC_FORBIDDEN: '您沒有這間診所的管理權限。',
  RATE_LIMITED: '操作較頻繁，請稍候再試。', SLOT_UNAVAILABLE: '這個時段已被預約，請選擇其他時段。',
  INVALID_PHONE: '請填寫台灣手機號碼，例如 0912345678。', INVALID_NAME: '請填寫 1 至 60 字的預約稱呼。',
  ACTIVE_BOOKING_LIMIT: '已有三筆待看診預約，請先處理現有預約。', SLOT_IN_PAST: '這個時段已過，請選擇未來時段。',
  DAILY_BOOKING_LIMIT: '每個 LINE 帳號在 24 小時內最多建立三筆示範預約，取消不會重置額度，請稍後再體驗。',
  IDEMPOTENCY_CONFLICT: '這次送出的資料與前次不同，請重新整理後再送出。', APPOINTMENT_NOT_FOUND: '找不到這筆預約。',
  SLOT_TAKEN: '這個時段已被預約，請選擇其他時段。', BOOKING_LIMIT: '已有三筆待看診預約，請先處理現有預約。',
  REVISION_CONFLICT: '預約狀態已更新，請重新整理後再試。', NOT_FOUND: '找不到這筆預約。',
  INVALID_REQUEST: '資料格式不正確，請檢查後再試。', BOOKING_NOT_CONFIGURED: '預約服務設定中，請稍後再試。',
  ORIGIN_REJECTED: '請從原預約入口重新開啟。', CSRF_REJECTED: '頁面已失效，請重新整理後再試。',
};
const json = (status, data, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
function strictKeys(body, allowed) { if (Object.keys(body).some(key => !allowed.includes(key))) throw bookingError('INVALID_REQUEST'); }
function projection(session) { return { authenticated: !!session, isAdmin: !!session?.isAdmin, adminClinicIds: session?.isAdmin ? DEMO_CLINICS : [], ...(session ? { csrfToken: session.csrfToken } : {}) }; }

export function createBookingApi(env, { verify = verifyLineIdToken, now = Date.now, dispatch = dispatchBookingNotifications } = {}) {
  async function handle(request, { action, id } = {}) {
    let loginStage = 'session';
    try {
      const auth = createBookingAuth({ db: env.DB, secret: env.BOOKING_SECURITY_KEY, providerId: env.LINE_PROVIDER_ID, adminLineId: env.BOOKING_ADMIN_LINE_ID, now });
      const store = createBookingStore(env.DB, { now });
      const url = new URL(request.url);
      const session = await auth.read(request);
      const requireSession = () => { if (!session) throw bookingError('LOGIN_REQUIRED', 401); };
      const requireAdmin = (clinicId) => {
        requireSession(); if (!session.isAdmin) throw bookingError('ADMIN_REQUIRED', 403);
        if (clinicId && !DEMO_CLINICS.includes(clinicId)) throw bookingError('CLINIC_FORBIDDEN', 403);
      };
      const notify = async (appointmentId) => {
        try { return await dispatch({ db: env.DB, accessToken: env.LINE_CHANNEL_ACCESS_TOKEN, decryptLineId: auth.decryptLineId,
          publicOrigin: env.PUBLIC_ORIGIN, liffUrl: `https://liff.line.me/${env.LINE_LIFF_ID}`, now,
          appointmentId, clinicIds: DEMO_CLINICS, limit: appointmentId ? 5 : 2 }); }
        catch { return { configured: !!env.LINE_CHANNEL_ACCESS_TOKEN, sent: 0, pending: 1, failed: 0, skipped: 0 }; }
      };
      if (action === 'verify' && request.method === 'POST') {
        loginStage = 'request';
        assertMutation(request, env.PUBLIC_ORIGIN, null, { csrf: false });
        const body = await readBookingJson(request); strictKeys(body, ['idToken']);
        if (typeof body.idToken !== 'string' || !body.idToken || body.idToken.length > 16384) throw bookingError('INVALID_REQUEST');
        await auth.rateLimit('login', request.headers.get('cf-connecting-ip') ?? 'unknown', 30, 300000);
        loginStage = 'provider';
        const identity = await verify({ idToken: body.idToken, channelId: env.LINE_LOGIN_CHANNEL_ID });
        loginStage = 'establish';
        const created = await auth.establish(identity);
        loginStage = 'read';
        const authenticated = await auth.read(new Request(request.url, { headers: { cookie: created.cookie.split(';')[0] } }));
        loginStage = 'replace';
        if (session) await auth.logout(session);
        // The verified owner's login maintains only the explicitly requested
        // demo roster. Anonymous visitors never trigger setup writes.
        if (authenticated?.isAdmin) { loginStage = 'seed'; await store.seedDemo(); }
        return json(200, { verified: true, accountId: bookingBrand.lineAccountId, ...projection(authenticated) }, { 'Set-Cookie': created.cookie });
      }
      if (action === 'session' && request.method === 'GET') return json(200, { ...projection(session), notificationsConfigured: !!env.LINE_CHANNEL_ACCESS_TOKEN });
      if (action === 'catalogue' && request.method === 'GET') return json(200, await store.catalogue());
      if (action === 'slots' && request.method === 'GET') return json(200, { slots: await store.slots({ clinicId: url.searchParams.get('clinicId'), doctorId: url.searchParams.get('doctorId'), date: url.searchParams.get('date') }) });
      requireSession();
      if (!['GET', 'HEAD'].includes(request.method)) { assertMutation(request, env.PUBLIC_ORIGIN, session); await auth.rateLimit('write', session.patientKey, 40, 60000); }
      if (action === 'logout' && request.method === 'POST') { await auth.logout(session); return json(200, { loggedOut: true }, { 'Set-Cookie': auth.clearCookie }); }
      if (action === 'appointments' && request.method === 'GET') return json(200, { appointments: await store.listMine(session.patientKey) });
      if (action === 'appointments' && request.method === 'POST') {
        const body = await readBookingJson(request, 4096); strictKeys(body, ['slotId', 'name', 'phone', 'consent', 'idempotencyKey']);
        if (typeof body.consent !== 'boolean') throw bookingError('INVALID_REQUEST');
        // Public product demonstration never stores visitor-supplied contact data.
        const appointment = await store.book({ ...body, name: '示範訪客', phone: '0900000000', patientKey: session.patientKey, lineCipher: session.lineCipher });
        const delivery = await notify(appointment.id);
        return json(201, { appointment, dispatch: delivery });
      }
      if (action === 'appointment' && request.method === 'PATCH') {
        const body = await readBookingJson(request, 2048); strictKeys(body, ['status', 'expectedRevision']);
        if (body.status !== 'cancelled') throw bookingError('INVALID_REQUEST');
        // Ownership check also provides the tenant from trusted stored data.
        const own = await store.findMine(id, session.patientKey);
        if (!own) throw bookingError('NOT_FOUND', 404);
        const appointment = await store.transition({ ...body, id, clinicId: own.clinicId, actorKey: session.patientKey, patientKey: session.patientKey });
        return json(200, { appointment, dispatch: await notify(id) });
      }
      if (action === 'admin') {
        const clinicId = url.searchParams.get('clinicId'); requireAdmin(clinicId);
        if (request.method === 'GET') {
          if (!clinicId) throw bookingError('INVALID_REQUEST');
          return json(200, { appointments: await store.listAdmin(clinicId) });
        }
        if (request.method === 'POST') {
          const body = await readBookingJson(request, 1024); strictKeys(body, ['action']);
          if (body.action === 'seed') return json(200, { seeded: await store.seedDemo() });
          if (body.action === 'dispatch') return json(200, { dispatch: await notify() });
          throw bookingError('INVALID_REQUEST');
        }
      }
      if (action === 'admin-appointment' && request.method === 'PATCH') {
        const body = await readBookingJson(request, 2048); strictKeys(body, ['clinicId', 'status', 'expectedRevision']);
        requireAdmin(body.clinicId);
        if (!body.clinicId || !['confirmed', 'cancelled'].includes(body.status)) throw bookingError('INVALID_REQUEST');
        const appointment = await store.transition({ ...body, id, actorKey: session.patientKey });
        return json(200, { appointment, dispatch: await notify(id) });
      }
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: '不支援此操作。' });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'STORAGE_UNAVAILABLE';
      const reason = TOKEN_REASONS.has(error?.reason) ? error.reason : undefined;
      // No tokens, patient identifiers, database errors or request bodies in logs.
      if (action === 'verify') console.warn('BOOKING_LOGIN_FAILED', { stage: loginStage, code, status, ...(reason ? { reason } : {}) });
      return json(status, { code, ...(reason ? { reason } : {}), message: MESSAGES[code] ?? (status === 409 ? '資料已變更或時段已被預約，請重新整理。' : status === 401 ? 'LINE 登入已失效，請重新登入。' : status < 500 ? '無法完成操作，請檢查資料並重新整理。' : '服務暫時無法完成操作，請稍後重試。') });
    }
  }
  return handle;
}
