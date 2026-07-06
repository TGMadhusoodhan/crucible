CREATE TABLE `api_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`is_valid` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_credentials_provider_unique` ON `api_credentials` (`provider`);--> statement-breakpoint
CREATE TABLE `budget_spend` (
	`provider` text NOT NULL,
	`year_month` text NOT NULL,
	`spend_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`provider`, `year_month`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`r1_provider` text NOT NULL,
	`r1_model_id` text NOT NULL,
	`r2_provider` text NOT NULL,
	`r2_model_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_caps` (
	`provider` text PRIMARY KEY NOT NULL,
	`cap_usd` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_costs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL
);
