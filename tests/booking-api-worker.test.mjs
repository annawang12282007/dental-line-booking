// Full API regression in the same Workerd/D1 engine used by the deployment.
// All credentials and patients are synthetic. Undici blocks all external access;
// only the two explicitly mocked official LINE endpoints can receive requests.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bookingBrand } from '../lib/booking-brand.mjs';

const project = new URL('../', import.meta.url);
const require = createRequire(new URL('package.json', project));
const { Miniflare, createFetchMock } = require('miniflare');
const { build } = require('esbuild');
const ORIGIN = 'https://booking-worker.example.test';
const CHANNEL = '1234567890';
const PATIENT = `U${'b'.repeat(32)}`;
const OTHER = `U${'c'.repeat(32)}`;
const ADMIN = `U${'a'.repeat(32)}`;
const TIME = Date.now();
const DATE = new Date(TIME + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
const CLINIC = 'demo-clinic-taipei';
const DOCTOR = 'demo-taipei-lin';
const LIFF = '1234567890-synthetic';
const ACCESS_TOKEN = 'synthetic-only-channel-access-token';
const SECURITY_KEY = 'synthetic-booking-security-key-for-worker-tests-only-0123456789';
const entry = `
import { createBookingApi } from './server/booking-api.mjs';
export default { fetch(request, env) {
  const path = new URL(request.url).pathname;
  let action, id;
  if (path === '/api/line/verify') action = 'verify';
  else if (path.startsWith('/api/booking/appointments/')) {
    action = 'appointment'; id = decodeURIComponent(path.slice('/api/booking/appointments/'.length));
  } else if (path.startsWith('/api/booking/admin/')) {
    action = 'admin-appointment'; id = decodeURIComponent(path.slice('/api/booking/admin/'.length));
  } else action = path.slice('/api/booking/'.length);
  // Recreate the handler on every request, like route modules do. Only D1
  // persistence can retain a session, booking, audit or notification receipt.
  return createBookingApi(env, {now: () => ${TIME}})(request, {action, id});
}};`;
const bundlePromise = build({ stdin: { contents: entry, resolveDir: fileURLToPath(project), sourcefile: 'booking-api-worker-regression.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });

async function fixture(t, { notifications = true, pushStatus = 200, verifyStatus = 200, verifyError = 'IdToken expired.' } = {}) {
  const mock = createFetchMock();
  mock.disableNetConnect();
  const pushes = [], verifications = [];
  const subjects = { 'synthetic-patient-id-token': PATIENT, 'synthetic-other-id-token': OTHER, 'synthetic-admin-id-token': ADMIN };
  let expectedSubject = PATIENT;
  // Miniflare forwards a streaming request body, so Undici cannot synchronously
  // match it. Select the synthetic reply before each sequential login and then
  // assert the actual form body immediately after the request completes.
  mock.get('https://api.line.me').intercept({ path: '/oauth2/v2.1/verify', method: 'POST' }).reply(options => {
      verifications.push({ headers: new Headers(options.headers), body: new Response(options.body).text() });
      if (verifyStatus !== 200) return { statusCode: verifyStatus, data: JSON.stringify({error: 'invalid_request', error_description: verifyError}),
        responseOptions: { headers: { 'Content-Type': 'application/json' } } };
      return { statusCode: 200, data: JSON.stringify({ sub: expectedSubject, aud: CHANNEL, iss: 'https://access.line.me',
        exp: Math.floor(TIME / 1000) + 3600, name: 'PRIVATE LINE PROFILE', email: 'private-profile@example.test' }),
        responseOptions: { headers: { 'Content-Type': 'application/json' } } };
  }).persist();
  mock.get('https://api.line.me').intercept({ path: '/v2/bot/message/push', method: 'POST' }).reply(options => {
    pushes.push({ headers: new Headers(options.headers), body: new Response(options.body).text() });
    return { statusCode: pushStatus, data: '{}', responseOptions: { headers: { 'Content-Type': 'application/json' } } };
  }).persist();
  const bundle = await bundlePromise;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-05-15', fetchMock: mock, d1Databases: { DB: 'booking-worker-regression' },
    bindings: { BOOKING_SECURITY_KEY: SECURITY_KEY, BOOKING_ADMIN_LINE_ID: ADMIN, LINE_PROVIDER_ID: '1234567891',
      LINE_LOGIN_CHANNEL_ID: CHANNEL, LINE_LIFF_ID: LIFF, PUBLIC_ORIGIN: ORIGIN,
      ...(notifications ? { LINE_CHANNEL_ACCESS_TOKEN: ACCESS_TOKEN } : {}) } });
  t.after(async () => { await mf.dispose(); await mock.close(); });
  const db = await mf.getD1Database('DB');
  const migrations = (await readdir(new URL('drizzle/', project))).filter(name => /^000[012]_.*\.sql$/.test(name)).sort();
  assert.equal(migrations.length, 3, 'load every currently deployed migration, including the booking schema');
  for (const name of migrations) {
    const sql = await readFile(new URL(`drizzle/${name}`, project), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map(text => text.trim()).filter(Boolean);
    const results = await db.batch(statements.map(text => db.prepare(text)));
    assert.ok(results.every(result => result.success));
  }
  async function request(path, { method = 'GET', session, body, csrf = true, origin = ORIGIN } = {}) {
    const headers = {};
    if (session) headers.cookie = session.cookie;
    if (method !== 'GET') {
      headers.origin = origin; headers['Content-Type'] = 'application/json';
      if (csrf && session) headers['X-CSRF-Token'] = session.csrf;
    }
    const response = await mf.dispatchFetch(`${ORIGIN}${path}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function login(kind = 'patient') {
    expectedSubject = subjects[`synthetic-${kind}-id-token`];
    const response = await request('/api/line/verify', { method: 'POST', body: { idToken: `synthetic-${kind}-id-token` } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await verifications.at(-1).body)),
      { id_token: `synthetic-${kind}-id-token`, client_id: CHANNEL });
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-dental_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.data.authenticated, true);
    assert.equal(response.data.accountId, bookingBrand.lineAccountId);
    assert.match(response.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(response.data.isAdmin, kind === 'admin');
    for (const privateValue of [subjects[`synthetic-${kind}-id-token`], SECURITY_KEY, 'PRIVATE LINE PROFILE', 'private-profile@example.test']) {
      assert.equal(JSON.stringify(response.data).includes(privateValue), false);
    }
    return { cookie: cookie.split(';')[0], csrf: response.data.csrfToken, response };
  }
  async function slots(clinicId = CLINIC, doctorId = DOCTOR) {
    const response = await request(`/api/booking/slots?${new URLSearchParams({ clinicId, doctorId, date: DATE })}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.slots.length > 0);
    return response.data.slots;
  }
  return { db, request, login, slots, pushes, verifications };
}

const booking = (slotId, idempotencyKey = 'worker-booking-1', changes = {}) => ({ slotId, name: '測試預約稱呼',
  phone: '0912345678', consent: true, idempotencyKey, ...changes });
const assertNoPrivateInternals = data => {
  const value = JSON.stringify(data);
  for (const forbidden of ['patient_key', 'patientKey', 'line_cipher', 'lineCipher', 'token_hash', 'payload_hash', 'retry_key', PATIENT, OTHER, ADMIN]) {
    assert.equal(value.includes(forbidden), false, forbidden);
  }
};

test('Workerd API: expired LINE credentials return only a safe recovery reason and never establish a session', async t => {
  const f = await fixture(t, { verifyStatus: 400 });
  const result = await f.request('/api/line/verify', { method: 'POST', body: { idToken: 'synthetic-patient-id-token' } });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'LINE_TOKEN_REJECTED');
  assert.equal(result.data.reason, 'EXPIRED');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM booking_sessions').first()).count, 0);
  assert.equal(JSON.stringify(result.data).includes('synthetic-patient-id-token'), false);
  assert.equal(JSON.stringify(result.data).includes('IdToken expired.'), false);
  assert.equal(f.pushes.length, 0);
});

test('Workerd API: verified LINE login, scoped persistent booking, clinic confirmation, cancellation and minimal notifications', async t => {
  const f = await fixture(t);
  const anonymous = await f.request('/api/booking/session');
  assert.equal(anonymous.data.authenticated, false);
  assert.equal(anonymous.data.notificationsConfigured, true);
  const patient = await f.login('patient');
  const patientSession = await f.request('/api/booking/session', { session: patient });
  assert.equal(patientSession.data.authenticated, true);
  assert.equal(patientSession.data.isAdmin, false);
  assert.deepEqual(patientSession.data.adminClinicIds, []);
  assert.equal(patientSession.data.csrfToken, patient.csrf);
  assert.equal((await f.request(`/api/booking/admin?clinicId=${CLINIC}`, { session: patient })).status, 403);

  const admin = await f.login('admin');
  assert.equal(admin.response.data.adminClinicIds.length, 2);
  const seeded = await f.request('/api/booking/admin', { method: 'POST', session: admin, body: { action: 'seed' } });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.data));
  assert.equal(seeded.data.seeded.clinics, 2);
  assert.equal(seeded.data.seeded.doctors, 4);
  assert.ok(seeded.data.seeded.slots > 0);
  const catalogue = await f.request('/api/booking/catalogue');
  assert.equal(catalogue.data.clinics.length, 2);
  assert.ok(catalogue.data.clinics.every(clinic => clinic.name.includes('示範') && clinic.timeZone === 'Asia/Taipei'));
  const slots = await f.slots();
  const body = booking(slots[0].id);
  for (const options of [{}, { session: patient, csrf: false }, { session: patient, origin: 'https://attacker.example.test' }]) {
    const denied = await f.request('/api/booking/appointments', { method: 'POST', body, ...options });
    assert.equal(denied.status, options.session ? 403 : 401);
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM booking_appointments').first()).count, 0);

  const created = await f.request('/api/booking/appointments', { method: 'POST', session: patient, body });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.appointment.status, 'pending');
  assert.equal(created.data.appointment.revision, 1);
  assert.equal(created.data.appointment.name, '示範訪客');
  assert.equal(created.data.appointment.phone, '0900000000');
  const storedContact = await f.db.prepare('SELECT name,phone FROM booking_appointments WHERE id = ?').bind(created.data.appointment.id).first();
  assert.equal(storedContact.name, '示範訪客');
  assert.equal(storedContact.phone, '0900000000');
  assert.deepEqual(created.data.dispatch, { sent: 1, pending: 0, failed: 0, skipped: 0, configured: true });
  assertNoPrivateInternals(created.data);
  const id = created.data.appointment.id;
  const repeated = await f.request('/api/booking/appointments', { method: 'POST', session: patient, body });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.data.appointment.id, id);
  assert.equal(repeated.data.dispatch.sent, 0);
  assert.equal(f.pushes.length, 1);
  assert.equal((await f.request('/api/booking/appointments', { method: 'POST', session: patient,
    body: { ...body, consent: false } })).status, 409);

  const other = await f.login('other');
  assert.deepEqual((await f.request('/api/booking/appointments', { session: other })).data.appointments, []);
  assert.equal((await f.request('/api/booking/appointments', { method: 'POST', session: other,
    body: booking(slots[0].id, 'other-conflict') })).status, 409);
  assert.equal((await f.request(`/api/booking/appointments/${id}`, { method: 'PATCH', session: other,
    body: { status: 'cancelled', expectedRevision: 1 } })).status, 404);
  assert.equal((await f.request('/api/booking/admin?clinicId=foreign-clinic', { session: admin })).status, 403);
  assert.equal((await f.request(`/api/booking/admin/${id}`, { method: 'PATCH', session: admin,
    body: { clinicId: 'foreign-clinic', status: 'confirmed', expectedRevision: 1 } })).status, 403);
  assert.equal((await f.request(`/api/booking/admin/${id}`, { method: 'PATCH', session: admin,
    body: { clinicId: 'demo-clinic-taichung', status: 'confirmed', expectedRevision: 1 } })).status, 404);
  const clinicView = await f.request(`/api/booking/admin?clinicId=${CLINIC}`, { session: admin });
  assert.equal(clinicView.data.appointments.length, 1);
  assert.equal(clinicView.data.appointments[0].id, id);
  assertNoPrivateInternals(clinicView.data);
  assert.deepEqual((await f.request('/api/booking/admin?clinicId=demo-clinic-taichung', { session: admin })).data.appointments, []);

  const confirmed = await f.request(`/api/booking/admin/${id}`, { method: 'PATCH', session: admin,
    body: { clinicId: CLINIC, status: 'confirmed', expectedRevision: 1 } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.appointment.status, 'confirmed');
  assert.equal(confirmed.data.appointment.revision, 2);
  assert.equal(confirmed.data.dispatch.sent, 1);
  assert.equal((await f.request(`/api/booking/appointments/${id}`, { method: 'PATCH', session: patient,
    body: { status: 'cancelled', expectedRevision: 1 } })).status, 409);
  const cancelled = await f.request(`/api/booking/appointments/${id}`, { method: 'PATCH', session: patient,
    body: { status: 'cancelled', expectedRevision: 2 } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.appointment.status, 'cancelled');
  assert.equal(cancelled.data.appointment.revision, 3);
  assert.equal(cancelled.data.dispatch.sent, 1);
  const reloaded = await f.request('/api/booking/appointments', { session: patient });
  assert.equal(reloaded.data.appointments[0].status, 'cancelled');
  assert.equal(reloaded.data.appointments[0].notificationStatus, 'sent');
  assert.ok((await f.slots()).some(slot => slot.id === slots[0].id), 'cancelled booking releases the slot');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM booking_audits WHERE appointment_id = ?').bind(id).first()).count, 3);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM booking_outbox WHERE status = 'sent'").first()).count, 3);

  assert.equal(f.pushes.length, 3);
  const retryKeys = new Set();
  for (const pushed of f.pushes) {
    assert.equal(pushed.headers.get('authorization'), `Bearer ${ACCESS_TOKEN}`);
    assert.match(pushed.headers.get('x-line-retry-key'), /^[0-9a-f-]{36}$/);
    retryKeys.add(pushed.headers.get('x-line-retry-key'));
    const message = JSON.parse(await pushed.body);
    assert.equal(message.to, PATIENT);
    assert.equal(message.messages.length, 1);
    assert.equal(message.messages[0].type, 'text');
    assert.match(message.messages[0].text, /示範/);
    assert.match(message.messages[0].text, /並非實際診所掛號/);
    assert.ok(message.messages[0].text.includes(`https://liff.line.me/${LIFF}`));
    for (const privateValue of ['測試預約稱呼', '0912345678', 'PRIVATE LINE PROFILE', 'private-profile@example.test', SECURITY_KEY]) {
      assert.equal(message.messages[0].text.includes(privateValue), false);
    }
  }
  assert.equal(retryKeys.size, 3, 'distinct immutable transitions get distinct durable retry keys');
  assert.equal(f.verifications.length, 3, 'all identities were verified through the real default fetch adapter');
  for (const verified of f.verifications) assert.equal(verified.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const sessions = JSON.stringify((await f.db.prepare('SELECT * FROM booking_sessions').all()).results);
  for (const raw of [PATIENT, OTHER, ADMIN, patient.cookie.split('=')[1], 'synthetic-patient-id-token']) assert.equal(sessions.includes(raw), false);
  assert.equal((await f.request('/api/booking/logout', { method: 'POST', session: patient, body: {} })).status, 200);
  assert.equal((await f.request('/api/booking/appointments', { session: patient })).status, 401);
});

test('Workerd API: missing notification credential keeps committed booking queued without any outbound push', async t => {
  const f = await fixture(t, { notifications: false });
  const admin = await f.login('admin');
  await f.request('/api/booking/admin', { method: 'POST', session: admin, body: { action: 'seed' } });
  const patient = await f.login('patient');
  const [slot] = await f.slots();
  const created = await f.request('/api/booking/appointments', { method: 'POST', session: patient, body: booking(slot.id) });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.dispatch, { sent: 0, pending: 1, failed: 0, skipped: 0, configured: false });
  assert.equal(f.pushes.length, 0);
  assert.equal((await f.request('/api/booking/appointments', { session: patient })).data.appointments[0].status, 'pending');
  const queued = await f.db.prepare('SELECT status,attempts FROM booking_outbox').first();
  assert.equal(queued.status, 'pending');
  assert.equal(queued.attempts, 0);
});

test('Workerd API: upstream push failure does not roll back a booking and manual retry respects backoff', async t => {
  const f = await fixture(t, { pushStatus: 503 });
  const admin = await f.login('admin');
  await f.request('/api/booking/admin', { method: 'POST', session: admin, body: { action: 'seed' } });
  const patient = await f.login('patient');
  const [slot] = await f.slots();
  const created = await f.request('/api/booking/appointments', { method: 'POST', session: patient, body: booking(slot.id) });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.appointment.status, 'pending');
  assert.equal(created.data.dispatch.pending, 1);
  assert.equal(created.data.dispatch.failed, 0);
  assert.equal(f.pushes.length, 1);
  const queued = await f.db.prepare('SELECT retry_key,status,attempts,last_code FROM booking_outbox').first();
  assert.equal(queued.status, 'pending');
  assert.equal(queued.attempts, 1);
  assert.equal(queued.last_code, 'LINE_RETRY_PENDING');
  const dispatched = await f.request('/api/booking/admin', { method: 'POST', session: admin, body: { action: 'dispatch' } });
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.data.dispatch.pending, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal((await f.db.prepare('SELECT retry_key FROM booking_outbox').first()).retry_key, queued.retry_key);
  const own = await f.request('/api/booking/appointments', { session: patient });
  assert.equal(own.data.appointments.length, 1);
  assert.equal(own.data.appointments[0].notificationStatus, 'pending');
});
