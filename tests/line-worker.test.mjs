// Run here: node --test work/line-worker.test.mjs
// After copying into the gateway: node --test tests/line-worker.test.mjs
// Uses the actual Workerd runtime. Every outbound request is mocked; external
// network connections are explicitly disabled. No account credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = existsSync(new URL('../server/line.mjs', import.meta.url))
  ? new URL('../', import.meta.url)
  : new URL('./dental-line-gateway/', import.meta.url);
const require = createRequire(new URL('package.json', project));
const { Miniflare, createFetchMock } = require('miniflare');
const { build } = require('esbuild');
const CHANNEL = '1234567890';
const USER = `U${'1'.repeat(32)}`;
const TOKEN = 'synthetic-worker-test-token';
const ACCESS_TOKEN = 'synthetic-worker-test-access-token';
const RETRY_KEY = '123e4567-e89b-12d3-a456-426614174000';
const claims = { sub: USER, aud: CHANNEL, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 3600,
  name: 'Do not return this profile', email: 'private@example.test' };

const entry = `
import { verifyLineIdToken, sendLinePush } from './server/line.mjs';
export default { async fetch(request) {
  const input = await request.json();
  try {
    // Deliberately omit fetchImpl: the default Worker global fetch is what Node
    // tests with injected fake functions did not exercise.
    const result = input.kind === 'verify'
      ? await verifyLineIdToken({idToken:input.idToken,channelId:input.channelId})
      : await sendLinePush({accessToken:input.accessToken,userId:input.userId,messages:input.messages,retryKey:input.retryKey});
    return Response.json({ok:true,result});
  } catch(error) {
    return Response.json({ok:false,code:error.code,status:error.status,message:error.message});
  }
}};`;
const bundlePromise = build({stdin:{contents:entry,resolveDir:fileURLToPath(project),sourcefile:'line-worker-regression.mjs'},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});

async function fixture(context, { path, status = 200, data = {}, headers = {} }) {
  const mock = createFetchMock();
  mock.disableNetConnect();
  const seen = [];
  let redirectRequests = 0;
  mock.get('https://api.line.me').intercept({ path, method: 'POST' }).reply((options) => {
    seen.push({ method: options.method, path: options.path, headers: new Headers(options.headers), body: new Response(options.body).text() });
    return { statusCode: status, data: JSON.stringify(data), responseOptions: { headers: { 'Content-Type': 'application/json', ...headers } } };
  }).persist();
  // If a regression follows Location, this successful response would allow the
  // adapter to succeed. Counting this request also detects secret forwarding.
  mock.get('https://redirect.example.test').intercept({ path: /.*/, method: /.*/ }).reply(() => {
    redirectRequests += 1;
    return { statusCode: 200, data: JSON.stringify(claims), responseOptions: { headers: { 'Content-Type': 'application/json' } } };
  }).persist();
  const bundle = await bundlePromise;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-05-15', fetchMock: mock });
  context.after(async () => { await mf.dispose(); await mock.close(); });
  return {
    seen,
    get redirectRequests() { return redirectRequests; },
    async invoke(input) {
      const response = await mf.dispatchFetch('https://worker-regression.test/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

const verifyInput = () => ({ kind: 'verify', idToken: TOKEN, channelId: CHANNEL });
const pushInput = () => ({ kind: 'push', accessToken: ACCESS_TOKEN, userId: USER,
  messages: [{ type: 'text', text: 'Synthetic worker test notice' }], retryKey: RETRY_KEY });

test('actual Worker default fetch verifies LINE form POST and returns only trusted identity', async (context) => {
  const runtime = await fixture(context, { path: '/oauth2/v2.1/verify', data: claims });
  assert.deepEqual(await runtime.invoke(verifyInput()), { ok: true,
    result: { userId: USER, channelId: CHANNEL, expiresAt: claims.exp } });
  assert.equal(runtime.seen.length, 1);
  const request = runtime.seen[0];
  assert.equal(request.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.body)), { id_token: TOKEN, client_id: CHANNEL });
  assert.equal(runtime.redirectRequests, 0);
});

test('actual Worker refuses ID token verification redirects without following or forwarding the token', async (context) => {
  const runtime = await fixture(context, { path: '/oauth2/v2.1/verify', status: 307,
    headers: { Location: 'https://redirect.example.test/collect' } });
  const result = await runtime.invoke(verifyInput());
  assert.equal(runtime.seen.length, 1, 'The request must reach the LINE mock; a runtime option TypeError is not an acceptable rejection');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LINE_TOKEN_REJECTED');
  assert.equal(runtime.redirectRequests, 0);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('actual Worker default fetch pushes a bounded notice with its stable retry key', async (context) => {
  const runtime = await fixture(context, { path: '/v2/bot/message/push', data: {} });
  const input = pushInput();
  assert.deepEqual(await runtime.invoke(input), { ok: true, result: { accepted: true, duplicate: false, status: 200 } });
  assert.equal(runtime.seen.length, 1);
  const request = runtime.seen[0];
  assert.equal(request.headers.get('authorization'), `Bearer ${ACCESS_TOKEN}`);
  assert.equal(request.headers.get('x-line-retry-key'), RETRY_KEY);
  assert.deepEqual(JSON.parse(await request.body), { to: USER, messages: input.messages });
  assert.equal(runtime.redirectRequests, 0);
});

test('actual Worker refuses push redirects without forwarding credentials or messages', async (context) => {
  const runtime = await fixture(context, { path: '/v2/bot/message/push', status: 307,
    headers: { Location: 'https://redirect.example.test/collect' } });
  const result = await runtime.invoke(pushInput());
  assert.equal(runtime.seen.length, 1, 'The request must reach the LINE mock; a runtime option TypeError is not an acceptable rejection');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LINE_PUSH_REJECTED');
  assert.equal(runtime.redirectRequests, 0);
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
});
