// Public display settings only. These values are shipped to browsers.
// Set these to your own official account when deploying; never put secrets here.
export const bookingBrand = Object.freeze({
  lineAccountName: '示範預約',
  lineAccountId: '',
});

/** Return only the public settings needed to initialize the LINE client. */
export function publicLineConfiguration(env = {}) {
  const configured = Boolean(env.LINE_LIFF_ID && env.LINE_LOGIN_CHANNEL_ID && env.PUBLIC_ORIGIN);
  return {
    configured,
    liffId: configured ? env.LINE_LIFF_ID : null,
    accountId: bookingBrand.lineAccountId,
  };
}
