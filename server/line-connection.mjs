const SELECT = `SELECT connection_key, tenant_id, provider_id, bot_user_id
  FROM line_connections WHERE connection_key = ?`;
const INSERT = `INSERT OR IGNORE INTO line_connections
  (connection_key, tenant_id, provider_id, bot_user_id) VALUES (?, ?, ?, ?)`;
const identifier = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const destinationId = (value) => typeof value === 'string' && /^U[0-9a-f]{32}$/.test(value);

function contextOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.connectionKey !== 'string' || !/^[-a-zA-Z0-9_]{1,100}$/.test(input.connectionKey) ||
      !identifier(input.tenantId) || !identifier(input.providerId)) {
    throw new TypeError('INVALID_CONNECTION_INPUT');
  }
  return [input.connectionKey, input.tenantId, input.providerId];
}

function matches(row, context) {
  return row && row.connection_key === context[0] && row.tenant_id === context[1] &&
    row.provider_id === context[2] && destinationId(row.bot_user_id);
}

/**
 * The caller must verify the channel signature over the original bytes and only
 * call bindVerifiedDestination for an explicitly enabled empty Verify request.
 * It cannot update or transfer an existing connection. The database never stores
 * access tokens, channel secrets, patient identifiers, or message contents.
 */
export function createD1ConnectionRepository(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new TypeError('DURABLE_D1_REQUIRED');
  }
  return {
    async resolveDestination(input) {
      const context = contextOf(input);
      let row;
      try { row = await db.prepare(SELECT).bind(context[0]).first(); }
      catch { throw new Error('CONNECTION_STORAGE_UNAVAILABLE'); }
      if (row === null) return null;
      if (!matches(row, context)) throw new Error('LINE_CONNECTION_MISMATCH');
      return row.bot_user_id;
    },
    async bindVerifiedDestination(input) {
      const context = contextOf(input);
      if (!destinationId(input.destination)) throw new TypeError('INVALID_CONNECTION_INPUT');
      const destination = input.destination;
      let row;
      try {
        const results = await db.batch([
          db.prepare(INSERT).bind(...context, destination),
          db.prepare(SELECT).bind(context[0]),
        ]);
        if (!Array.isArray(results) || results.length !== 2 || results.some((result) => result?.success !== true) ||
            !Array.isArray(results[1].results) || results[1].results.length !== 1) throw new Error('BIND_NOT_DURABLE');
        [row] = results[1].results;
      } catch { throw new Error('CONNECTION_STORAGE_UNAVAILABLE'); }
      if (!matches(row, context) || row.bot_user_id !== destination) throw new Error('LINE_CONNECTION_MISMATCH');
      return { botUserId: row.bot_user_id };
    },
  };
}
