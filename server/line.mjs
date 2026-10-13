/**
 * Server-only LINE adapter. Never bundle this module or channel secrets into the UI.
 * Node >= 20 / Workers: only Web Crypto, fetch and standard web APIs are used.
 * Official references checked 2026-10-13:
 * https://developers.line.biz/en/reference/line-login/#verify-id-token
 * https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
 * https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
 * https://developers.line.biz/en/reference/messaging-api/#send-push-message
 */

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const TIMEOUT_MS = 8000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_TOKEN_ERROR_BYTES = 4096;
const encoder = new TextEncoder();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Codes are ours, never copied from provider errors (which may contain request data).
class LineIntegrationError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'LineIntegrationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 400) {
  return new LineIntegrationError(code, status);
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 502;
}

// Read a small error response only to select our own fixed classification.
// Never attach or log the upstream body, description or any submitted token.
async function tokenRejectionReason(response) {
  let reader;
  try {
    if (!response.body) return 'OTHER';
    const declared = response.headers?.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_TOKEN_ERROR_BYTES) {
      void response.body.cancel().catch(() => {});
      return 'OTHER';
    }
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_TOKEN_ERROR_BYTES) {
        void reader.cancel().catch(() => {});
        return 'OTHER';
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(payload)) return 'OTHER';
    switch (payload.error_description) {
      case 'IdToken expired.': return 'EXPIRED';
      case 'Invalid IdToken Audience.': return 'AUDIENCE_MISMATCH';
      case 'Invalid IdToken Issuer.': return 'ISSUER_MISMATCH';
      case 'Invalid IdToken.': return 'INVALID_TOKEN';
      default: return 'OTHER';
    }
  } catch {
    return 'OTHER';
  } finally {
    reader?.releaseLock();
  }
}

async function withTimeout(operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(fail('LINE_TIMEOUT', 504));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (error instanceof LineIntegrationError) throw error;
    const message=typeof error?.message==='string'?error.message:'';
    const reason=/Illegal invocation/i.test(message)?'FETCH_RECEIVER':/Unsupported.*redirect/i.test(message)?'REDIRECT_MODE':/Unsupported.*cache/i.test(message)?'CACHE_MODE':/not allowed|denied|blocked/i.test(message)?'NETWORK_RESTRICTED':/I\/O/i.test(message)?'IO_CONTEXT':'NETWORK_ERROR';
    console.warn('LINE_TRANSPORT_FAILURE',{reason,aborted:controller.signal.aborted});
    throw fail(controller.signal.aborted ? 'LINE_TIMEOUT' : 'LINE_NETWORK_ERROR', controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticate using LINE's server endpoint, never a browser-supplied profile. */
export async function verifyLineIdToken({ idToken, channelId, fetchImpl = fetch }) {
  if (!text(idToken, 16384) || typeof channelId !== 'string' || !/^\d{1,32}$/.test(channelId) || typeof fetchImpl !== 'function') {
    throw fail('LINE_INVALID_TOKEN_REQUEST');
  }
  return withTimeout(async (signal) => {
    const response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal,
      // Workers support manual redirects; reject the non-200 response below.
      redirect: 'manual',
    });
    if (response.status !== 200) {
      const error = fail('LINE_TOKEN_REJECTED', safeStatus(response.status));
      error.reason = await tokenRejectionReason(response);
      throw error;
    }
    let claims;
    try { claims = await response.json(); } catch { throw fail('LINE_INVALID_TOKEN_RESPONSE', 502); }
    if (!object(claims) || claims.aud !== channelId || claims.iss !== 'https://access.line.me' ||
        !text(claims.sub, 128) || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw fail('LINE_INVALID_TOKEN_CLAIMS', 401);
    }
    return { userId: claims.sub, channelId: claims.aud, expiresAt: claims.exp };
  });
}

function bytesOf(rawBody) {
  if (typeof rawBody === 'string') return encoder.encode(rawBody);
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  if (ArrayBuffer.isView(rawBody)) return new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  return null;
}

/** Call before parsing. Raw request bytes preserve Unicode, escapes and whitespace. */
export async function verifyWebhookSignature(rawBody, signature, channelSecret) {
  const bytes = bytesOf(rawBody);
  if (!bytes || bytes.byteLength > MAX_WEBHOOK_BYTES || !text(channelSecret, 4096) ||
      typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  let supplied;
  try {
    const decoded = atob(signature);
    if (decoded.length !== 32 || btoa(decoded) !== signature) return false;
    supplied = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch { return false; }
  const key = await crypto.subtle.importKey('raw', encoder.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  // All well-formed signatures perform 32 comparisons, with no early exit.
  // JavaScript/JIT does not promise hardware-level constant-time execution.
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= expected[index] ^ supplied[index];
  return difference === 0;
}

/** Only call after signature verification. Does not retain messages or reply tokens. */
export function parseWebhook(rawBody, expectedDestination) {
  const bytes = bytesOf(rawBody);
  if (!bytes || bytes.byteLength > MAX_WEBHOOK_BYTES) throw fail('LINE_INVALID_WEBHOOK');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail('LINE_INVALID_WEBHOOK'); }
  if (!object(payload) || !text(payload.destination, 128) || !Array.isArray(payload.events) || payload.events.length > 1000) {
    throw fail('LINE_INVALID_WEBHOOK');
  }
  if (expectedDestination !== undefined && (!text(expectedDestination, 128) || payload.destination !== expectedDestination)) {
    throw fail('LINE_WEBHOOK_DESTINATION_MISMATCH', 403);
  }
  const events = payload.events.map((event) => {
    if (!object(event) || !text(event.webhookEventId, 128) || typeof event.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event.type)) {
      throw fail('LINE_INVALID_WEBHOOK_EVENT');
    }
    const result = { webhookEventId: event.webhookEventId, type: event.type };
    if (own(event, 'source')) {
      if (!object(event.source) || !['user', 'group', 'room'].includes(event.source.type) ||
          (own(event.source, 'userId') && !text(event.source.userId, 128))) throw fail('LINE_INVALID_WEBHOOK_EVENT');
      result.source = { type: event.source.type };
      if (own(event.source, 'userId')) result.source.userId = event.source.userId;
    }
    if (own(event, 'timestamp')) {
      if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) throw fail('LINE_INVALID_WEBHOOK_EVENT');
      result.timestamp = event.timestamp;
    }
    if (own(event, 'deliveryContext')) {
      if (!object(event.deliveryContext) || typeof event.deliveryContext.isRedelivery !== 'boolean') throw fail('LINE_INVALID_WEBHOOK_EVENT');
      result.isRedelivery = event.deliveryContext.isRedelivery;
    }
    return result;
  });
  return { destination: payload.destination, events };
}

const noticeStatuses = Object.freeze({
  pending: ['預約申請已收到', '目前待診所確認；收到確認通知後，預約才成立。'],
  confirmed: ['預約已確認', '請依確認時間前往診所。'],
  rescheduled: ['預約時間已變更', '請以這次通知的時間為準。'],
  cancelled: ['預約已取消', '這筆預約已取消，無須依原時間前往。'],
  reminder: ['預約時間提醒', '請確認預約時間；如需調整，請使用下方連結。'],
});

function noticeText(value, maximum) {
  if (!text(value, maximum) || /[\u0000-\u001f\u007f]/.test(value)) throw fail('LINE_INVALID_NOTICE');
  return value.trim();
}

/** Deliberately excludes patient name, phone, treatment and any medical notes. */
export function buildAppointmentNotice({ clinicName, appointmentId, startLabel, status, manageUrl }) {
  if (!own(noticeStatuses, status)) throw fail('LINE_INVALID_NOTICE_STATUS');
  let url;
  try { url = new URL(manageUrl); } catch { throw fail('LINE_INVALID_MANAGE_URL'); }
  if (typeof manageUrl !== 'string' || manageUrl.length > 2048 || /\s/.test(manageUrl) ||
      url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw fail('LINE_INVALID_MANAGE_URL');
  const [title, explanation] = noticeStatuses[status];
  return {
    type: 'text',
    text: `${noticeText(clinicName, 80)}｜${title}\n預約編號：${noticeText(appointmentId, 80)}\n${status === 'cancelled' ? '原預約時間' : '預約時間'}：${noticeText(startLabel, 120)}\n${explanation}\n查看預約：${url.href}`,
  };
}

/**
 * Sends only a bounded text notice to one user. Call from a persisted, authorized outbox.
 * Persist one retryKey with each immutable notification; reuse it only within LINE's
 * 24-hour deduplication window. A 200/409 means acceptance, not proven delivery.
 */
export async function sendLinePush({ accessToken, userId, messages, retryKey, fetchImpl = fetch }) {
  if (!text(accessToken, 8192) || /[\s\r\n]/.test(accessToken) || typeof userId !== 'string' || !/^U[0-9a-f]{32}$/i.test(userId) ||
      typeof retryKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(retryKey) ||
      typeof fetchImpl !== 'function' || !Array.isArray(messages) || messages.length < 1 || messages.length > 5 ||
      messages.some((message) => !object(message) || message.type !== 'text' || !text(message.text, 5000) ||
        Object.keys(message).some((key) => !['type', 'text'].includes(key)))) throw fail('LINE_INVALID_PUSH_REQUEST');
  return withTimeout(async (signal) => {
    const response = await fetchImpl(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to: userId, messages: messages.map(({ type, text: content }) => ({ type, text: content })) }),
      signal,
      redirect: 'manual',
    });
    if (response.status === 200) return { accepted: true, duplicate: false, status: 200 };
    // LINE documents this header on a duplicate already-accepted request.
    if (response.status === 409 && response.headers?.get('x-line-accepted-request-id')) {
      return { accepted: true, duplicate: true, status: 409 };
    }
    throw fail('LINE_PUSH_REJECTED', safeStatus(response.status));
  });
}
