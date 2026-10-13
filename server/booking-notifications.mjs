import { buildAppointmentNotice, sendLinePush } from './line.mjs';

const LEASE_MS = 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const DAILY_SEND_LIMIT = 30;
const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_QUOTA_PREFIX = 'demo-line-push:';
const STATUSES = new Set(['pending', 'confirmed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const cleanText = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const empty = configured => ({ sent: 0, pending: 0, failed: 0, skipped: 0, configured });

function scopeFor(appointmentId, clinicIds) {
  const clauses = [], bindings = [];
  if (appointmentId !== undefined) {
    if (!identifier(appointmentId)) throw new Error('INVALID_SCOPE');
    clauses.push('a.id = ?'); bindings.push(appointmentId);
  }
  if (clinicIds !== undefined) {
    if (!Array.isArray(clinicIds) || clinicIds.length > 100 || clinicIds.some(value => !identifier(value))) {
      throw new Error('INVALID_SCOPE');
    }
    const unique = [...new Set(clinicIds)];
    clauses.push(unique.length ? `a.clinic_id IN (${unique.map(() => '?').join(',')})` : '0 = 1');
    bindings.push(...unique);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', bindings };
}

function manageUrlFor(publicOrigin, liffUrl) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new Error('INVALID_ORIGIN');
  }
  if (!liffUrl) return `${origin.origin}/`;
  const url = new URL(liffUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'liff.line.me' || url.port || url.username || url.password ||
      url.search || url.hash || !/^\/\d{1,32}-[A-Za-z0-9]+\/?$/.test(url.pathname)) throw new Error('INVALID_LIFF_URL');
  return url.href;
}

function messageFor(row, manageUrl) {
  let payload;
  try { payload = JSON.parse(row.payload); } catch { throw new Error('INVALID_PAYLOAD'); }
  const allowed = new Set(['appointmentId', 'clinicName', 'doctorName', 'startAt', 'status', 'revision']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !allowed.has(key)) || payload.appointmentId !== row.appointment_id ||
      payload.revision !== row.appointment_revision || payload.status !== row.kind || !STATUSES.has(payload.status) ||
      !cleanText(payload.clinicName, 64) || (payload.doctorName !== undefined && !cleanText(payload.doctorName, 80)) ||
      typeof payload.startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.startAt) ||
      !Number.isFinite(Date.parse(payload.startAt))) throw new Error('INVALID_PAYLOAD');
  const startLabel = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(payload.startAt));
  const notice = buildAppointmentNotice({
    clinicName: `【示範】${payload.clinicName.trim()}`, appointmentId: payload.appointmentId,
    startLabel: `${startLabel}（台灣時間）`, status: payload.status, manageUrl,
  });
  // The label appears in every notice, including cancellations and retries.
  notice.text += '\n此為示範流程，並非實際診所掛號；最新狀態請以預約頁面為準。';
  return notice;
}

/**
 * Dispatch only a caller-authorized scope after the appointment transaction commits.
 * A durable claim and a fixed LINE retry key prevent concurrent duplicate sends.
 * `sent` means provider acceptance, never proof of handset delivery. Result counts
 * are changes made by this pass, except `pending`, which is the remaining scoped
 * pending/sending count. Never expose raw provider errors, tokens or recipients.
 *
 * Retry expiry is conservatively anchored to outbox creation because the schema
 * has no first-attempt timestamp. Old rows require explicit operator resolution;
 * this function never rotates their retry keys or sends after the 24-hour window.
 */
export async function dispatchBookingNotifications({
  db, accessToken, decryptLineId, publicOrigin, liffUrl, now = Date.now,
  send = sendLinePush, limit = 10, appointmentId, clinicIds,
} = {}) {
  const configured = typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= 8192 &&
    !/\s/.test(accessToken);
  const result = empty(configured);
  if (!db || typeof db.prepare !== 'function') return empty(false);
  let scope;
  try { scope = scopeFor(appointmentId, clinicIds); } catch { return empty(false); }
  const countPending = async () => {
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM booking_outbox o
      JOIN booking_appointments a ON a.id = o.appointment_id
      WHERE o.status IN ('pending', 'sending')${scope.sql}`).bind(...scope.bindings).first();
    result.pending = Number(count?.count) || 0;
  };
  // A missing credential must not claim rows, increment attempts or discard work.
  if (!configured) {
    try { await countPending(); } catch { /* Database diagnostics never reach callers. */ }
    return result;
  }
  let manageUrl;
  try {
    manageUrl = manageUrlFor(publicOrigin, liffUrl);
    if (typeof decryptLineId !== 'function' || typeof send !== 'function' || typeof now !== 'function' ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_CONFIGURATION');
  } catch {
    result.configured = false;
    try { await countPending(); } catch { /* No row is claimed with invalid settings. */ }
    return result;
  }

  async function finish(row, status, code, nextAttemptAt, acceptedAt = null) {
    const response = await db.prepare(`UPDATE booking_outbox SET status = ?, last_code = ?,
      next_attempt_at = ?, accepted_at = ?, claim_token = NULL, claimed_until = NULL
      WHERE id = ? AND status = 'sending' AND claim_token = ?`).bind(
      status, code, nextAttemptAt, acceptedAt, row.id, row.claim_token,
    ).run();
    if (response?.success !== true) throw new Error('OUTBOX_UNAVAILABLE');
    if (Number(response?.meta?.changes) === 1 && status in result && status !== 'pending') result[status] += 1;
  }

  async function reserveDailyAttempt() {
    // One site-wide counter includes every external attempt, even a retry or a
    // request whose acceptance is unknown. Never refund a consumed permit.
    // D1 executes this conditional UPSERT atomically across Worker instances.
    for (let rollover = 0; rollover < 2; rollover += 1) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('INVALID_CLOCK');
      const bucket = Math.floor((timestamp + TAIPEI_OFFSET_MS) / DAY_MS);
      const date = new Date(bucket * DAY_MS).toISOString().slice(0, 10);
      const expiresAt = (bucket + 1) * DAY_MS - TAIPEI_OFFSET_MS;
      const cleanup = await db.prepare(`DELETE FROM booking_rate_limits WHERE key IN
        (SELECT key FROM booking_rate_limits WHERE key LIKE ? AND expires_at <= ? LIMIT 100)`)
        .bind(`${DAILY_QUOTA_PREFIX}%`, timestamp).run();
      if (cleanup?.success !== true) throw new Error('QUOTA_UNAVAILABLE');
      const quota = await db.prepare(`INSERT INTO booking_rate_limits (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
        .bind(`${DAILY_QUOTA_PREFIX}${date}`, expiresAt, DAILY_SEND_LIMIT).first();
      const afterReservation = now();
      if (!Number.isSafeInteger(afterReservation) || afterReservation < 0) throw new Error('INVALID_CLOCK');
      // If midnight passed while D1 was answering, reserve from the new day too.
      // The old permit is deliberately discarded rather than refunded.
      if (Math.floor((afterReservation + TAIPEI_OFFSET_MS) / DAY_MS) !== bucket) continue;
      if (quota === null) return false;
      if (!Number.isSafeInteger(quota?.count) || quota.count < 1 || quota.count > DAILY_SEND_LIMIT) {
        throw new Error('QUOTA_UNAVAILABLE');
      }
      return true;
    }
    throw new Error('QUOTA_CLOCK_CHANGED');
  }

  try {
    for (let index = 0; index < limit; index += 1) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('INVALID_CLOCK');
      const claimToken = crypto.randomUUID();
      const row = await db.prepare(`UPDATE booking_outbox SET status = 'sending', attempts = attempts + 1,
        claim_token = ?, claimed_until = ?
        WHERE id = (SELECT o.id FROM booking_outbox o
          JOIN booking_appointments a ON a.id = o.appointment_id
          WHERE ((o.status = 'pending' AND o.next_attempt_at <= ?)
            OR (o.status = 'sending' AND o.claimed_until <= ?))${scope.sql}
          ORDER BY o.created_at, o.id LIMIT 1)
        RETURNING *`).bind(claimToken, timestamp + LEASE_MS, timestamp, timestamp, ...scope.bindings).first();
      if (!row) break;

      // Reload current appointment state after claiming and immediately before
      // sending. Already superseded notices never consume provider quota.
      const current = await db.prepare(`SELECT revision, status, notification_consent FROM booking_appointments
        WHERE id = ?`).bind(row.appointment_id).first();
      if (!current || current.revision !== row.appointment_revision || current.status !== row.kind ||
          current.notification_consent !== 1) {
        await finish(row, 'skipped', 'NOTICE_SUPERSEDED', timestamp);
        continue;
      }
      if (!Number.isSafeInteger(row.created_at) || row.created_at > timestamp ||
          timestamp - row.created_at >= RETRY_WINDOW_MS) {
        await finish(row, 'failed', 'RETRY_WINDOW_EXPIRED', timestamp);
        continue;
      }
      if (row.attempts > MAX_ATTEMPTS) {
        await finish(row, 'failed', 'RETRY_EXHAUSTED', timestamp);
        continue;
      }

      let userId, message;
      try {
        if (typeof row.retry_key !== 'string' || !UUID.test(row.retry_key)) throw new Error('INVALID_RETRY_KEY');
        message = messageFor(row, manageUrl);
        userId = await decryptLineId(row.line_cipher);
        if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/i.test(userId)) throw new Error('INVALID_RECIPIENT');
      } catch {
        await finish(row, 'failed', 'INVALID_NOTICE_OR_RECIPIENT', timestamp);
        continue;
      }

      const latest = await db.prepare(`SELECT revision, status, notification_consent FROM booking_appointments
        WHERE id = ?`).bind(row.appointment_id).first();
      if (!latest || latest.revision !== row.appointment_revision || latest.status !== row.kind ||
          latest.notification_consent !== 1) {
        await finish(row, 'skipped', 'NOTICE_SUPERSEDED', timestamp);
        continue;
      }

      if (now() - row.created_at >= RETRY_WINDOW_MS) {
        await finish(row, 'failed', 'RETRY_WINDOW_EXPIRED', now());
        continue;
      }
      // Quota is the final gate, after identity, consent, freshness and payload
      // validation. Database uncertainty fails closed and retains the booking.
      if (!await reserveDailyAttempt()) {
        await finish(row, 'skipped', 'DEMO_DAILY_LIMIT', now());
        continue;
      }
      if (now() - row.created_at >= RETRY_WINDOW_MS) {
        await finish(row, 'failed', 'RETRY_WINDOW_EXPIRED', now());
        continue;
      }
      try {
        const accepted = await send({ accessToken, userId, messages: [message], retryKey: row.retry_key });
        if (accepted?.accepted !== true || ![200, 409].includes(accepted.status)) {
          throw Object.assign(new Error('UNCONFIRMED_ACCEPTANCE'), { status: 502 });
        }
        await finish(row, 'sent', accepted.duplicate ? 'LINE_ALREADY_ACCEPTED' : 'LINE_ACCEPTED', timestamp, now());
      } catch (error) {
        // The same key is retained even when it is unknown whether LINE accepted
        // the request. A crash after acceptance is also retried with that key.
        const status = Number.isInteger(error?.status) ? error.status : 502;
        const transient = status === 429 || status >= 500;
        const nextAttemptAt = timestamp + Math.min(3_600_000, 30_000 * 2 ** (row.attempts - 1));
        if (transient && row.attempts < MAX_ATTEMPTS && nextAttemptAt < row.created_at + RETRY_WINDOW_MS) {
          await finish(row, 'pending', status === 429 ? 'LINE_RATE_LIMITED' : 'LINE_RETRY_PENDING', nextAttemptAt);
        } else {
          await finish(row, 'failed', transient ? 'RETRY_EXHAUSTED' : 'LINE_REQUEST_REJECTED', timestamp);
        }
      }
    }
  } catch {
    // Booking data has already committed. A queue/database failure must not turn
    // that successful booking into an apparent failure or leak SQL bindings.
    console.warn('BOOKING_NOTIFICATION_QUEUE_UNAVAILABLE');
  }
  try { await countPending(); } catch { console.warn('BOOKING_NOTIFICATION_COUNT_UNAVAILABLE'); }
  return result;
}
