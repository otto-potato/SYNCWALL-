CREATE TABLE `device_media` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`video_url` text DEFAULT '' NOT NULL,
	`media_status` text DEFAULT 'waiting' NOT NULL,
	`media_error` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
