CREATE TABLE `line_connections` (
	`connection_key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`bot_user_id` text NOT NULL
);
