ALTER TABLE `calibration_state` ADD `freeze_immediately` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_reported_clock_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_command_received_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_report_received_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_round_trip_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_one_way_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `calibration_correction_ms` integer DEFAULT 0 NOT NULL;