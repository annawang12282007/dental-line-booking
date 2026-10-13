import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { dispatchBookingNotifications } from '../server/booking-notifications.mjs';

const TIME = Date.parse('2026-10-13T08:00:00.000Z');
const USER = `U${'1'.repeat(32)}`;
const KEY = '123e4567-e89b-12d3-a456-426614174000';
const PUBLIC_ORIGIN = 'https://example.test';
const LIFF_URL = 'https://liff.line.me/1234567890-test';
const SCHEMA = `
CREATE TABLE booking_appointments (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
  clinic_id TEXT NOT NULL, notification_consent INTEGER NOT NULL,
  name TEXT, phone TEXT
);
CREATE TABLE booking_outbox (
  id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL, appointment_revision INTEGER NOT NULL,
  kind TEXT NOT NULL, retry_key TEXT NOT NULL, payload TEXT NOT NULL, line_cipher TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
  claim_token TEXT, claimed_until INTEGER, created_at INTEGER NOT NULL, accepted_at INTEGER, last_code TEXT,
  UNIQUE(appointment_id, appointment_revision, kind)
);
CREATE TABLE booking_rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);`;

function adapter(sqlite) {
  return {
    prepare(sql) {
      return { bind(...bindings) {
        return {
          async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
          async all() { return { success: true, results: sqlite.prepare(sql).all(...bindings) }; },
          async run() {
            const value = sqlite.prepare(sql).run(...bindings);
            return { success: true, meta: { changes: Number(value.changes) } };
          },
        };
      } };
    },
  };
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  t.after(() => sqlite.close());
  let clock = TIME;
  const sent = [];
  const db = adapter(sqlite);
  const options = {
    db, accessToken: 'synthetic-test-access-token', decryptLineId: async cipher => {
      assert.equal(cipher, 'encrypted-test-recipient'); return USER;
    }, publicOrigin: PUBLIC_ORIGIN, liffUrl: LIFF_URL, now: () => clock,
    send: async request => { sent.push(request); return { accepted: true, duplicate: false, status: 200 }; },
  };
  function insert({ id = 'appointment-1', clinicId = 'clinic-1', revision = 1, kind = 'pending',
    currentRevision = revision, currentStatus = kind, consent = 1, createdAt = TIME - 1_000,
    attempts = 0, status = 'pending', nextAttemptAt = TIME, claimToken = null, claimedUntil = null,
    retryKey = KEY, payloadExtra = {}, lineCipher = 'encrypted-test-recipient' } = {}) {
    sqlite.prepare(`INSERT INTO booking_appointments (id, revision, status, clinic_id, notification_consent, name, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, currentRevision, currentStatus, clinicId, consent, 'PRIVATE PATIENT', '0912345678');
    sqlite.prepare(`INSERT INTO booking_outbox (id, appointment_id, appointment_revision, kind, retry_key, payload,
      line_cipher, status, attempts, next_attempt_at, claim_token, claimed_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`notice-${id}`, id, revision, kind, retryKey,
      JSON.stringify({ appointmentId: id, clinicName: '微笑示範牙醫', doctorName: '示範醫師',
        startAt: '2026-10-20T01:30:00.000Z', status: kind, revision, ...payloadExtra }),
      lineCipher, status, attempts, nextAttemptAt, claimToken, claimedUntil, createdAt);
  }
  return { sqlite, options, sent, insert, advance: ms => { clock += ms; },
    row: (id = 'appointment-1') => sqlite.prepare('SELECT * FROM booking_outbox WHERE appointment_id = ?').get(id) };
}

test('without a token reports pending work without claiming, retrying, decrypting or sending', async t => {
  const f = fixture(t); f.insert();
  const before = f.row();
  const result = await dispatchBookingNotifications({ ...f.options, accessToken: undefined,
    decryptLineId: () => assert.fail('must not decrypt'), send: () => assert.fail('must not send') });
  assert.deepEqual(result, { sent: 0, pending: 1, failed: 0, skipped: 0, configured: false });
  assert.deepEqual(f.row(), before);
});

test('sends a minimal demo-labelled Taiwan-time notice and persists provider acceptance', async t => {
  const f = fixture(t); f.insert();
  assert.deepEqual(await dispatchBookingNotifications(f.options),
    { sent: 1, pending: 0, failed: 0, skipped: 0, configured: true });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].userId, USER);
  assert.equal(f.sent[0].retryKey, KEY);
  assert.equal(f.sent[0].messages.length, 1);
  const notice = f.sent[0].messages[0].text;
  assert.match(notice, /【示範】微笑示範牙醫/);
  assert.match(notice, /2026\/10\/20\s09:30（台灣時間）/);
  assert.match(notice, /目前待診所確認/);
  assert.match(notice, /並非實際診所掛號/);
  assert.ok(notice.includes(LIFF_URL));
  for (const privateValue of ['PRIVATE PATIENT', '0912345678', '示範醫師', '治療', USER, 'encrypted-test-recipient']) {
    assert.equal(notice.includes(privateValue), false);
  }
  assert.equal(f.row().status, 'sent');
  assert.equal(f.row().attempts, 1);
  assert.equal(f.row().accepted_at, TIME);
  assert.equal(f.row().claim_token, null);
  assert.equal(f.row().last_code, 'LINE_ACCEPTED');
  await dispatchBookingNotifications(f.options);
  assert.equal(f.sent.length, 1, 'accepted rows are never resent');
});

test('concurrent dispatchers atomically claim each notice only once', async t => {
  const f = fixture(t); f.insert();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const options = { ...f.options, send: async request => {
    sent.push(request); await gate; return { accepted: true, duplicate: false, status: 200 };
  } };
  const running = dispatchBookingNotifications(options);
  await new Promise(resolve => setImmediate(resolve));
  const second = await dispatchBookingNotifications(options);
  assert.equal(second.pending, 1);
  assert.equal(sent.length, 1);
  release();
  assert.equal((await running).sent, 1);
  assert.equal(f.row().attempts, 1);
});

test('uncertain network acceptance retries with the same key and accepts LINE duplicate acknowledgement', async t => {
  const f = fixture(t); f.insert();
  const keys = [];
  const first = await dispatchBookingNotifications({ ...f.options, send: async request => {
    keys.push(request.retryKey);
    throw Object.assign(new Error('sensitive provider diagnostic'), { status: 502 });
  } });
  assert.equal(first.pending, 1);
  assert.equal(f.row().last_code, 'LINE_RETRY_PENDING');
  assert.equal(f.row().next_attempt_at, TIME + 30_000);
  await dispatchBookingNotifications(f.options);
  assert.equal(f.sent.length, 0, 'backoff is enforced');
  f.advance(30_000);
  const result = await dispatchBookingNotifications({ ...f.options, send: async request => {
    keys.push(request.retryKey); return { accepted: true, duplicate: true, status: 409 };
  } });
  assert.equal(result.sent, 1);
  assert.deepEqual(keys, [KEY, KEY]);
  assert.equal(f.row().last_code, 'LINE_ALREADY_ACCEPTED');
  assert.equal(f.row().attempts, 2);
});

test('a crashed sending lease can be reclaimed with its original key but never before expiry', async t => {
  const f = fixture(t); f.insert({ status: 'sending', attempts: 1, claimToken: 'old-worker', claimedUntil: TIME + 1_000 });
  assert.equal((await dispatchBookingNotifications(f.options)).pending, 1);
  assert.equal(f.sent.length, 0);
  f.advance(1_001);
  assert.equal((await dispatchBookingNotifications(f.options)).sent, 1);
  assert.equal(f.sent[0].retryKey, KEY);
  assert.equal(f.row().attempts, 2);
});

test('retry window expiry fails closed without generating a new key or sending', async t => {
  const f = fixture(t); f.insert({ createdAt: TIME - 24 * 60 * 60 * 1000, attempts: 1 });
  assert.equal((await dispatchBookingNotifications(f.options)).failed, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.row().retry_key, KEY);
  assert.equal(f.row().last_code, 'RETRY_WINDOW_EXPIRED');
});

test('rate limits back off and transient failures stop after eight attempts', async t => {
  const f = fixture(t); f.insert({ attempts: 1 });
  await dispatchBookingNotifications({ ...f.options, send: async () => {
    throw Object.assign(new Error('private rate limit details'), { status: 429 });
  } });
  assert.equal(f.row().status, 'pending');
  assert.equal(f.row().next_attempt_at, TIME + 60_000);
  assert.equal(f.row().last_code, 'LINE_RATE_LIMITED');
  f.sqlite.prepare('UPDATE booking_outbox SET attempts = 7, next_attempt_at = ?').run(TIME);
  const result = await dispatchBookingNotifications({ ...f.options, send: async () => {
    throw Object.assign(new Error('private outage details'), { status: 503 });
  } });
  assert.equal(result.failed, 1);
  assert.equal(f.row().attempts, 8);
  assert.equal(f.row().last_code, 'RETRY_EXHAUSTED');
});

test('permanent provider rejection is stored as a fixed safe code', async t => {
  const f = fixture(t); f.insert();
  const result = await dispatchBookingNotifications({ ...f.options, send: async () => {
    throw Object.assign(new Error(`secret=${f.options.accessToken}; recipient=${USER}`), { status: 401 });
  } });
  assert.equal(result.failed, 1);
  assert.equal(f.row().last_code, 'LINE_REQUEST_REJECTED');
  assert.equal(JSON.stringify(result).includes(USER), false);
});

test('superseded revision/status or revoked notification consent skips outdated notices', async t => {
  const f = fixture(t);
  f.insert({ id: 'old-pending', currentRevision: 2, currentStatus: 'confirmed' });
  f.insert({ id: 'old-confirmed', kind: 'confirmed', currentStatus: 'cancelled' });
  f.insert({ id: 'no-consent', consent: 0 });
  const result = await dispatchBookingNotifications(f.options);
  assert.equal(result.skipped, 3);
  assert.equal(f.sent.length, 0);
  for (const id of ['old-pending', 'old-confirmed', 'no-consent']) {
    assert.equal(f.row(id).last_code, 'NOTICE_SUPERSEDED');
  }
});

test('rechecks current appointment after asynchronous decryption before dispatch', async t => {
  const f = fixture(t); f.insert();
  const result = await dispatchBookingNotifications({ ...f.options, decryptLineId: async () => {
    f.sqlite.prepare("UPDATE booking_appointments SET revision = 2, status = 'cancelled'").run();
    return USER;
  } });
  assert.equal(result.skipped, 1);
  assert.equal(f.sent.length, 0);
});

test('invalid decrypted recipient, extra payload fields and untrusted payload URLs never send', async t => {
  const f = fixture(t);
  f.insert({ id: 'bad-id' });
  f.insert({ id: 'private-payload', payloadExtra: { phone: '0912345678' } });
  f.insert({ id: 'untrusted-url', payloadExtra: { manageUrl: 'https://attacker.test/collect' } });
  const result = await dispatchBookingNotifications({ ...f.options, decryptLineId: async () => 'group-or-malformed-user' });
  assert.equal(result.failed, 3);
  assert.equal(f.sent.length, 0);
});

test('appointment and clinic scopes constrain claiming and remaining counts together', async t => {
  const f = fixture(t);
  f.insert({ id: 'one', clinicId: 'clinic-1' });
  f.insert({ id: 'two', clinicId: 'clinic-1' });
  f.insert({ id: 'three', clinicId: 'clinic-2' });
  assert.deepEqual(await dispatchBookingNotifications({ ...f.options, appointmentId: 'three', clinicIds: ['clinic-1'] }),
    { sent: 0, pending: 0, failed: 0, skipped: 0, configured: true });
  assert.equal((await dispatchBookingNotifications({ ...f.options, appointmentId: 'one' })).sent, 1);
  assert.equal(f.row('two').attempts, 0);
  assert.equal(f.row('three').attempts, 0);
  assert.equal((await dispatchBookingNotifications({ ...f.options, clinicIds: ['clinic-1'], accessToken: undefined })).pending, 1);
  assert.equal((await dispatchBookingNotifications({ ...f.options, clinicIds: ['clinic-2'] })).sent, 1);
  assert.equal(f.row('two').status, 'pending');
});

test('an empty clinic scope never expands to all clinics and invalid config never claims', async t => {
  const f = fixture(t); f.insert();
  const before = f.row();
  assert.equal((await dispatchBookingNotifications({ ...f.options, clinicIds: [] })).pending, 0);
  for (const overrides of [{ clinicIds: [null] }, { publicOrigin: 'http://example.test' },
    { liffUrl: 'https://attacker.test/' }, { decryptLineId: undefined }, { limit: 0 }]) {
    assert.equal((await dispatchBookingNotifications({ ...f.options, ...overrides })).configured, false);
  }
  assert.deepEqual(f.row(), before);
  assert.equal(f.sent.length, 0);
});

test('claim database errors never roll back or alter the committed appointment', async t => {
  const f = fixture(t); f.insert();
  const booking = f.sqlite.prepare('SELECT * FROM booking_appointments').get();
  const db = { prepare(sql) {
    if (sql.startsWith('UPDATE')) throw new Error('sensitive SQL binding data');
    return f.options.db.prepare(sql);
  } };
  const result = await dispatchBookingNotifications({ ...f.options, db });
  assert.equal(result.pending, 1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM booking_appointments').get(), booking);
  assert.equal(f.sent.length, 0);
});

test('failure to persist acceptance remains recoverable with the exact same retry key', async t => {
  const f = fixture(t); f.insert();
  let failCompletion = true;
  const db = { prepare(sql) {
    if (sql.startsWith('UPDATE booking_outbox SET status = ?') && failCompletion) {
      return { bind() { return { async run() { throw new Error('temporary database outage'); } }; } };
    }
    return f.options.db.prepare(sql);
  } };
  const keys = [];
  await dispatchBookingNotifications({ ...f.options, db, send: async request => {
    keys.push(request.retryKey); return { accepted: true, duplicate: false, status: 200 };
  } });
  assert.equal(f.row().status, 'sending');
  failCompletion = false;
  f.advance(60_001);
  const result = await dispatchBookingNotifications({ ...f.options, db, send: async request => {
    keys.push(request.retryKey); return { accepted: true, duplicate: true, status: 409 };
  } });
  assert.equal(result.sent, 1);
  assert.deepEqual(keys, [KEY, KEY]);
});

test('the shared Taiwan-day quota caps all clinics at 30 attempts without changing appointments', async t => {
  const f = fixture(t);
  for (let index = 0; index < 35; index += 1) f.insert({
    id: `daily-${String(index).padStart(2, '0')}`, clinicId: index % 2 ? 'clinic-1' : 'clinic-2',
  });
  const appointments = f.sqlite.prepare('SELECT * FROM booking_appointments ORDER BY id').all();
  const result = await dispatchBookingNotifications({ ...f.options, limit: 100 });
  assert.deepEqual(result, { sent: 30, pending: 0, failed: 0, skipped: 5, configured: true });
  assert.equal(f.sent.length, 30);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM booking_appointments ORDER BY id').all(), appointments);
  const counter = f.sqlite.prepare('SELECT * FROM booking_rate_limits').get();
  assert.equal(counter.key, 'demo-line-push:2026-10-13');
  assert.equal(counter.count, 30);
  assert.equal(counter.expires_at, Date.parse('2026-10-13T16:00:00.000Z'));
  const blocked = f.sqlite.prepare("SELECT * FROM booking_outbox WHERE status = 'skipped'").all();
  assert.equal(blocked.length, 5);
  assert.ok(blocked.every(row => row.last_code === 'DEMO_DAILY_LIMIT' && row.claim_token === null && row.accepted_at === null));
  await dispatchBookingNotifications({ ...f.options, limit: 100 });
  assert.equal(f.sent.length, 30, 'quota-rejected notices remain terminal and are never replayed');
});

test('parallel claims share one atomic quota and never exceed the daily send limit', async t => {
  const f = fixture(t);
  const ids = Array.from({ length: 50 }, (_, index) => `parallel-${index}`);
  for (const id of ids) f.insert({ id });
  const results = await Promise.all(ids.map(appointmentId => dispatchBookingNotifications({ ...f.options, appointmentId, limit: 1,
    send: async request => {
      f.sent.push(request);
      await new Promise(resolve => setImmediate(resolve));
      return { accepted: true, duplicate: false, status: 200 };
    },
  })));
  assert.equal(f.sent.length, 30);
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 30);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 20);
  assert.equal(f.sqlite.prepare('SELECT count FROM booking_rate_limits').get().count, 30);
});

test('a failed external attempt consumes quota and its retry cannot exceed the daily limit', async t => {
  const f = fixture(t); f.insert();
  f.sqlite.prepare('INSERT INTO booking_rate_limits VALUES (?, ?, ?)')
    .run('demo-line-push:2026-10-13', 29, Date.parse('2026-10-13T16:00:00.000Z'));
  let calls = 0;
  const options = { ...f.options, send: async () => {
    calls += 1; throw Object.assign(new Error('synthetic uncertain transport'), { status: 502 });
  } };
  assert.equal((await dispatchBookingNotifications(options)).pending, 1);
  assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare('SELECT count FROM booking_rate_limits').get().count, 30);
  f.advance(30_000);
  assert.equal((await dispatchBookingNotifications(options)).skipped, 1);
  assert.equal(calls, 1);
  assert.equal(f.row().last_code, 'DEMO_DAILY_LIMIT');
  assert.equal(f.row().retry_key, KEY);
  assert.equal(f.sqlite.prepare('SELECT status FROM booking_appointments').get().status, 'pending');
});

test('quota resets at Taiwan midnight and removes expired quota buckets only', async t => {
  const f = fixture(t);
  let clock = Date.parse('2026-10-13T15:59:59.000Z');
  const options = { ...f.options, now: () => clock };
  f.sqlite.prepare('INSERT INTO booking_rate_limits VALUES (?, ?, ?)')
    .run('demo-line-push:2026-10-13', 30, Date.parse('2026-10-13T16:00:00.000Z'));
  f.sqlite.prepare('INSERT INTO booking_rate_limits VALUES (?, ?, ?)').run('unrelated-login-bucket', 2, 1);
  f.insert({ id: 'before-midnight' });
  assert.equal((await dispatchBookingNotifications(options)).skipped, 1);
  assert.equal(f.sent.length, 0);
  clock += 1_000;
  f.insert({ id: 'after-midnight', createdAt: clock, nextAttemptAt: clock });
  assert.equal((await dispatchBookingNotifications(options)).sent, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sqlite.prepare("SELECT count FROM booking_rate_limits WHERE key = 'demo-line-push:2026-10-13'").get(), undefined);
  const today = f.sqlite.prepare("SELECT * FROM booking_rate_limits WHERE key = 'demo-line-push:2026-10-14'").get();
  assert.equal(today.count, 1);
  assert.equal(today.expires_at, Date.parse('2026-10-14T16:00:00.000Z'));
  assert.equal(f.sqlite.prepare("SELECT count FROM booking_rate_limits WHERE key = 'unrelated-login-bucket'").get().count, 2);
  assert.equal(f.row('before-midnight').status, 'skipped', 'new day does not revive already skipped notices');
});

test('a quota reply crossing Taiwan midnight reserves from the new day before sending', async t => {
  const f = fixture(t); f.insert();
  let clock = Date.parse('2026-10-13T15:59:59.999Z');
  let crossed = false;
  const db = { prepare(sql) {
    const statement = f.options.db.prepare(sql);
    if (!sql.startsWith('INSERT INTO booking_rate_limits')) return statement;
    return { bind(...bindings) {
      const bound = statement.bind(...bindings);
      return { async first() {
        const result = await bound.first();
        if (!crossed) { crossed = true; clock += 1; }
        return result;
      } };
    } };
  } };
  const result = await dispatchBookingNotifications({ ...f.options, db, now: () => clock });
  assert.equal(result.sent, 1);
  assert.equal(f.sent.length, 1);
  const today = f.sqlite.prepare("SELECT * FROM booking_rate_limits WHERE key = 'demo-line-push:2026-10-14'").get();
  assert.equal(today.count, 1);
});

test('missing credentials, stale or expired notices and invalid recipients consume no daily quota', async t => {
  const f = fixture(t); f.insert({ id: 'missing-token' });
  await dispatchBookingNotifications({ ...f.options, accessToken: undefined, appointmentId: 'missing-token' });
  f.insert({ id: 'stale', currentRevision: 2, currentStatus: 'confirmed' });
  f.insert({ id: 'expired', createdAt: TIME - 86_400_000 });
  f.insert({ id: 'recipient-invalid' });
  for (const appointmentId of ['stale', 'expired', 'recipient-invalid']) {
    await dispatchBookingNotifications({ ...f.options, appointmentId, decryptLineId: async () => 'invalid-recipient' });
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM booking_rate_limits').get().count, 0);
  assert.equal(f.sent.length, 0);
});

test('quota database uncertainty fails closed, retains bookings and never logs sensitive errors', async t => {
  const f = fixture(t); f.insert();
  const before = f.sqlite.prepare('SELECT * FROM booking_appointments').get();
  const messages = [];
  t.mock.method(console, 'warn', (...args) => messages.push(args));
  const db = { prepare(sql) {
    if (sql.startsWith('INSERT INTO booking_rate_limits')) {
      return { bind() { return { async first() { throw new Error(`secret=${f.options.accessToken}, recipient=${USER}`); } }; } };
    }
    return f.options.db.prepare(sql);
  } };
  const result = await dispatchBookingNotifications({ ...f.options, db });
  assert.equal(f.sent.length, 0);
  assert.equal(result.pending, 1);
  assert.equal(f.row().status, 'sending', 'claim is recoverable after the existing lease expires');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM booking_appointments').get(), before);
  assert.deepEqual(messages, [['BOOKING_NOTIFICATION_QUEUE_UNAVAILABLE']]);
  for (const secret of [USER, f.options.accessToken, 'PRIVATE PATIENT', '0912345678']) {
    assert.equal(JSON.stringify({ result, messages }).includes(secret), false);
  }
});
