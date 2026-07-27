CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_key` text NOT NULL,
	`last_seen` integer NOT NULL,
	`reported_rtt_ms` integer DEFAULT 0 NOT NULL,
	`playback_delay_ms` integer DEFAULT 30 NOT NULL,
	`position` integer,
	`user_agent` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_client_key_unique` ON `devices` (`client_key`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`command` text DEFAULT 'idle' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`target_at` integer,
	`video_url` text,
	`media_time` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
