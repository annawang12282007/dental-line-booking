const encoder = new TextEncoder();
const INSERT = `INSERT OR IGNORE INTO line_inbox
  (connection_key, event_id, tenant_id, provider_id, event_type,
   event_timestamp, source_hash, is_redelivery, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, maximum = 128) => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function invalid() { return new TypeError('INVALID_INBOX_INPUT'); }

function sanitizeEvent(event) {
  if (!object(event) || !identifier(event.webhookEventId) ||
      typeof event.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event.type)) throw invalid();
  if (own(event, 'timestamp') && (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0)) throw invalid();
  if (own(event, 'isRedelivery') && typeof event.isRedelivery !== 'boolean') throw invalid();
  let source = null;
  if (own(event, 'source')) {
    if (!object(event.source) || !['user', 'group', 'room'].includes(event.source.type)) throw invalid();
    const identifiers = ['userId', 'groupId', 'roomId'].map((key) => {
      if (!own(event.source, key)) return null;
      if (!identifier(event.source[key])) throw invalid();
      return event.source[key];
    });
    if (identifiers.some((value) => value !== null)) source = [event.source.type, ...identifiers];
  }
  return {
    id: event.webhookEventId,
    type: event.type,
    timestamp: event.timestamp ?? null,
    source,
    isRedelivery: event.isRedelivery === true ? 1 : 0,
  };
}

/**
 * Call only after verifying the original webhook bytes and expected destination.
 * D1 batch commits the entire receipt batch atomically. Its composite primary key
 * makes redelivery idempotent, including across Worker instances and restarts.
 * These rows record accepted receipts only; they never trigger outbound messages.
 * Keep hashSecret separate from the LINE channel secret and out of source control.
 */
export function createD1InboxRepository(db, { hashSecret } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new TypeError('DURABLE_D1_REQUIRED');
  }
  if (typeof hashSecret !== 'string' || hashSecret.length < 32 || hashSecret.length > 4096) {
    throw new TypeError('INBOX_HASH_SECRET_REQUIRED');
  }
  let keyPromise;
  async function hashSource(context, source) {
    if (source === null) return null;
    keyPromise ??= crypto.subtle.importKey('raw', encoder.encode(hashSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', await keyPromise,
      encoder.encode(JSON.stringify(['line-source-v1', ...context, ...source])));
    return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return {
    async acceptWebhookEvents(input) {
      if (!object(input) || typeof input.connectionKey !== 'string' ||
          !/^[-a-zA-Z0-9_]{1,100}$/.test(input.connectionKey) ||
          !identifier(input.tenantId) || !identifier(input.providerId) ||
          !Array.isArray(input.events) || input.events.length > 1000) throw invalid();
      // Materialize only allowlisted fields before any database operation.
      const context = [input.connectionKey, input.tenantId, input.providerId];
      const events = input.events.map(sanitizeEvent);
      if (events.length === 0) return { accepted: 0 };
      const receivedAt = Date.now();
      const hashes = await Promise.all(events.map((event) => hashSource(context, event.source)));
      try {
        const statements = events.map((event, index) => db.prepare(INSERT).bind(
          context[0], event.id, context[1], context[2], event.type, event.timestamp,
          hashes[index], event.isRedelivery, receivedAt,
        ));
        const results = await db.batch(statements);
        if (!Array.isArray(results) || results.length !== statements.length ||
            results.some((result) => result?.success !== true)) throw new Error('BATCH_FAILED');
      } catch {
        // Never propagate provider diagnostics containing SQL parameters.
        throw new Error('INBOX_UNAVAILABLE');
      }
      return { accepted: events.length };
    },
  };
}
