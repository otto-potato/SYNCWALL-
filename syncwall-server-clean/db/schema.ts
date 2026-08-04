import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable(
  "devices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientKey: text("client_key").notNull().unique(),
    lastSeen: integer("last_seen").notNull(),
    reportedRttMs: integer("reported_rtt_ms").notNull().default(0),
    playbackDelayMs: integer("playback_delay_ms").notNull().default(30),
    clockAdjustmentMs: integer("clock_adjustment_ms").notNull().default(0),
    displayedClockAt: integer("displayed_clock_at"),
    calibrationReportVersion: integer("calibration_report_version")
      .notNull()
      .default(0),
    calibrationReportedClockAt: integer("calibration_reported_clock_at"),
    calibrationDispatchedAt: integer("calibration_dispatched_at"),
    calibrationCommandReceivedAt: integer(
      "calibration_command_received_at",
    ),
    calibrationReportReceivedAt: integer("calibration_report_received_at"),
    calibrationRoundTripMs: integer("calibration_round_trip_ms")
      .notNull()
      .default(0),
    calibrationOneWayMs: integer("calibration_one_way_ms")
      .notNull()
      .default(0),
    calibrationCorrectionMs: integer("calibration_correction_ms")
      .notNull()
      .default(0),
    volumePercent: integer("volume_percent").notNull().default(100),
    position: integer("position"),
    userAgent: text("user_agent").notNull().default(""),
  },
  (table) => [index("devices_last_seen_idx").on(table.lastSeen)],
);

export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey(),
  command: text("command").notNull().default("idle"),
  version: integer("version").notNull().default(0),
  targetAt: integer("target_at"),
  videoUrl: text("video_url"),
  mediaTime: integer("media_time").notNull().default(0),
  timecodeRate: text("timecode_rate").notNull().default("25"),
  progress: integer("progress").notNull().default(0),
  statusMessage: text("status_message").notNull().default(""),
  preloadVideoUrl: text("preload_video_url"),
  preloadVersion: integer("preload_version").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const calibrationState = sqliteTable("calibration_state", {
  id: integer("id").primaryKey(),
  mode: text("mode").notNull().default("off"),
  version: integer("version").notNull().default(0),
  targetAt: integer("target_at"),
  commandSentAt: integer("command_sent_at"),
  targetDeviceId: integer("target_device_id"),
  freezeImmediately: integer("freeze_immediately", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: integer("updated_at").notNull(),
});

export const deviceDings = sqliteTable("device_dings", {
  deviceId: integer("device_id").primaryKey(),
  version: integer("version").notNull().default(0),
  targetAt: integer("target_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const deviceImages = sqliteTable("device_images", {
  deviceId: integer("device_id").primaryKey(),
  imageUrl: text("image_url").notNull().default(""),
  version: integer("version").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const deviceMedia = sqliteTable("device_media", {
  deviceId: integer("device_id").primaryKey(),
  videoUrl: text("video_url").notNull().default(""),
  mediaStatus: text("media_status").notNull().default("waiting"),
  mediaProgress: integer("media_progress").notNull().default(0),
  mediaError: text("media_error").notNull().default(""),
  appliedSyncVersion: integer("applied_sync_version").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
