CREATE TABLE `line_inbox` (
	`connection_key` text NOT NULL,
	`event_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_timestamp` integer,
	`source_hash` text,
	`is_redelivery` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`connection_key`, `event_id`)
);
