ALTER TABLE `api_credentials` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `github_repo` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `github_push_mode` text DEFAULT 'off';--> statement-breakpoint
ALTER TABLE `projects` ADD `github_branch` text DEFAULT 'main';
