declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LINE_CONNECTION_KEY?: string;
    LINE_PROVIDER_ID?: string;
    LINE_BOT_USER_ID?: string;
    LINE_CHANNEL_SECRET?: string;
    LINE_LOGIN_CHANNEL_ID?: string;
    LINE_LIFF_ID?: string;
    LINE_INBOX_HASH_SECRET?: string;
    LINE_WEBHOOK_ENABLED?: string;
    PUBLIC_ORIGIN?: string;
    BOOKING_SECURITY_KEY?: string;
    BOOKING_ADMIN_LINE_ID?: string;
    LINE_CHANNEL_ACCESS_TOKEN?: string;
  }
}
