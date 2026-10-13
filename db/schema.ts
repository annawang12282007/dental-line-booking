import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Receipt audit only: no message contents, reply tokens, raw LINE identifiers,
// or automatic notification processing. Duplicates retain the first receipt.
export const lineInbox = sqliteTable("line_inbox", {
  connectionKey: text("connection_key").notNull(),
  eventId: text("event_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  providerId: text("provider_id").notNull(),
  eventType: text("event_type").notNull(),
  eventTimestamp: integer("event_timestamp"),
  sourceHash: text("source_hash"),
  isRedelivery: integer("is_redelivery", { mode: "boolean" }).notNull(),
  receivedAt: integer("received_at").notNull(),
}, (table) => [primaryKey({ columns: [table.connectionKey, table.eventId] })]);

// A verified channel destination is immutable. Binding a key to another tenant,
// provider, or bot requires an explicit new connection, never an implicit update.
export const lineConnections = sqliteTable("line_connections", {
  connectionKey: text("connection_key").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  providerId: text("provider_id").notNull(),
  botUserId: text("bot_user_id").notNull(),
});

// Demo-only scheduling records. Seeding is an explicit administrator action;
// migrations create empty tables and never insert clinic or patient data.
export const bookingClinics = sqliteTable("booking_clinics", {
  id: text("id").primaryKey(), name: text("name").notNull(),
  timeZone: text("time_zone").notNull(), demo: integer("demo").notNull(),
});
export const bookingDoctors = sqliteTable("booking_doctors", {
  id: text("id").primaryKey(), clinicId: text("clinic_id").notNull().references(() => bookingClinics.id),
  name: text("name").notNull(),
}, (t) => [index("booking_doctor_clinic").on(t.clinicId)]);
export const bookingSlots = sqliteTable("booking_slots", {
  id: text("id").primaryKey(), clinicId: text("clinic_id").notNull().references(() => bookingClinics.id),
  doctorId: text("doctor_id").notNull().references(() => bookingDoctors.id),
  startAt: integer("start_at").notNull(), endAt: integer("end_at").notNull(),
}, (t) => [uniqueIndex("booking_doctor_time").on(t.doctorId, t.startAt), index("booking_slot_lookup").on(t.clinicId,t.doctorId,t.startAt)]);
export const bookingAppointments = sqliteTable("booking_appointments", {
  id: text("id").primaryKey(), clinicId: text("clinic_id").notNull().references(() => bookingClinics.id),
  slotId: text("slot_id").notNull().references(() => bookingSlots.id), patientKey: text("patient_key").notNull(),
  lineCipher: text("line_cipher").notNull(), name: text("name").notNull(), phone: text("phone").notNull(),
  status: text("status").notNull(), revision: integer("revision").notNull(),
  notificationConsent: integer("notification_consent").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), payloadHash: text("payload_hash").notNull(),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
  lastActionId: text("last_action_id").notNull(),
}, (t) => [
  uniqueIndex("booking_one_active_slot").on(t.slotId).where(sql`${t.status} IN ('pending', 'confirmed')`),
  uniqueIndex("booking_patient_idempotency").on(t.patientKey,t.idempotencyKey),
  index("booking_patient_lookup").on(t.patientKey,t.createdAt),
  index("booking_clinic_lookup").on(t.clinicId,t.createdAt),
]);
export const bookingAudits = sqliteTable("booking_audits", {
  id: text("id").primaryKey(), appointmentId: text("appointment_id").notNull().references(() => bookingAppointments.id),
  clinicId: text("clinic_id").notNull(), actorKey: text("actor_key").notNull(),
  status: text("status").notNull(), revision: integer("revision").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("booking_audit_revision").on(t.appointmentId,t.revision)]);
export const bookingOutbox = sqliteTable("booking_outbox", {
  id: text("id").primaryKey(), appointmentId: text("appointment_id").notNull().references(() => bookingAppointments.id),
  appointmentRevision: integer("appointment_revision").notNull(), kind: text("kind").notNull(),
  retryKey: text("retry_key").notNull(), payload: text("payload").notNull(), lineCipher: text("line_cipher").notNull(),
  status: text("status").notNull(), attempts: integer("attempts").notNull(), nextAttemptAt: integer("next_attempt_at").notNull(),
  claimToken: text("claim_token"), claimedUntil: integer("claimed_until"), createdAt: integer("created_at").notNull(),
  acceptedAt: integer("accepted_at"), lastCode: text("last_code"),
}, (t) => [uniqueIndex("booking_outbox_revision").on(t.appointmentId,t.appointmentRevision,t.kind),index("booking_outbox_due").on(t.status,t.nextAttemptAt)]);
export const bookingSessions = sqliteTable("booking_sessions", {
  tokenHash: text("token_hash").primaryKey(), patientKey: text("patient_key").notNull(),
  lineCipher: text("line_cipher").notNull(), expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [index("booking_session_expiry").on(t.expiresAt)]);
export const bookingRateLimits = sqliteTable("booking_rate_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("booking_rate_limit_expiry").on(t.expiresAt)]);
