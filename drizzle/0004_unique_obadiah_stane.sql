ALTER TABLE `device_media` ADD `media_progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_media` ADD `applied_sync_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `status_message` text DEFAULT '' NOT NULL;