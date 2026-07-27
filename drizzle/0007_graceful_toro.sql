CREATE TABLE `calibration_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'off' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`target_at` integer,
	`command_sent_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `clock_adjustment_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `displayed_clock_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_report_version` integer DEFAULT 0 NOT NULL;