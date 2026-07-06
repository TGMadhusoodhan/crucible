CREATE TABLE `pipeline_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`phase` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
