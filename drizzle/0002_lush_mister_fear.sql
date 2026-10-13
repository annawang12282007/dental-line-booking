CREATE TABLE `booking_appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`clinic_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`patient_key` text NOT NULL,
	`line_cipher` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`notification_consent` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_action_id` text NOT NULL,
	FOREIGN KEY (`clinic_id`) REFERENCES `booking_clinics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `booking_slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_one_active_slot` ON `booking_appointments` (`slot_id`) WHERE "booking_appointments"."status" IN ('pending', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX `booking_patient_idempotency` ON `booking_appointments` (`patient_key`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `booking_patient_lookup` ON `booking_appointments` (`patient_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `booking_clinic_lookup` ON `booking_appointments` (`clinic_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `booking_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`clinic_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `booking_appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_audit_revision` ON `booking_audits` (`appointment_id`,`revision`);--> statement-breakpoint
CREATE TABLE `booking_clinics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`time_zone` text NOT NULL,
	`demo` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_doctors` (
	`id` text PRIMARY KEY NOT NULL,
	`clinic_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`clinic_id`) REFERENCES `booking_clinics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_doctor_clinic` ON `booking_doctors` (`clinic_id`);--> statement-breakpoint
CREATE TABLE `booking_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`appointment_revision` integer NOT NULL,
	`kind` text NOT NULL,
	`retry_key` text NOT NULL,
	`payload` text NOT NULL,
	`line_cipher` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claim_token` text,
	`claimed_until` integer,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`last_code` text,
	FOREIGN KEY (`appointment_id`) REFERENCES `booking_appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_outbox_revision` ON `booking_outbox` (`appointment_id`,`appointment_revision`,`kind`);--> statement-breakpoint
CREATE INDEX `booking_outbox_due` ON `booking_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `booking_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `booking_rate_limit_expiry` ON `booking_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `booking_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`patient_key` text NOT NULL,
	`line_cipher` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `booking_session_expiry` ON `booking_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `booking_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`clinic_id` text NOT NULL,
	`doctor_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	FOREIGN KEY (`clinic_id`) REFERENCES `booking_clinics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`doctor_id`) REFERENCES `booking_doctors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_doctor_time` ON `booking_slots` (`doctor_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `booking_slot_lookup` ON `booking_slots` (`clinic_id`,`doctor_id`,`start_at`);