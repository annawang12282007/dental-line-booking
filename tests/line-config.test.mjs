import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingBrand, publicLineConfiguration } from '../lib/booking-brand.mjs';

const configured = {
  LINE_LIFF_ID: '1234567890-synthetic',
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  PUBLIC_ORIGIN: 'https://booking.example.test',
};

test('the public configuration never exposes server secrets or admin identity', () => {
  const response = publicLineConfiguration({
    ...configured,
    LINE_CHANNEL_SECRET: 'synthetic-private-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-private-token',
    BOOKING_SECURITY_KEY: 'synthetic-private-key',
    BOOKING_ADMIN_LINE_ID: `U${'a'.repeat(32)}`,
  });
  assert.deepEqual(response, {
    configured: true,
    liffId: configured.LINE_LIFF_ID,
    accountId: bookingBrand.lineAccountId,
  });
});

test('missing any login prerequisite fails closed and hides the LIFF identifier', () => {
  for (const key of Object.keys(configured)) {
    assert.deepEqual(publicLineConfiguration({ ...configured, [key]: '' }), {
      configured: false,
      liffId: null,
      accountId: bookingBrand.lineAccountId,
    });
  }
  assert.equal(publicLineConfiguration().configured, false);
});

test('public account branding is display data and is not a login prerequisite', () => {
  // Operators can leave the public account label empty while configuring their
  // own credentials. Authentication still requires every server-side check.
  assert.equal(typeof bookingBrand.lineAccountId, 'string');
  assert.equal(typeof bookingBrand.lineAccountName, 'string');
  assert.equal(publicLineConfiguration(configured).configured, true);
});
