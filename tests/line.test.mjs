import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLineIdToken, verifyWebhookSignature, parseWebhook, buildAppointmentNotice, sendLinePush } from '../server/line.mjs';

const USER = `U${'1'.repeat(32)}`;
const CHANNEL = '1234567890';
const RETRY_KEY = '123e4567-e89b-12d3-a456-426614174000';
const tokenOptions = (extra = {}) => ({ idToken: 'test-token-not-real', channelId: CHANNEL, ...extra });
const claims = (extra = {}) => ({ sub: USER, aud: CHANNEL, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
const response = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers });
const webhook = (events = [], extra = {}) => JSON.stringify({ destination: USER, events, ...extra });
const event = (extra = {}) => ({ webhookEventId: '01fixture', type: 'follow', source: { type: 'user', userId: USER }, timestamp: 123, deliveryContext: { isRedelivery: false }, ...extra });
const notice = (extra = {}) => ({ clinicName: '範例牙醫診所', appointmentId: 'D-100', startLabel: '2026/10/20（二）14:00（台北時間）', status: 'confirmed', manageUrl: 'https://booking.example.test/appointments/D-100', ...extra });
const push = (extra = {}) => ({ accessToken: 'secret-access-token-fixture', userId: USER, messages: [buildAppointmentNotice(notice())], retryKey: RETRY_KEY, ...extra });

test('ID token verification uses POST form encoding and returns only trusted identity claims', async () => {
  const expected = claims({ name: 'Should not be retained', email: 'private@example.test', picture: 'https://example.test/picture' });
  const actual = await verifyLineIdToken(tokenOptions({ idToken: 'token+special&characters', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(init.body.get('id_token'), 'token+special&characters');
    assert.equal(init.body.get('client_id'), CHANNEL);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return response(expected);
  }, profile: { userId: 'attacker' } }));
  assert.deepEqual(actual, { userId: USER, channelId: CHANNEL, expiresAt: expected.exp });
});

test('ID token claims reject cross-channel audience, issuer, expiry and invalid subjects', async () => {
  for (const change of [{ aud: 'another-channel' }, { aud: [CHANNEL] }, { iss: 'https://attacker.test' }, { sub: '' }, { sub: ' ' },
    { exp: Math.floor(Date.now() / 1000) }, { exp: 1 }, { exp: '9999999999' }, { exp: 1.1 }]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => response(claims(change)) })), { code: 'LINE_INVALID_TOKEN_CLAIMS', status: 401 });
  }
  for (const bad of [null, [], {}]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => response(bad) })), { code: 'LINE_INVALID_TOKEN_CLAIMS' });
  }
});

test('ID token requests validate configuration before making a network call', async () => {
  let called = false;
  for (const change of [{ channelId: 123 }, { channelId: ' ' }, { idToken: '' }, { idToken: 'x'.repeat(16385) }]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ ...change, fetchImpl: async () => { called = true; } })), { code: 'LINE_INVALID_TOKEN_REQUEST' });
  }
  assert.equal(called, false);
});

test('ID token failures never forward provider response text or secret values', async () => {
  const secret = 'test-token-not-real';
  for (const fetchImpl of [async () => response({ error_description: secret }, 401), async () => new Response(secret),
    async () => { throw Object.assign(new Error(secret), { name: 'LineIntegrationError', code: secret, status: 401 }); }]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl })), (error) => {
      assert.equal(`${error}${JSON.stringify(error)}`.includes(secret), false);
      return /^LINE_[A-Z_]+$/.test(error.code) && Number.isInteger(error.status);
    });
  }
});

test('ID token rejection maps only exact official descriptions to fixed reasons', async () => {
  for (const [description, reason] of [
    ['IdToken expired.', 'EXPIRED'],
    ['Invalid IdToken Audience.', 'AUDIENCE_MISMATCH'],
    ['Invalid IdToken Issuer.', 'ISSUER_MISMATCH'],
    ['Invalid IdToken.', 'INVALID_TOKEN'],
    ['Invalid IdToken Nonce.', 'OTHER'],
  ]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => response({ error_description: description }, 400) })),
      { code: 'LINE_TOKEN_REJECTED', status: 400, reason });
  }
});

test('ID token rejection never exposes or logs private echoes or additional provider fields', async (context) => {
  const warning = context.mock.method(console, 'warn', () => {});
  const secret = 'private-token-echo-do-not-disclose';
  for (const description of [secret, `IdToken expired. ${secret}`, 'IdToken expired.']) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ idToken: secret,
      fetchImpl: async () => response({ error_description: description, submitted_token: secret, provider_private_field: secret }, 401) })), (error) => {
      assert.equal(error.code, 'LINE_TOKEN_REJECTED');
      assert.equal(error.status, 401);
      assert.equal(error.reason, description === 'IdToken expired.' ? 'EXPIRED' : 'OTHER');
      assert.doesNotMatch(`${error}${JSON.stringify(error)}`, /private-token-echo|IdToken expired|submitted_token|provider_private_field/);
      return true;
    });
  }
  assert.equal(warning.mock.callCount(), 0);
});

test('ID token malformed and unknown error responses retain safe rejection status with OTHER reason', async () => {
  for (const body of ['not json', 'null', '[]', '{}', '{"error_description":42}', '{"error_description":"new upstream error"}', new Uint8Array([0xff])]) {
    await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => new Response(body, { status: 503 }) })),
      { code: 'LINE_TOKEN_REJECTED', status: 503, reason: 'OTHER' });
  }
  await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => new Response(null, { status: 429 }) })),
    { code: 'LINE_TOKEN_REJECTED', status: 429, reason: 'OTHER' });
  const failedBody = new ReadableStream({ start(controller) { controller.error(new Error('private-provider-error')); } });
  await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => new Response(failedBody, { status: 400 }) })),
    { code: 'LINE_TOKEN_REJECTED', status: 400, reason: 'OTHER' });
});

test('ID token error body is bounded to 4096 bytes and oversized streams are cancelled', async () => {
  let cancelled = false;
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error_description: 'IdToken expired.', ignored: 'x'.repeat(4096) }))); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => new Response(oversized, { status: 400 }) })),
    { code: 'LINE_TOKEN_REJECTED', status: 400, reason: 'OTHER' });
  assert.equal(cancelled, true);
  await assert.rejects(verifyLineIdToken(tokenOptions({ fetchImpl: async () => response({ error_description: 'IdToken expired.' }, 400, { 'Content-Length': '4097' }) })),
    { code: 'LINE_TOKEN_REJECTED', status: 400, reason: 'OTHER' });
});

test('ID token timeout covers stalled rejection-body parsing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyRead;
  const started = new Promise((resolve) => { bodyRead = resolve; });
  let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; }, pull() { bodyRead(); } });
  const operation = verifyLineIdToken(tokenOptions({ fetchImpl: async () => new Response(body, { status: 400 }) }));
  const rejection = assert.rejects(operation, { code: 'LINE_TIMEOUT', status: 504 });
  await started;
  context.mock.timers.tick(8000);
  await rejection;
  streamController.close();
});

test('webhook HMAC accepts the fixed signature from LINE official documentation', async () => {
  assert.equal(await verifyWebhookSignature('{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}',
    'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=', '8c570fa6dd201bb328f1c1eac23a96d8'), true);
});

test('webhook HMAC uses raw Unicode bytes and rejects whitespace, Unicode or escape changes', async () => {
  const body = '{"destination":"U11111111111111111111111111111111","events":[],"note":"牙醫🦷\\n預約"}';
  const signature = 'EnAzcaNdnsw0mRoojC1gupBTNyU9us7t2pXNtcN0pRo=';
  const secret = 'fixture-secret-not-real';
  assert.equal(await verifyWebhookSignature(body, signature, secret), true);
  const bytes = new TextEncoder().encode(body);
  assert.equal(await verifyWebhookSignature(bytes, signature, secret), true);
  assert.equal(await verifyWebhookSignature(bytes.buffer, signature, secret), true);
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 4);
  assert.equal(await verifyWebhookSignature(padded.subarray(4, -4), signature, secret), true);
  for (const tampered of [`${body}\n`, body.replace('牙醫', '牙科'), body.replace('\\n', '\n'), JSON.stringify(JSON.parse(body), null, 2)]) {
    assert.equal(await verifyWebhookSignature(tampered, signature, secret), false);
  }
  assert.equal(await verifyWebhookSignature(body, signature, 'other-secret'), false);
});

test('webhook HMAC rejects absent, malformed and noncanonical base64 signatures', async () => {
  for (const signature of [undefined, '', '*'.repeat(43) + '=', 'AA==', 'A'.repeat(44), 'A'.repeat(42) + 'B=', 'A'.repeat(42) + '/=']) {
    assert.equal(await verifyWebhookSignature('{}', signature, 'fixture'), false);
  }
  assert.equal(await verifyWebhookSignature({}, 'A'.repeat(43) + '=', 'fixture'), false);
  assert.equal(await verifyWebhookSignature('{}', 'A'.repeat(43) + '=', ''), false);
  assert.equal(await verifyWebhookSignature(new Uint8Array(1024 * 1024 + 1), 'A'.repeat(43) + '=', 'fixture'), false);
});

test('webhook parsing permits empty verification request and binds the destination', () => {
  assert.deepEqual(parseWebhook(webhook(), USER), { destination: USER, events: [] });
  assert.throws(() => parseWebhook(webhook(), 'another-bot'), { code: 'LINE_WEBHOOK_DESTINATION_MISMATCH', status: 403 });
});

test('webhook parser minimizes every event, discarding message contents, group ids and reply tokens', () => {
  const events = [event({ type: 'message', replyToken: 'private', message: { text: 'private medical notes', id: 'private-message-id' }, extra: 'drop' }),
    event({ webhookEventId: '02fixture', type: 'unfollow', deliveryContext: { isRedelivery: true }, source: { type: 'group', userId: USER, groupId: 'private-group' } })];
  assert.deepEqual(parseWebhook(webhook(events, { extra: 'drop' })).events, [
    { webhookEventId: '01fixture', type: 'message', source: { type: 'user', userId: USER }, timestamp: 123, isRedelivery: false },
    { webhookEventId: '02fixture', type: 'unfollow', source: { type: 'group', userId: USER }, timestamp: 123, isRedelivery: true },
  ]);
  assert.doesNotMatch(JSON.stringify(parseWebhook(webhook(events))), /private/);
});

test('webhook parser tolerates unknown event types without retaining their unknown contents', () => {
  assert.deepEqual(parseWebhook(webhook([{ webhookEventId: '03fixture', type: 'futureEvent', unrecognized: { private: 'drop' } }])).events,
    [{ webhookEventId: '03fixture', type: 'futureEvent' }]);
});

test('webhook parser rejects malformed envelopes, invalid UTF-8 and partial event batches', () => {
  for (const body of ['bad json', 'null', '[]', '{}', webhook([], { events: {} }), webhook([], { destination: '' }), new Uint8Array([0xff])]) {
    assert.throws(() => parseWebhook(body), { code: 'LINE_INVALID_WEBHOOK' });
  }
  for (const bad of [null, {}, event({ webhookEventId: '' }), event({ type: 42 }), event({ source: { type: 'user', userId: null } }),
    event({ source: { type: 'unknown' } }), event({ timestamp: '123' }), event({ deliveryContext: { isRedelivery: 'true' } })]) {
    assert.throws(() => parseWebhook(webhook([event(), bad])), { code: 'LINE_INVALID_WEBHOOK_EVENT' });
  }
});

test('appointment notices contain minimal details and ignore patient and treatment fields', () => {
  const message = buildAppointmentNotice(notice({ patientName: 'private-name', phone: '0912345678', treatment: 'private-treatment' }));
  assert.equal(message.type, 'text');
  assert.match(message.text, /預約已確認/);
  assert.match(message.text, /台北時間/);
  assert.doesNotMatch(message.text, /private|0912345678/);
  assert.deepEqual(Object.keys(message), ['type', 'text']);
});

test('pending and cancelled notices cannot be mistaken for a confirmed visit', () => {
  const pending = buildAppointmentNotice(notice({ status: 'pending' })).text;
  assert.match(pending, /待診所確認/);
  assert.doesNotMatch(pending, /請依確認時間前往|預約已確認/);
  const cancelled = buildAppointmentNotice(notice({ status: 'cancelled' })).text;
  assert.match(cancelled, /預約已取消/);
  assert.match(cancelled, /無須依原時間前往/);
  assert.match(cancelled, /原預約時間/);
  assert.doesNotMatch(cancelled, /請依確認時間前往|预約已確認/);
  assert.match(buildAppointmentNotice(notice({ status: 'rescheduled' })).text, /時間已變更/);
  assert.match(buildAppointmentNotice(notice({ status: 'reminder' })).text, /預約時間提醒/);
  assert.throws(() => buildAppointmentNotice(notice({ status: 'checked_in' })), { code: 'LINE_INVALID_NOTICE_STATUS' });
});

test('appointment links require HTTPS without credentials; notice lines reject injection', () => {
  for (const manageUrl of ['http://example.test', 'javascript:alert(1)', '/relative', 'https://user:pass@example.test', 'https://example.test/a\nb']) {
    assert.throws(() => buildAppointmentNotice(notice({ manageUrl })), { code: 'LINE_INVALID_MANAGE_URL' });
  }
  for (const change of [{ clinicName: '診所\n另一段' }, { appointmentId: '' }, { startLabel: 'x'.repeat(121) }]) {
    assert.throws(() => buildAppointmentNotice(notice(change)), { code: 'LINE_INVALID_NOTICE' });
  }
});

test('push uses the single-recipient endpoint, persistent retry key and bounded notice body', async () => {
  const options = push();
  const result = await sendLinePush({ ...options, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${options.accessToken}`);
    assert.equal(init.headers['X-Line-Retry-Key'], RETRY_KEY);
    assert.deepEqual(JSON.parse(init.body), { to: USER, messages: options.messages });
    assert.ok(init.signal instanceof AbortSignal);
    return response({ sentMessages: [{ id: 'not-retained' }] });
  } });
  assert.deepEqual(result, { accepted: true, duplicate: false, status: 200 });
  assert.equal('delivered' in result, false);
});

test('push treats an accepted duplicate as idempotent, without claiming delivery', async () => {
  assert.deepEqual(await sendLinePush(push({ fetchImpl: async () => response({}, 409, { 'x-line-accepted-request-id': 'original-request' }) })),
    { accepted: true, duplicate: true, status: 409 });
  await assert.rejects(sendLinePush(push({ fetchImpl: async () => response({}, 409) })), { code: 'LINE_PUSH_REJECTED', status: 409 });
});

test('push validates recipient, retry key, credentials and message shape before sending', async () => {
  let called = false;
  for (const change of [{ userId: 'group-id' }, { retryKey: '' }, { retryKey: 'not-a-uuid' }, { accessToken: 'x\r\nInjected: value' },
    { messages: [] }, { messages: Array(6).fill({ type: 'text', text: 'test' }) }, { messages: [{ type: 'text', text: 'x'.repeat(5001) }] },
    { messages: [{ type: 'text', text: 'hello', sender: { name: 'untrusted' } }] }, { messages: [{ type: 'image', originalContentUrl: 'https://example.test' }] }]) {
    await assert.rejects(sendLinePush(push({ ...change, fetchImpl: async () => { called = true; } })), { code: 'LINE_INVALID_PUSH_REQUEST' });
  }
  assert.equal(called, false);
});

test('push errors are bounded and never expose tokens, provider text or request identifiers', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    await assert.rejects(sendLinePush(push({ fetchImpl: async () => response({ message: 'secret-access-token-fixture', details: 'private notes' }, status) })), (error) => {
      assert.equal(error.code, 'LINE_PUSH_REJECTED');
      assert.equal(error.status, status);
      assert.doesNotMatch(`${error}${JSON.stringify(error)}`, /secret-access-token-fixture|private notes/);
      return true;
    });
  }
  await assert.rejects(sendLinePush(push({ fetchImpl: async () => { throw new Error('secret-access-token-fixture'); } })), { code: 'LINE_NETWORK_ERROR', status: 502 });
});

test('LINE requests abort within eight seconds, including a fetch that never resolves', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const operation = sendLinePush(push({ fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}); } }));
  const rejection = assert.rejects(operation, { code: 'LINE_TIMEOUT', status: 504 });
  context.mock.timers.tick(8000);
  await rejection;
  assert.equal(signal.aborted, true);
});

test('token verification timeout covers delayed response body parsing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = verifyLineIdToken(tokenOptions({ fetchImpl: async () => ({ status: 200, json: () => new Promise(() => {}) }) }));
  const rejection = assert.rejects(operation, { code: 'LINE_TIMEOUT', status: 504 });
  context.mock.timers.tick(8000);
  await rejection;
});
