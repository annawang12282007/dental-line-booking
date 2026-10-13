import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createD1InboxRepository } from '../server/line-inbox.mjs';

const SECRET = 'test-only-inbox-key-012345678901234567890';
const SCHEMA = `CREATE TABLE line_inbox (
  connection_key TEXT NOT NULL, event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL, event_timestamp INTEGER, source_hash TEXT,
  is_redelivery INTEGER NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_key, event_id)
)`;

// Execute the same prepared SQL and bindings as D1 against real SQLite. A D1
// batch is transactional; explicitly reproduce that contract in this adapter.
function adapter(sqlite, { failAt = -1 } = {}) {
  return {
    batches: 0,
    prepare(sql) { return { bind(...bindings) { return { sql, bindings }; } }; },
    async batch(statements) {
      this.batches += 1;
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(({ sql, bindings }, index) => {
          if (index === failAt) throw new Error('Simulated database failure');
          const result = sqlite.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: Number(result.changes) } };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function fixture(t, options) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  t.after(() => sqlite.close());
  const db = adapter(sqlite, options);
  return { sqlite, db, repository: createD1InboxRepository(db, { hashSecret: SECRET }) };
}

function input(events, overrides = {}) {
  return { connectionKey: 'line-test', tenantId: 'tenant-test', providerId: 'provider-test',
    destination: 'bot-not-retained', events, ...overrides };
}

function event(overrides = {}) {
  return { webhookEventId: 'event-1', type: 'message', timestamp: 1700000000000,
    source: { type: 'user', userId: 'U0123456789abcdef0123456789abcdef' },
    isRedelivery: false, ...overrides };
}

test('persists only the allowlisted receipt and namespaces an HMAC of source identifiers', async (t) => {
  const { sqlite, repository } = fixture(t);
  const payload = event({ message: { text: 'sensitive-message', id: 'message-123' },
    replyToken: 'sensitive-reply-token', rawBody: 'sensitive-raw-body' });
  const before = Date.now();
  assert.deepEqual(await repository.acceptWebhookEvents(input([payload], { rawBody: 'sensitive-envelope' })), { accepted: 1 });
  const row = sqlite.prepare('SELECT * FROM line_inbox').get();
  assert.equal(row.event_id, 'event-1');
  assert.equal(row.event_timestamp, 1700000000000);
  assert.equal(row.is_redelivery, 0);
  assert.ok(row.received_at >= before && row.received_at <= Date.now());
  const expected = createHmac('sha256', SECRET).update(JSON.stringify([
    'line-source-v1', 'line-test', 'tenant-test', 'provider-test', 'user', payload.source.userId, null, null,
  ])).digest('hex');
  assert.equal(row.source_hash, expected);
  const stored = JSON.stringify(row);
  for (const secret of ['sensitive', payload.source.userId, 'bot-not-retained', 'message-123']) {
    assert.equal(stored.includes(secret), false);
  }
  assert.deepEqual(Object.keys(row).sort(), ['connection_key', 'event_id', 'tenant_id', 'provider_id',
    'event_type', 'event_timestamp', 'source_hash', 'is_redelivery', 'received_at'].sort());
});

test('deduplicates within a batch and on redelivery, preserving the first receipt', async (t) => {
  const { sqlite, db, repository } = fixture(t);
  await repository.acceptWebhookEvents(input([event(), event()]));
  const first = sqlite.prepare('SELECT * FROM line_inbox').get();
  await repository.acceptWebhookEvents(input([event({ isRedelivery: true, type: 'follow' })]));
  assert.equal(db.batches, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_inbox').get().count, 1);
  assert.deepEqual(sqlite.prepare('SELECT * FROM line_inbox').get(), first);
});

test('survives database close/reopen and still deduplicates through a fresh repository', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'line-inbox-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'receipts.sqlite');
  let sqlite = new DatabaseSync(filename);
  sqlite.exec(SCHEMA);
  try { await createD1InboxRepository(adapter(sqlite), { hashSecret: SECRET }).acceptWebhookEvents(input([event()])); }
  finally { sqlite.close(); }
  sqlite = new DatabaseSync(filename);
  try {
    await createD1InboxRepository(adapter(sqlite), { hashSecret: SECRET }).acceptWebhookEvents(input([event({ isRedelivery: true })]));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_inbox').get().count, 1);
  } finally { sqlite.close(); }
});

test('scopes duplicate ids and source hashes to a connection', async (t) => {
  const { sqlite, repository } = fixture(t);
  await repository.acceptWebhookEvents(input([event()]));
  await repository.acceptWebhookEvents(input([event()], { connectionKey: 'second-connection' }));
  const rows = sqlite.prepare('SELECT source_hash FROM line_inbox').all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].source_hash, rows[1].source_hash);
});

test('atomic batch rolls back earlier inserts when a later statement fails', async (t) => {
  const { sqlite, repository } = fixture(t, { failAt: 1 });
  await assert.rejects(repository.acceptWebhookEvents(input([event(), event({ webhookEventId: 'event-2' })])),
    { message: 'INBOX_UNAVAILABLE' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_inbox').get().count, 0);
});

test('rejects unsuccessful D1 responses instead of acknowledging persistence', async () => {
  for (const result of [undefined, [], [{ success: false }]]) {
    const db = { prepare: () => ({ bind: () => ({}) }), batch: async () => result };
    const repository = createD1InboxRepository(db, { hashSecret: SECRET });
    await assert.rejects(repository.acceptWebhookEvents(input([event()])), { message: 'INBOX_UNAVAILABLE' });
  }
});

test('validates the entire batch before touching D1 and treats empty batches as no-ops', async (t) => {
  const { sqlite, db, repository } = fixture(t);
  for (const malformed of [
    event({ webhookEventId: '' }), event({ type: 'message\n' }), event({ timestamp: -1 }),
    event({ timestamp: 1.5 }), event({ isRedelivery: 'true' }),
    event({ source: { type: 'user', userId: 'id\nwith-control' } }),
  ]) {
    await assert.rejects(repository.acceptWebhookEvents(input([event(), malformed])), { message: 'INVALID_INBOX_INPUT' });
  }
  assert.deepEqual(await repository.acceptWebhookEvents(input([])), { accepted: 0 });
  assert.equal(db.batches, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM line_inbox').get().count, 0);
});

test('supports events without optional source/timestamp and hashes group or room identifiers', async (t) => {
  const { sqlite, repository } = fixture(t);
  await repository.acceptWebhookEvents(input([
    { webhookEventId: 'minimal', type: 'follow' },
    event({ webhookEventId: 'group', source: { type: 'group', groupId: 'raw-group-identifier' } }),
    event({ webhookEventId: 'room', source: { type: 'room', roomId: 'raw-room-identifier' } }),
  ]));
  const rows = sqlite.prepare('SELECT * FROM line_inbox ORDER BY event_id').all();
  assert.match(rows[0].source_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[1].source_hash, null);
  assert.equal(rows[1].event_timestamp, null);
  assert.match(rows[2].source_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(rows).includes('raw-group-identifier'), false);
  assert.equal(JSON.stringify(rows).includes('raw-room-identifier'), false);
});

test('requires a durable database and a sufficiently long hashing secret', () => {
  assert.throws(() => createD1InboxRepository(null, { hashSecret: SECRET }), { message: 'DURABLE_D1_REQUIRED' });
  const db = { prepare() {}, batch() {} };
  for (const hashSecret of [undefined, '', 'short']) {
    assert.throws(() => createD1InboxRepository(db, { hashSecret }), { message: 'INBOX_HASH_SECRET_REQUIRED' });
  }
});
