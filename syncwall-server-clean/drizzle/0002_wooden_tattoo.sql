CREATE TABLE `device_dings` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`target_at` integer,
	`updated_at` integer NOT NULL
);
