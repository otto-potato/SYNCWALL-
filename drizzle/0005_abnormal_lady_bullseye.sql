CREATE TABLE `device_images` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`image_url` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `volume_percent` integer DEFAULT 100 NOT NULL;