ALTER TABLE `sync_state` ADD `preload_video_url` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `preload_version` integer DEFAULT 0 NOT NULL;