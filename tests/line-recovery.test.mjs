import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLineFailure, getLineRecoveryAction, performLineRecovery, safeLineDiagnostic } from '../app/line-recovery.mjs';

const identityCodes = ['LINE_TOKEN_REJECTED', 'LINE_INVALID_TOKEN_CLAIMS', 'LOGIN_EXPIRED', 'INVALID_LINE_IDENTITY'];

test('rejected identity requests a fresh explicit browser login or a LINE page reopen', () => {
  for (const code of identityCodes) {
    assert.equal(classifyLineFailure({ status: 401, code, reason: 'EXPIRED', inClient: false }).recovery, 'fresh');
    assert.equal(classifyLineFailure({ status: 401, code, reason: 'EXPIRED', inClient: true }).recovery, 'reopen');
  }
  assert.equal(classifyLineFailure({ status: 400, code: 'LINE_TOKEN_REJECTED', reason: 'INVALID_TOKEN', inClient: false }).recovery, 'fresh');
});

test('audience and issuer errors never request another login', () => {
  for (const reason of ['AUDIENCE_MISMATCH', 'ISSUER_MISMATCH']) {
    for (const inClient of [false, true]) assert.equal(classifyLineFailure({ status: 401, code: 'LINE_TOKEN_REJECTED', reason, inClient }).recovery, 'configuration');
  }
});

test('429, network, timeout, server failure and session problems do not clear LINE login', () => {
  for (const failure of [
    { status: 429, code: 'LINE_TOKEN_REJECTED', reason: 'EXPIRED' },
    { status: 0, code: 'NETWORK_ERROR' },
    { status: 504, code: 'LINE_TIMEOUT' },
    { status: 502, code: 'LINE_TOKEN_REJECTED' },
    { status: 401, code: 'SESSION_UNAVAILABLE' },
    { status: 401, code: 'UNKNOWN_IDENTITY_ERROR' },
  ]) assert.equal(classifyLineFailure({ ...failure, inClient: false }).recovery, 'none');
});

test('only fixed code and reason allowlists reach visible diagnostics', () => {
  assert.deepEqual(safeLineDiagnostic('access_token=secret', 'https://private.example'), { code: 'UNAVAILABLE', reason: '', label: 'UNAVAILABLE' });
  assert.equal(safeLineDiagnostic('LINE_TOKEN_REJECTED', 'EXPIRED').label, 'LINE_TOKEN_REJECTED / EXPIRED');
  assert.equal(safeLineDiagnostic({ token: 'secret' }, ['EXPIRED']).label, 'UNAVAILABLE');
  for (const code of ['RATE_LIMITED', 'BOOKING_NOT_CONFIGURED', 'STORAGE_UNAVAILABLE', 'BOOKING_STORAGE_UNAVAILABLE']) assert.equal(safeLineDiagnostic(code).code, code);
});

test('only a confirmed expiry is described as expired', () => {
  assert.match(classifyLineFailure({ status: 401, code: 'LINE_TOKEN_REJECTED', reason: 'EXPIRED', inClient: false }).message, /已過期/);
  for (const reason of ['OTHER', 'INVALID_TOKEN', undefined]) {
    const failure = classifyLineFailure({ status: 400, code: 'LINE_TOKEN_REJECTED', reason, inClient: false });
    assert.match(failure.message, /登入確認未通過/);
    assert.doesNotMatch(failure.message, /已過期|已失效/);
  }
});

test('recovery action does not redirect a signed-in browser unless reauthentication was requested', () => {
  assert.equal(getLineRecoveryAction({ inClient: false, loggedIn: true, needsFreshLogin: false }), 'verify');
  assert.equal(getLineRecoveryAction({ inClient: false, loggedIn: false, needsFreshLogin: false }), 'login');
  assert.equal(getLineRecoveryAction({ inClient: false, loggedIn: true, needsFreshLogin: true }), 'refresh_login');
});

test('explicit browser reauthentication logs out before login and does not verify the old token', () => {
  const calls = [];
  const liff = { isInClient: () => false, isLoggedIn: () => true, logout: () => calls.push('logout'), login: (options) => calls.push(['login', options.redirectUri]) };
  assert.equal(performLineRecovery(liff, { needsFreshLogin: true, redirectUri: 'https://example.test/' }), 'refresh_login');
  assert.deepEqual(calls, ['logout', ['login', 'https://example.test/']]);
});

test('LINE in-app recovery never calls logout or login, even when logged out', () => {
  for (const loggedIn of [true, false]) for (const needsFreshLogin of [true, false]) {
    const liff = { isInClient: () => true, isLoggedIn: () => loggedIn, logout: () => assert.fail('in-app logout is forbidden'), login: () => assert.fail('in-app login is forbidden') };
    assert.equal(performLineRecovery(liff, { needsFreshLogin, redirectUri: 'https://example.test/' }), !loggedIn || needsFreshLogin ? 'reopen' : 'verify');
  }
});
