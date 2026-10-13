const IDENTITY_CODES = new Set(['LINE_TOKEN_REJECTED', 'LINE_INVALID_TOKEN_CLAIMS', 'LOGIN_EXPIRED', 'INVALID_LINE_IDENTITY']);
const SAFE_CODES = new Set([
  ...IDENTITY_CODES, 'LINE_VERIFICATION_FAILED', 'LINE_TEMPORARILY_UNAVAILABLE',
  'LINE_INVALID_TOKEN_RESPONSE', 'LINE_INVALID_TOKEN_REQUEST', 'LINE_TIMEOUT',
  'LINE_NETWORK_ERROR', 'LINE_NOT_CONFIGURED', 'LINE_VERIFY_ERROR',
  'ORIGIN_REJECTED', 'JSON_REQUIRED', 'INVALID_REQUEST', 'INIT_TIMEOUT',
  'SDK_UNAVAILABLE', 'ID_TOKEN_UNAVAILABLE', 'SESSION_UNAVAILABLE',
  'NETWORK_ERROR', 'LOGIN_REDIRECT_FAILED', 'INIT_UNAVAILABLE', 'UNAVAILABLE',
  'RATE_LIMITED', 'BOOKING_NOT_CONFIGURED', 'STORAGE_UNAVAILABLE', 'BOOKING_STORAGE_UNAVAILABLE',
]);
const SAFE_REASONS = new Set(['EXPIRED', 'AUDIENCE_MISMATCH', 'ISSUER_MISMATCH', 'INVALID_TOKEN', 'OTHER']);

/** @param {unknown} code @param {unknown} [reason] */
export function safeLineDiagnostic(code, reason) {
  const safeCode = typeof code === 'string' && SAFE_CODES.has(code) ? code : 'UNAVAILABLE';
  const safeReason = typeof reason === 'string' && SAFE_REASONS.has(reason) ? reason : '';
  return { code: safeCode, reason: safeReason, label: safeReason ? `${safeCode} / ${safeReason}` : safeCode };
}

/** @param {{status:number,code:unknown,reason?:unknown,inClient:boolean}} failure */
export function classifyLineFailure({ status, code, reason, inClient }) {
  const safe = safeLineDiagnostic(code, reason);
  if (status === 429) return { ...safe, recovery: 'none', message: '剛剛嘗試了幾次，請稍候再進行驗證。' };
  if (safe.reason === 'AUDIENCE_MISMATCH' || safe.reason === 'ISSUER_MISMATCH') {
    return { ...safe, recovery: 'configuration', message: 'LINE 登入設定暫時不一致，重新登入無法解決。請將下方錯誤代碼提供給管理人員。' };
  }
  if (status >= 400 && status < 500 && IDENTITY_CODES.has(safe.code)) {
    const introduction = safe.reason === 'EXPIRED' ? '這次 LINE 登入憑證已過期。' : '這次 LINE 登入確認未通過。';
    return { ...safe, recovery: inClient ? 'reopen' : 'fresh', message: inClient
      ? `${introduction}請先關閉 LINE 裡的這個頁面，再從原本的預約連結重新開啟。`
      : `${introduction}請按「重新登入 LINE」，取得新的登入確認後繼續。` };
  }
  if (safe.code === 'LINE_NOT_CONFIGURED' || safe.code === 'BOOKING_NOT_CONFIGURED' || safe.code === 'ORIGIN_REJECTED') {
    return { ...safe, recovery: 'configuration', message: '預約入口的登入設定暫時未完成。請將下方錯誤代碼提供給管理人員。' };
  }
  return { ...safe, recovery: 'none', message: status >= 500
    ? 'LINE 驗證服務暫時未能完成回應，請稍後重試。'
    : '這次未能完成 LINE 身分驗證，請稍後重試；如仍未成功，請提供下方錯誤代碼。' };
}

/** @param {{inClient:boolean,loggedIn:boolean,needsFreshLogin:boolean}} state */
export function getLineRecoveryAction({ inClient, loggedIn, needsFreshLogin }) {
  if (inClient) return needsFreshLogin || !loggedIn ? 'reopen' : 'verify';
  if (needsFreshLogin) return 'refresh_login';
  return loggedIn ? 'verify' : 'login';
}

/**
 * @param {{isInClient:()=>boolean,isLoggedIn:()=>boolean,logout:()=>void,login:(options:{redirectUri:string})=>void}} liff
 * @param {{needsFreshLogin:boolean,redirectUri:string}} options
 */
export function performLineRecovery(liff, { needsFreshLogin, redirectUri }) {
  const action = getLineRecoveryAction({ inClient: liff.isInClient(), loggedIn: liff.isLoggedIn(), needsFreshLogin });
  if (action === 'refresh_login') liff.logout();
  if (action === 'refresh_login' || action === 'login') liff.login({ redirectUri });
  return action;
}
