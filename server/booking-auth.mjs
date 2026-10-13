const encoder = new TextEncoder();
const COOKIE = '__Host-dental_session';
const MAX_AGE = 8 * 60 * 60 * 1000;
const validSubject = value => typeof value === 'string' && /^U[0-9a-f]{32}$/i.test(value);
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unbase64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export function bookingError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function equal(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export function createBookingAuth({ db, secret, providerId, adminLineId, now = Date.now }) {
  if (!db?.prepare || !db?.batch || typeof secret !== 'string' || secret.length < 43 || !/^\d+$/.test(providerId ?? '')) throw bookingError('BOOKING_NOT_CONFIGURED', 503);
  const hmacKey = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  async function mac(value) { return base64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey, encoder.encode(value)))); }
  const encryptionKey = mac('booking:encryption:v1').then(value => crypto.subtle.importKey('raw', unbase64(value), 'AES-GCM', false, ['encrypt', 'decrypt']));
  const aad = encoder.encode(`line-subject:${providerId}:v1`);
  async function patientKey(userId) { if (!validSubject(userId)) throw bookingError('INVALID_LINE_IDENTITY', 401); return mac(`patient:${providerId}:${userId}`); }
  async function encryptLineId(userId) {
    if (!validSubject(userId)) throw bookingError('INVALID_LINE_IDENTITY', 401);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await encryptionKey, encoder.encode(userId));
    return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
  }
  async function decryptLineId(cipher) {
    try {
      if (typeof cipher !== 'string' || cipher.length > 256) throw new Error();
      const [version, iv, data, extra] = cipher.split('.');
      if (version !== 'v1' || !iv || !data || extra) throw new Error();
      const result = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: aad }, await encryptionKey, unbase64(data)));
      if (!validSubject(result)) throw new Error();
      return result;
    } catch { throw bookingError('IDENTITY_UNAVAILABLE', 503); }
  }
  async function establish({ userId, expiresAt }) {
    const current = now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= current) throw bookingError('LOGIN_EXPIRED', 401);
    const token = base64(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await mac(`session:${token}`);
    const key = await patientKey(userId);
    const lineCipher = await encryptLineId(userId);
    const expires = Math.min(current + MAX_AGE, expiresAt * 1000);
    const result = await db.batch([
      db.prepare('DELETE FROM booking_sessions WHERE expires_at <= ?').bind(current),
      db.prepare('INSERT INTO booking_sessions (token_hash,patient_key,line_cipher,expires_at,created_at) VALUES (?,?,?,?,?)').bind(tokenHash, key, lineCipher, expires, current),
    ]);
    if (!Array.isArray(result) || result.length !== 2 || result.some(r => r?.success !== true)) throw bookingError('STORAGE_UNAVAILABLE', 503);
    return { token, patientKey: key, lineCipher, expiresAt: expires, cookie: `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((expires - current) / 1000))}` };
  }
  async function read(request) {
    const matches = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await db.prepare('SELECT patient_key,line_cipher,expires_at FROM booking_sessions WHERE token_hash = ? AND expires_at > ?').bind(await mac(`session:${token}`), now()).first();
    if (!row) return null;
    const isAdmin = validSubject(adminLineId) && equal(row.patient_key, await patientKey(adminLineId));
    return { token, patientKey: row.patient_key, lineCipher: row.line_cipher, expiresAt: row.expires_at, isAdmin, csrfToken: await mac(`csrf:${token}`) };
  }
  async function logout(session) { if (session) await db.prepare('DELETE FROM booking_sessions WHERE token_hash = ?').bind(await mac(`session:${session.token}`)).run(); }
  async function rateLimit(scope, identifier, limit, windowMs) {
    const current = now();
    const key = await mac(`rate:${scope}:${identifier}:${Math.floor(current / windowMs)}`);
    const row = await db.prepare('INSERT INTO booking_rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, current + windowMs).first();
    if (!row || row.count > limit) throw bookingError('RATE_LIMITED', 429);
    // Expired buckets contain hashes only; bounded cleanup avoids indefinite growth.
    await db.prepare('DELETE FROM booking_rate_limits WHERE key IN (SELECT key FROM booking_rate_limits WHERE expires_at < ? LIMIT 100)').bind(current).run();
  }
  return { establish, read, logout, patientKey, encryptLineId, decryptLineId, rateLimit, clearCookie: `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` };
}

export function assertMutation(request, origin, session, { csrf = true } = {}) {
  if (!origin || request.headers.get('origin') !== origin) throw bookingError('ORIGIN_REJECTED', 403);
  if (csrf && (!session || !equal(request.headers.get('x-csrf-token'), session.csrfToken))) throw bookingError('CSRF_REJECTED', 403);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw bookingError('JSON_REQUIRED', 415);
}

export async function readBookingJson(request, maximum = 20000) {
  const reader = request.body?.getReader();
  if (!reader) throw bookingError('INVALID_REQUEST');
  let size = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { await reader.cancel(); throw bookingError('INVALID_REQUEST', 413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw bookingError('INVALID_REQUEST'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bookingError('INVALID_REQUEST');
  return value;
}
