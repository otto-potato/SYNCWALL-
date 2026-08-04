/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { getStableDeviceCode } from "../app/device-code";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type JsonObject = Record<string, unknown>;
type UploadedPart = { partNumber: number; etag: string };
const CALIBRATION_SAFETY_WINDOW_MS = 2000;
const PLAYBACK_TARGET_LEAD_MS = 3000;
const MAX_PLAYBACK_DELAY_MS = 3000;
const TIMECODE_RATE_IDS = new Set([
  "23.976",
  "24",
  "25",
  "29.97-ndf",
  "29.97-df",
  "30",
  "50",
  "59.94-ndf",
  "59.94-df",
  "60",
]);
type VideoMetadata = NonNullable<
  Awaited<ReturnType<R2Bucket["head"]>>
>;

type ActiveDeviceRow = {
  id: number;
  client_key: string;
  last_seen: number;
  reported_rtt_ms: number;
  playback_delay_ms: number;
  clock_adjustment_ms: number;
  displayed_clock_at: number | null;
  calibration_report_version: number;
  calibration_reported_clock_at: number | null;
  calibration_dispatched_at: number | null;
  calibration_command_received_at: number | null;
  calibration_report_received_at: number | null;
  calibration_round_trip_ms: number;
  calibration_one_way_ms: number;
  calibration_correction_ms: number;
  volume_percent: number;
  position: number | null;
  media_status: string | null;
  media_progress: number | null;
  media_error: string | null;
  media_video_url: string | null;
  applied_sync_version: number | null;
  image_url: string | null;
  image_version: number | null;
};

let schemaReady: Promise<void> | null = null;
const videoMetadataCache = new Map<string, VideoMetadata>();

function rememberVideoMetadata(metadata: VideoMetadata) {
  if (videoMetadataCache.size >= 32) {
    const oldestKey = videoMetadataCache.keys().next().value;
    if (oldestKey) videoMetadataCache.delete(oldestKey);
  }
  videoMetadataCache.set(metadata.key, metadata);
}

function safeVideoName(rawName: string) {
  let fileName = rawName;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = "video.mp4";
  }
  const safeName =
    fileName
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "video.mp4";
  return { fileName, safeName };
}

function ensureSchema(env: Env) {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_key TEXT NOT NULL UNIQUE,
        last_seen INTEGER NOT NULL,
        reported_rtt_ms INTEGER NOT NULL DEFAULT 0,
        playback_delay_ms INTEGER NOT NULL DEFAULT 30,
        clock_adjustment_ms INTEGER NOT NULL DEFAULT 0,
        displayed_clock_at INTEGER,
        calibration_report_version INTEGER NOT NULL DEFAULT 0,
        calibration_reported_clock_at INTEGER,
        calibration_dispatched_at INTEGER,
        calibration_command_received_at INTEGER,
        calibration_report_received_at INTEGER,
        calibration_round_trip_ms INTEGER NOT NULL DEFAULT 0,
        calibration_one_way_ms INTEGER NOT NULL DEFAULT 0,
        calibration_correction_ms INTEGER NOT NULL DEFAULT 0,
        volume_percent INTEGER NOT NULL DEFAULT 100,
        position INTEGER,
        user_agent TEXT NOT NULL DEFAULT ''
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY,
        command TEXT NOT NULL DEFAULT 'idle',
        version INTEGER NOT NULL DEFAULT 0,
        target_at INTEGER,
        video_url TEXT,
        media_time INTEGER NOT NULL DEFAULT 0,
        timecode_rate TEXT NOT NULL DEFAULT '25',
        progress INTEGER NOT NULL DEFAULT 0,
        status_message TEXT NOT NULL DEFAULT '',
        preload_video_url TEXT,
        preload_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen)",
    ),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS calibration_state (
        id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'off',
        version INTEGER NOT NULL DEFAULT 0,
        target_at INTEGER,
        command_sent_at INTEGER,
        target_device_id INTEGER,
        freeze_immediately INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS device_dings (
        device_id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0,
        target_at INTEGER,
        updated_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS device_images (
        device_id INTEGER PRIMARY KEY,
        image_url TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS device_media (
        device_id INTEGER PRIMARY KEY,
        video_url TEXT NOT NULL DEFAULT '',
        media_status TEXT NOT NULL DEFAULT 'waiting',
        media_progress INTEGER NOT NULL DEFAULT 0,
        media_error TEXT NOT NULL DEFAULT '',
        applied_sync_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `),
  ]).then(async () => {
    await Promise.all([
      env.DB.prepare(
        "ALTER TABLE sync_state ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE sync_state ADD COLUMN status_message TEXT NOT NULL DEFAULT ''",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE sync_state ADD COLUMN timecode_rate TEXT NOT NULL DEFAULT '25'",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE sync_state ADD COLUMN preload_video_url TEXT",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE sync_state ADD COLUMN preload_version INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE device_media ADD COLUMN media_progress INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE device_media ADD COLUMN applied_sync_version INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN volume_percent INTEGER NOT NULL DEFAULT 100",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN clock_adjustment_ms INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN displayed_clock_at INTEGER",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_report_version INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_reported_clock_at INTEGER",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_dispatched_at INTEGER",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_command_received_at INTEGER",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_report_received_at INTEGER",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_round_trip_ms INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_one_way_ms INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE devices ADD COLUMN calibration_correction_ms INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE calibration_state ADD COLUMN freeze_immediately INTEGER NOT NULL DEFAULT 0",
      ).run().catch(() => undefined),
      env.DB.prepare(
        "ALTER TABLE calibration_state ADD COLUMN target_device_id INTEGER",
      ).run().catch(() => undefined),
    ]);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sync_state (id, command, version, updated_at) VALUES (1, 'idle', 0, ?)",
    )
      .bind(Date.now())
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO calibration_state (id, mode, version, updated_at) VALUES (1, 'off', 0, ?)",
    )
      .bind(Date.now())
      .run();
  });
  return schemaReady;
}

async function readDeviceDing(env: Env, deviceId: number) {
  const row = await env.DB.prepare(
    "SELECT version, target_at FROM device_dings WHERE device_id = ?",
  )
    .bind(deviceId)
    .first<{ version: number; target_at: number | null }>();
  return {
    version: row?.version ?? 0,
    targetAt: row?.target_at ?? null,
  };
}

async function readDeviceImage(env: Env, deviceId: number) {
  const row = await env.DB.prepare(
    "SELECT image_url, version FROM device_images WHERE device_id = ?",
  )
    .bind(deviceId)
    .first<{ image_url: string; version: number }>();
  return {
    url: row?.image_url ?? "",
    version: row?.version ?? 0,
  };
}

async function readSyncState(env: Env) {
  const row = await env.DB.prepare(
    "SELECT command, version, target_at, video_url, media_time, timecode_rate, progress, status_message, preload_video_url, preload_version, updated_at FROM sync_state WHERE id = 1",
  ).first<{
    command: string;
    version: number;
    target_at: number | null;
    video_url: string | null;
    media_time: number;
    timecode_rate: string;
    progress: number;
    status_message: string;
    preload_video_url: string | null;
    preload_version: number;
    updated_at: number;
  }>();
  return {
    command: row?.command ?? "idle",
    version: row?.version ?? 0,
    targetAt: row?.target_at ?? null,
    videoUrl: row?.video_url ?? null,
    mediaTime: row?.media_time ?? 0,
    timecodeRate: row?.timecode_rate ?? "25",
    progress: row?.progress ?? 0,
    message: row?.status_message ?? "",
    preloadUrl: row?.preload_video_url ?? null,
    preloadVersion: row?.preload_version ?? 0,
    updatedAt: row?.updated_at ?? Date.now(),
  };
}

async function readCalibrationState(env: Env) {
  const row = await env.DB.prepare(
    "SELECT mode, version, target_at, command_sent_at, target_device_id, freeze_immediately, updated_at FROM calibration_state WHERE id = 1",
  ).first<{
    mode: string;
    version: number;
    target_at: number | null;
    command_sent_at: number | null;
    target_device_id: number | null;
    freeze_immediately: number;
    updated_at: number;
  }>();
  return {
    mode: row?.mode ?? "off",
    version: row?.version ?? 0,
    targetAt: row?.target_at ?? null,
    commandSentAt: row?.command_sent_at ?? null,
    targetDeviceId: row?.target_device_id ?? null,
    freezeImmediately: Boolean(row?.freeze_immediately),
    updatedAt: row?.updated_at ?? Date.now(),
  };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping" && request.method === "GET") {
      return Response.json(
        { serverTime: Date.now() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/api/devices/heartbeat" && request.method === "POST") {
      await ensureSchema(env);
      const body = (await request.json()) as JsonObject;
      const clientKey =
        typeof body.clientKey === "string" ? body.clientKey.slice(0, 100) : "";
      if (!clientKey) {
        return Response.json({ error: "missing client key" }, { status: 400 });
      }
      const reportedRttMs = Math.max(
        0,
        Math.min(5000, Math.round(Number(body.reportedRttMs) || 0)),
      );
      const rawPlaybackDelay = Number(body.playbackDelayMs);
      const playbackDelayMs = Math.max(
        -MAX_PLAYBACK_DELAY_MS,
        Math.min(
          MAX_PLAYBACK_DELAY_MS,
          Number.isFinite(rawPlaybackDelay)
            ? Math.round(rawPlaybackDelay)
            : 30,
        ),
      );
      const now = Date.now();
      await env.DB.prepare(`
        INSERT INTO devices (
          client_key, last_seen, reported_rtt_ms, playback_delay_ms, position, user_agent
        ) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM devices), ?)
        ON CONFLICT(client_key) DO UPDATE SET
          last_seen = excluded.last_seen,
          reported_rtt_ms = excluded.reported_rtt_ms,
          user_agent = excluded.user_agent
      `)
        .bind(
          clientKey,
          now,
          reportedRttMs,
          playbackDelayMs,
          request.headers.get("user-agent")?.slice(0, 220) ?? "",
        )
        .run();
      const device = await env.DB.prepare(
        "SELECT id, playback_delay_ms, clock_adjustment_ms, volume_percent, position FROM devices WHERE client_key = ?",
      )
        .bind(clientKey)
        .first<{
          id: number;
          playback_delay_ms: number;
          clock_adjustment_ms: number;
          volume_percent: number;
          position: number | null;
        }>();
      const storedPlaybackDelay = device?.playback_delay_ms ?? playbackDelayMs;
      const safePlaybackDelay = Math.max(
        -MAX_PLAYBACK_DELAY_MS,
        Math.min(
          MAX_PLAYBACK_DELAY_MS,
          storedPlaybackDelay,
        ),
      );
      if (device?.id && safePlaybackDelay !== storedPlaybackDelay) {
        await env.DB.prepare(
          "UPDATE devices SET playback_delay_ms = ? WHERE id = ?",
        )
          .bind(safePlaybackDelay, device.id)
          .run();
      }
      const allowedMediaStatuses = new Set([
        "waiting",
        "loading",
        "needs_action",
        "ready",
        "playing",
        "paused",
        "stopped",
        "blocked",
        "error",
      ]);
      const rawMediaStatus =
        typeof body.mediaStatus === "string" ? body.mediaStatus : "waiting";
      const mediaStatus = allowedMediaStatuses.has(rawMediaStatus)
        ? rawMediaStatus
        : "waiting";
      const mediaError =
        typeof body.mediaError === "string" ? body.mediaError.slice(0, 240) : "";
      const mediaProgress = Math.max(
        0,
        Math.min(100, Math.round(Number(body.mediaProgress) || 0)),
      );
      const appliedSyncVersion = Math.max(
        0,
        Math.round(Number(body.appliedSyncVersion) || 0),
      );
      const mediaVideoUrl =
        typeof body.mediaVideoUrl === "string"
          ? body.mediaVideoUrl.slice(0, 600)
          : "";
      const rawDisplayedClockAt = Number(body.displayedClockAt);
      const displayedClockAt = Number.isFinite(rawDisplayedClockAt)
        ? Math.round(rawDisplayedClockAt)
        : null;
      const calibrationReportVersion = Math.max(
        0,
        Math.round(Number(body.calibrationReportVersion) || 0),
      );
      if (device?.id) {
        await env.DB.prepare(`
          UPDATE devices
          SET displayed_clock_at = ?, calibration_report_version = ?
          WHERE id = ?
        `)
          .bind(displayedClockAt, calibrationReportVersion, device.id)
          .run();
        await env.DB.prepare(`
          INSERT INTO device_media (
            device_id, video_url, media_status, media_progress, media_error,
            applied_sync_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            video_url = excluded.video_url,
            media_status = excluded.media_status,
            media_progress = excluded.media_progress,
            media_error = excluded.media_error,
            applied_sync_version = excluded.applied_sync_version,
            updated_at = excluded.updated_at
        `)
          .bind(
            device.id,
            mediaVideoUrl,
            mediaStatus,
            mediaProgress,
            mediaError,
            appliedSyncVersion,
            Date.now(),
          )
          .run();
      }
      const online = await env.DB.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(
            CASE
              WHEN COALESCE(position, id) < ?
                OR (COALESCE(position, id) = ? AND id <= ?)
              THEN 1 ELSE 0
            END
          ) AS display_number
        FROM devices
        WHERE last_seen >= ?
      `)
        .bind(
          device?.position ?? device?.id ?? 1,
          device?.position ?? device?.id ?? 1,
          device?.id ?? 0,
          now - 3000,
        )
        .first<{ total: number; display_number: number }>();
      const calibration = await readCalibrationState(env);
      let calibrationDispatchedAt: number | null = null;
      if (
        device?.id &&
        calibration.mode === "freeze" &&
        calibration.freezeImmediately &&
        calibration.targetDeviceId === device.id
      ) {
        const dispatchNow = Date.now();
        await env.DB.prepare(`
          UPDATE devices
          SET calibration_dispatched_at = COALESCE(calibration_dispatched_at, ?)
          WHERE id = ?
        `)
          .bind(dispatchNow, device.id)
          .run();
        const dispatch = await env.DB.prepare(
          "SELECT calibration_dispatched_at FROM devices WHERE id = ?",
        )
          .bind(device.id)
          .first<{ calibration_dispatched_at: number | null }>();
        calibrationDispatchedAt =
          dispatch?.calibration_dispatched_at ?? dispatchNow;
      }
      return Response.json({
        id: device?.id,
        code: getStableDeviceCode(device?.id ?? 1),
        number: online?.display_number ?? 1,
        totalDevices: online?.total ?? 1,
        playbackDelayMs: safePlaybackDelay,
        clockAdjustmentMs: device?.clock_adjustment_ms ?? 0,
        volumePercent: device?.volume_percent ?? 100,
        serverTime: Date.now(),
        sync: await readSyncState(env),
        ding: await readDeviceDing(env, device?.id ?? 0),
        image: await readDeviceImage(env, device?.id ?? 0),
        calibration: {
          ...calibration,
          dispatchAt: calibrationDispatchedAt,
        },
      });
    }

    if (url.pathname === "/api/devices") {
      await ensureSchema(env);
      if (request.method === "GET") {
        const onlineSince = Date.now() - 3000;
        const result = await env.DB.prepare(`
          SELECT
            d.id, d.client_key, d.last_seen, d.reported_rtt_ms,
            d.playback_delay_ms, d.clock_adjustment_ms,
            d.displayed_clock_at, d.calibration_report_version,
            d.calibration_reported_clock_at,
            d.calibration_dispatched_at,
            d.calibration_command_received_at,
            d.calibration_report_received_at,
            d.calibration_round_trip_ms, d.calibration_one_way_ms,
            d.calibration_correction_ms,
            d.volume_percent, d.position,
            m.media_status, m.media_progress, m.media_error,
            m.video_url AS media_video_url, m.applied_sync_version,
            i.image_url, i.version AS image_version
          FROM devices d
          LEFT JOIN device_media m ON m.device_id = d.id
          LEFT JOIN device_images i ON i.device_id = d.id
          WHERE d.last_seen >= ?
          ORDER BY COALESCE(d.position, d.id), d.id
          LIMIT 100
        `)
          .bind(onlineSince)
          .all<ActiveDeviceRow>();
        return Response.json({
          serverTime: Date.now(),
          devices: result.results.map(
            (device: ActiveDeviceRow, index: number) => ({
            id: device.id,
            code: getStableDeviceCode(device.id),
            number: index + 1,
            clientKey: device.client_key,
            lastSeen: device.last_seen,
            networkDelay: device.reported_rtt_ms,
            playbackDelay: device.playback_delay_ms,
            clockAdjustmentMs: device.clock_adjustment_ms ?? 0,
            displayedClockAt: device.displayed_clock_at,
            calibrationReportVersion: device.calibration_report_version ?? 0,
            calibrationReportedClockAt:
              device.calibration_reported_clock_at,
            calibrationDispatchedAt:
              device.calibration_dispatched_at,
            calibrationCommandReceivedAt:
              device.calibration_command_received_at,
            calibrationReportReceivedAt:
              device.calibration_report_received_at,
            calibrationRoundTripMs: device.calibration_round_trip_ms ?? 0,
            calibrationOneWayMs: device.calibration_one_way_ms ?? 0,
            calibrationCorrectionMs:
              device.calibration_correction_ms ?? 0,
            volumePercent: device.volume_percent,
            position: device.position ?? device.id,
            mediaStatus: device.media_status ?? "waiting",
            mediaProgress: device.media_progress ?? 0,
            mediaError: device.media_error ?? "",
            mediaVideoUrl: device.media_video_url ?? "",
            appliedSyncVersion: device.applied_sync_version ?? 0,
            imageUrl: device.image_url ?? "",
            imageVersion: device.image_version ?? 0,
            }),
          ),
          calibration: await readCalibrationState(env),
        });
      }
      if (request.method === "PATCH") {
        const body = (await request.json()) as JsonObject;
        if (Array.isArray(body.order)) {
          const statements = body.order.slice(0, 100).map((value, index) =>
            env.DB.prepare("UPDATE devices SET position = ? WHERE id = ?").bind(
              index + 1,
              Number(value),
            ),
          );
          if (statements.length) await env.DB.batch(statements);
          return Response.json({ ok: true });
        }
        const id = Number(body.id);
        if (body.volumePercent !== undefined) {
          const volumePercent = Math.max(
            0,
            Math.min(100, Math.round(Number(body.volumePercent) || 0)),
          );
          await env.DB.prepare(
            "UPDATE devices SET volume_percent = ? WHERE id = ?",
          )
            .bind(volumePercent, id)
            .run();
          return Response.json({ ok: true, volumePercent });
        }
        const rawPlaybackDelay = Number(body.playbackDelayMs);
        const requestedPlaybackDelayMs = Math.max(
          -MAX_PLAYBACK_DELAY_MS,
          Number.isFinite(rawPlaybackDelay)
            ? Math.round(rawPlaybackDelay)
            : 0,
        );
        const playbackDelayMs = Math.min(
          MAX_PLAYBACK_DELAY_MS,
          requestedPlaybackDelayMs,
        );
        await env.DB.prepare(
          "UPDATE devices SET playback_delay_ms = ? WHERE id = ?",
        )
          .bind(playbackDelayMs, id)
          .run();
        return Response.json({ ok: true, playbackDelayMs });
      }
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, PATCH" },
      });
    }

    if (url.pathname === "/api/devices/image") {
      await ensureSchema(env);
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });
      }
      const body = (await request.json()) as JsonObject;
      const deviceId = Math.round(Number(body.deviceId) || 0);
      const imageUrl =
        typeof body.imageUrl === "string" ? body.imageUrl.slice(0, 600) : "";
      if (deviceId <= 0) {
        return Response.json({ error: "invalid device" }, { status: 400 });
      }
      const online = await env.DB.prepare(
        "SELECT id FROM devices WHERE id = ? AND last_seen >= ?",
      )
        .bind(deviceId, Date.now() - 3000)
        .first<{ id: number }>();
      if (!online) {
        return Response.json({ error: "device is offline" }, { status: 404 });
      }
      await env.DB.prepare(`
        INSERT INTO device_images (device_id, image_url, version, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          image_url = excluded.image_url,
          version = device_images.version + 1,
          updated_at = excluded.updated_at
      `)
        .bind(deviceId, imageUrl, Date.now())
        .run();
      return Response.json({
        ok: true,
        deviceId,
        image: await readDeviceImage(env, deviceId),
      });
    }

    if (url.pathname === "/api/devices/ding") {
      await ensureSchema(env);
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });
      }
      const body = (await request.json()) as JsonObject;
      const deviceId = Math.round(Number(body.deviceId) || 0);
      const now = Date.now();
      const targetAt = now + CALIBRATION_SAFETY_WINDOW_MS;
      if (deviceId <= 0) {
        return Response.json(
          { error: "invalid device" },
          { status: 400 },
        );
      }
      const online = await env.DB.prepare(
        "SELECT id FROM devices WHERE id = ? AND last_seen >= ?",
      )
        .bind(deviceId, now - 3000)
        .first<{ id: number }>();
      if (!online) {
        return Response.json({ error: "device is offline" }, { status: 404 });
      }
      await env.DB.prepare(`
        INSERT INTO device_dings (device_id, version, target_at, updated_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          version = device_dings.version + 1,
          target_at = excluded.target_at,
          updated_at = excluded.updated_at
      `)
        .bind(deviceId, targetAt, now)
        .run();
      const ding = await readDeviceDing(env, deviceId);
      return Response.json({
        ok: true,
        deviceId,
        serverTime: Date.now(),
        ding,
      });
    }

    if (
      url.pathname === "/api/calibration/report" &&
      request.method === "POST"
    ) {
      await ensureSchema(env);
      const body = (await request.json()) as JsonObject;
      const clientKey =
        typeof body.clientKey === "string" ? body.clientKey.slice(0, 100) : "";
      const version = Math.max(
        0,
        Math.round(Number(body.version) || 0),
      );
      const displayedClockAt = Math.round(Number(body.displayedClockAt));
      const commandReceivedAt = Math.round(Number(body.commandReceivedAt));
      if (
        !clientKey ||
        !Number.isFinite(displayedClockAt) ||
        !Number.isFinite(commandReceivedAt)
      ) {
        return Response.json(
          { error: "invalid calibration report" },
          { status: 400 },
        );
      }
      const calibration = await readCalibrationState(env);
      if (
        calibration.mode !== "freeze" ||
        !calibration.freezeImmediately ||
        calibration.version !== version ||
        calibration.commandSentAt === null
      ) {
        return Response.json(
          { error: "stale calibration report" },
          { status: 409 },
        );
      }
      const device = await env.DB.prepare(
        "SELECT id, clock_adjustment_ms, calibration_dispatched_at FROM devices WHERE client_key = ?",
      )
        .bind(clientKey)
        .first<{
          id: number;
          clock_adjustment_ms: number;
          calibration_dispatched_at: number | null;
        }>();
      if (!device) {
        return Response.json({ error: "device not found" }, { status: 404 });
      }
      if (device.calibration_dispatched_at === null) {
        return Response.json(
          { error: "calibration command was not dispatched" },
          { status: 409 },
        );
      }
      const reportReceivedAt = Date.now();
      const roundTripMs = Math.max(
        0,
        Math.min(
          10000,
          reportReceivedAt - device.calibration_dispatched_at,
        ),
      );
      const oneWayMs = Math.round(roundTripMs / 2);
      const expectedClockAt =
        device.calibration_dispatched_at + oneWayMs;
      const correctionMs = Math.max(
        -60000,
        Math.min(60000, expectedClockAt - displayedClockAt),
      );
      const clockAdjustmentMs = Math.max(
        -60000,
        Math.min(
          60000,
          device.clock_adjustment_ms + correctionMs,
        ),
      );
      await env.DB.prepare(`
        UPDATE devices
        SET clock_adjustment_ms = ?,
            displayed_clock_at = ?,
            calibration_report_version = ?,
            calibration_reported_clock_at = ?,
            calibration_command_received_at = ?,
            calibration_report_received_at = ?,
            calibration_round_trip_ms = ?,
            calibration_one_way_ms = ?,
            calibration_correction_ms = ?
        WHERE id = ?
      `)
        .bind(
          clockAdjustmentMs,
          displayedClockAt + correctionMs,
          version,
          displayedClockAt,
          commandReceivedAt,
          reportReceivedAt,
          roundTripMs,
          oneWayMs,
          correctionMs,
          device.id,
        )
        .run();
      const nextDevice = await env.DB.prepare(`
        SELECT id
        FROM devices
        WHERE last_seen >= ?
          AND calibration_report_received_at IS NULL
        ORDER BY COALESCE(position, id), id
        LIMIT 1
      `)
        .bind(Date.now() - 3000)
        .first<{ id: number }>();
      await env.DB.prepare(`
        UPDATE calibration_state
        SET target_device_id = ?, updated_at = ?
        WHERE id = 1 AND version = ? AND target_device_id = ?
      `)
        .bind(
          nextDevice?.id ?? null,
          Date.now(),
          version,
          device.id,
        )
        .run();
      return Response.json({
        ok: true,
        deviceId: device.id,
        version,
        commandSentAt: calibration.commandSentAt,
        dispatchedAt: device.calibration_dispatched_at,
        commandReceivedAt,
        reportReceivedAt,
        displayedClockAt,
        roundTripMs,
        oneWayMs,
        correctionMs,
        clockAdjustmentMs,
      });
    }

    if (url.pathname === "/api/calibration/device") {
      await ensureSchema(env);
      if (request.method !== "PATCH") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "PATCH" },
        });
      }
      const body = (await request.json()) as JsonObject;
      const id = Math.round(Number(body.id) || 0);
      const requestedAdjustment = Number(body.clockAdjustmentMs);
      if (id <= 0 || !Number.isFinite(requestedAdjustment)) {
        return Response.json({ error: "invalid adjustment" }, { status: 400 });
      }
      const clockAdjustmentMs = Math.max(
        -60000,
        Math.min(60000, Math.round(requestedAdjustment)),
      );
      await env.DB.prepare(
        "UPDATE devices SET clock_adjustment_ms = ? WHERE id = ?",
      )
        .bind(clockAdjustmentMs, id)
        .run();
      return Response.json({ ok: true, id, clockAdjustmentMs });
    }

    if (url.pathname === "/api/calibration") {
      await ensureSchema(env);
      if (request.method === "GET") {
        return Response.json({
          serverTime: Date.now(),
          calibration: await readCalibrationState(env),
        });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "GET, POST" },
        });
      }
      const body = (await request.json()) as JsonObject;
      const command = typeof body.command === "string" ? body.command : "";
      const current = await readCalibrationState(env);
      if (command === "auto") {
        if (current.mode === "off") {
          return Response.json(
            { error: "start calibration first" },
            { status: 409 },
          );
        }
        const now = Date.now();
        const onlineSince = now - 3000;
        const firstDevice = await env.DB.prepare(`
          SELECT id
          FROM devices
          WHERE last_seen >= ?
          ORDER BY COALESCE(position, id), id
          LIMIT 1
        `)
          .bind(onlineSince)
          .first<{ id: number }>();
        await env.DB.batch([
          env.DB.prepare(`
            UPDATE calibration_state
            SET mode = 'freeze', version = version + 1,
                target_at = ?, command_sent_at = ?,
                target_device_id = ?, freeze_immediately = 1, updated_at = ?
            WHERE id = 1
          `).bind(now, now, firstDevice?.id ?? null, now),
          env.DB.prepare(`
            UPDATE devices
            SET displayed_clock_at = NULL,
                calibration_report_version = 0,
                calibration_reported_clock_at = NULL,
                calibration_dispatched_at = NULL,
                calibration_command_received_at = NULL,
                calibration_report_received_at = NULL,
                calibration_round_trip_ms = 0,
                calibration_one_way_ms = 0,
                calibration_correction_ms = 0
          `),
        ]);
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM devices WHERE last_seen >= ?",
        )
          .bind(onlineSince)
          .first<{ total: number }>();
        return Response.json({
          ok: true,
          pending: count?.total ?? 0,
          calibration: await readCalibrationState(env),
        });
      }

      const now = Date.now();
      let mode: "off" | "live" | "freeze" | "manual";
      let targetAt: number | null = null;
      const freezeImmediately = 0;
      if (command === "start" || command === "show") {
        mode = "live";
      } else if (command === "freeze") {
        mode = "freeze";
        targetAt = now + CALIBRATION_SAFETY_WINDOW_MS;
      } else if (command === "manual") {
        mode = "manual";
        targetAt = current.targetAt;
      } else if (command === "exit") {
        mode = "off";
      } else {
        return Response.json({ error: "invalid command" }, { status: 400 });
      }
      await env.DB.prepare(`
        UPDATE calibration_state
        SET mode = ?, version = version + 1, target_at = ?,
            command_sent_at = ?, target_device_id = NULL,
            freeze_immediately = ?, updated_at = ?
        WHERE id = 1
      `)
        .bind(mode, targetAt, now, freezeImmediately, now)
        .run();
      return Response.json({
        ok: true,
        serverTime: Date.now(),
        calibration: await readCalibrationState(env),
      });
    }

    if (
      url.pathname === "/api/sync/preload" &&
      request.method === "POST"
    ) {
      await ensureSchema(env);
      const body = (await request.json()) as JsonObject;
      const preloadUrl =
        typeof body.videoUrl === "string"
          ? body.videoUrl.slice(0, 600)
          : null;
      await env.DB.prepare(`
        UPDATE sync_state
        SET preload_video_url = ?, preload_version = preload_version + 1,
            updated_at = ?
        WHERE id = 1
      `)
        .bind(preloadUrl, Date.now())
        .run();
      return Response.json({
        ok: true,
        serverTime: Date.now(),
        sync: await readSyncState(env),
      });
    }

    if (url.pathname === "/api/sync") {
      await ensureSchema(env);
      if (request.method === "GET") {
        return Response.json({
          serverTime: Date.now(),
          sync: await readSyncState(env),
        });
      }
      if (request.method === "POST") {
        const body = (await request.json()) as JsonObject;
        const command =
          body.command === "processing" ||
          body.command === "prepare" ||
          body.command === "play" ||
          body.command === "pause" ||
          body.command === "stop"
            ? body.command
            : "idle";
        const requestedTargetAt =
          typeof body.targetAt === "number" ? Math.round(body.targetAt) : null;
        const targetAt =
          command === "play"
            ? requestedTargetAt ?? Date.now() + PLAYBACK_TARGET_LEAD_MS
            : requestedTargetAt;
        const videoUrl =
          typeof body.videoUrl === "string" ? body.videoUrl.slice(0, 600) : null;
        const mediaTime = Math.max(0, Math.round(Number(body.mediaTime) || 0));
        const requestedTimecodeRate =
          typeof body.timecodeRate === "string" ? body.timecodeRate : "25";
        const timecodeRate = TIMECODE_RATE_IDS.has(requestedTimecodeRate)
          ? requestedTimecodeRate
          : "25";
        const progress = Math.max(
          0,
          Math.min(100, Math.round(Number(body.progress) || 0)),
        );
        const statusMessage =
          typeof body.message === "string" ? body.message.slice(0, 240) : "";
        await env.DB.prepare(`
          UPDATE sync_state
          SET command = ?, version = version + 1, target_at = ?, video_url = ?,
              media_time = ?, timecode_rate = ?, progress = ?,
              status_message = ?, updated_at = ?
          WHERE id = 1
        `)
          .bind(
            command,
            targetAt,
            videoUrl,
            mediaTime,
            timecodeRate,
            progress,
            statusMessage,
            Date.now(),
          )
          .run();
        return Response.json({
          ok: true,
          serverTime: Date.now(),
          sync: await readSyncState(env),
        });
      }
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }

    if (url.pathname === "/api/video/upload") {
      const action = url.searchParams.get("action");

      if (request.method === "POST" && action === "create") {
        const body = (await request.json()) as JsonObject;
        const fileSize = Math.max(0, Math.round(Number(body.fileSize) || 0));
        if (fileSize <= 0 || fileSize > 5 * 1024 * 1024 * 1024) {
          return Response.json({ error: "invalid video size" }, { status: 400 });
        }
        const rawName =
          typeof body.fileName === "string" ? body.fileName : "video.mp4";
        const contentType =
          typeof body.contentType === "string"
            ? body.contentType.slice(0, 120)
            : "application/octet-stream";
        const { fileName, safeName } = safeVideoName(rawName);
        const key = `videos/${crypto.randomUUID()}-${safeName}`;
        const upload = await env.MEDIA.createMultipartUpload(key, {
          httpMetadata: {
            contentType,
            cacheControl: "private, max-age=3600",
          },
          customMetadata: {
            originalName: fileName.slice(0, 180),
            originalSize: String(fileSize),
            uploadedAt: new Date().toISOString(),
          },
        });
        return Response.json({
          key: upload.key,
          uploadId: upload.uploadId,
        });
      }

      const key = url.searchParams.get("key") ?? "";
      const uploadId = url.searchParams.get("uploadId") ?? "";
      if (
        !key.startsWith("videos/") ||
        !uploadId ||
        key.length > 700 ||
        uploadId.length > 700
      ) {
        return Response.json(
          { error: "invalid multipart upload" },
          { status: 400 },
        );
      }
      const upload = env.MEDIA.resumeMultipartUpload(key, uploadId);

      if (request.method === "PUT" && action === "part") {
        if (!request.body) {
          return Response.json({ error: "missing part body" }, { status: 400 });
        }
        const partNumber = Math.round(
          Number(url.searchParams.get("partNumber")) || 0,
        );
        if (partNumber < 1 || partNumber > 10000) {
          return Response.json({ error: "invalid part number" }, { status: 400 });
        }
        try {
          const part = await upload.uploadPart(partNumber, request.body);
          return Response.json(part);
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "multipart part upload failed",
            },
            { status: 409 },
          );
        }
      }

      if (request.method === "POST" && action === "complete") {
        const body = (await request.json()) as JsonObject;
        const expectedSize = Math.max(
          0,
          Math.round(Number(body.expectedSize) || 0),
        );
        const parts = Array.isArray(body.parts)
          ? body.parts
              .map((part) => {
                const value = part as JsonObject;
                return {
                  partNumber: Math.round(Number(value.partNumber) || 0),
                  etag: typeof value.etag === "string" ? value.etag : "",
                };
              })
              .filter(
                (part: UploadedPart) =>
                  part.partNumber >= 1 && part.etag.length > 0,
              )
              .sort(
                (left: UploadedPart, right: UploadedPart) =>
                  left.partNumber - right.partNumber,
              )
          : [];
        if (!parts.length) {
          return Response.json({ error: "missing uploaded parts" }, { status: 400 });
        }
        try {
          const object = await upload.complete(parts);
          if (expectedSize > 0 && object.size !== expectedSize) {
            await env.MEDIA.delete(key).catch(() => undefined);
            return Response.json(
              {
                error: `completed object size mismatch (${object.size}/${expectedSize})`,
              },
              { status: 409 },
            );
          }
          rememberVideoMetadata(object);
          return Response.json({
            key,
            url: `/api/video?key=${encodeURIComponent(key)}`,
            size: object.size,
          });
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "multipart completion failed",
            },
            { status: 409 },
          );
        }
      }

      if (request.method === "DELETE") {
        await upload.abort().catch(() => undefined);
        return Response.json({ ok: true });
      }

      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST, PUT, DELETE" },
      });
    }

    if (url.pathname === "/api/video") {
      if (request.method === "PUT") {
        if (!request.body) {
          return Response.json({ error: "missing video body" }, { status: 400 });
        }
        const size = Number(request.headers.get("content-length") ?? 0);
        if (size > 5 * 1024 * 1024 * 1024) {
          return Response.json(
            { error: "video exceeds the 5 GB limit" },
            { status: 413 },
          );
        }
        const rawName = request.headers.get("x-video-name") ?? "video.mp4";
        const { fileName, safeName } = safeVideoName(rawName);
        const key = `videos/${crypto.randomUUID()}-${safeName}`;
        const object = await env.MEDIA.put(key, request.body, {
          httpMetadata: {
            contentType:
              request.headers.get("content-type") ?? "application/octet-stream",
            cacheControl: "private, max-age=3600",
          },
          customMetadata: {
            originalName: fileName.slice(0, 180),
            uploadedAt: new Date().toISOString(),
          },
        });
        rememberVideoMetadata(object);
        return Response.json({
          key,
          url: `/api/video?key=${encodeURIComponent(key)}`,
        });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const key = url.searchParams.get("key");
        if (!key || !key.startsWith("videos/")) {
          return Response.json({ error: "invalid video key" }, { status: 400 });
        }
        const metadata =
          videoMetadataCache.get(key) ?? (await env.MEDIA.head(key));
        if (!metadata) {
          return Response.json({ error: "video not found" }, { status: 404 });
        }
        rememberVideoMetadata(metadata);
        const rangeHeader = request.headers.get("range");
        let start = 0;
        let end = metadata.size - 1;
        let status = 200;
        if (rangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          if (!match) {
            return new Response(null, {
              status: 416,
              headers: { "content-range": `bytes */${metadata.size}` },
            });
          }
          if (match[1]) {
            start = Number(match[1]);
            end = match[2]
              ? Math.min(Number(match[2]), metadata.size - 1)
              : metadata.size - 1;
          } else if (match[2]) {
            const suffixLength = Math.min(Number(match[2]), metadata.size);
            start = metadata.size - suffixLength;
          }
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            start > end ||
            start >= metadata.size
          ) {
            return new Response(null, {
              status: 416,
              headers: { "content-range": `bytes */${metadata.size}` },
            });
          }
          status = 206;
        }
        const object =
          request.method === "HEAD"
            ? null
            : await env.MEDIA.get(
                key,
                status === 206
                  ? { range: { offset: start, length: end - start + 1 } }
                  : undefined,
              );
        if (request.method !== "HEAD" && !object) {
          return Response.json({ error: "video not found" }, { status: 404 });
        }
        const headers = new Headers();
        metadata.writeHttpMetadata(headers);
        headers.set("etag", metadata.httpEtag);
        headers.set("accept-ranges", "bytes");
        headers.set("content-length", String(end - start + 1));
        headers.set("cache-control", "private, max-age=3600");
        if (status === 206) {
          headers.set(
            "content-range",
            `bytes ${start}-${end}/${metadata.size}`,
          );
        }
        return new Response(
          request.method === "HEAD" ? null : object?.body ?? null,
          { status, headers },
        );
      }

      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD, PUT" },
      });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
