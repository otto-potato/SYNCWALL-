"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DISPLAY_ADJUSTMENT,
  adjustDisplayForKey,
  normalizeDisplayAdjustment,
  type DisplayAdjustment,
} from "./display-controls";
import { getCompensatedPlaybackStartAt } from "./playback-timing";

const HEARTBEAT_MS = 200;
const HEARTBEAT_START_SPREAD_MS = 300;
const NETWORK_PROBE_MS = 100;
const MAX_IN_MEMORY_VIDEO_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_PART_SIZE = 4 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_RETRIES = 12;
const DISPLAY_ADJUSTMENT_STORAGE_KEY = "syncwall-display-adjustment-v3";

type SyncState = {
  command: string;
  version: number;
  targetAt: number | null;
  videoUrl: string | null;
  mediaTime: number;
  timecodeRate: string;
  progress: number;
  message: string;
  preloadUrl: string | null;
  preloadVersion: number;
};

type DingState = {
  version: number;
  targetAt: number | null;
};

type ImageState = {
  url: string;
  version: number;
};

type CalibrationState = {
  mode: "off" | "live" | "freeze" | "manual";
  version: number;
  targetAt: number | null;
  commandSentAt: number | null;
  targetDeviceId: number | null;
  freezeImmediately: boolean;
};

type MediaStatus =
  | "waiting"
  | "loading"
  | "needs_action"
  | "ready"
  | "playing"
  | "paused"
  | "stopped"
  | "blocked"
  | "error";

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustNetworkDelay(samples: number[]) {
  const window = samples.slice(-21);
  const center = median(window);
  const deviation = median(window.map((value) => Math.abs(value - center)));
  const limit = Math.max(8, center * 0.35, deviation * 3);
  const stable = window.filter((value) => Math.abs(value - center) <= limit);
  return Math.round(median(stable.length >= 3 ? stable : window));
}

function getClientKey() {
  const storageKey = "syncwall-device-key";
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
  } catch {
    // Some embedded browsers disable localStorage. A session-only key still
    // keeps the device usable until the page is reloaded.
  }

  const cryptoApi = window.crypto;
  let created: string;
  if (typeof cryptoApi?.randomUUID === "function") {
    created = cryptoApi.randomUUID();
  } else if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    created = `device-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  } else {
    created = `device-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  try {
    window.localStorage.setItem(storageKey, created);
  } catch {
    // Keep using the generated key for this page session.
  }
  return created;
}

function playDing(
  context: AudioContext,
  startAt = context.currentTime,
  volume = 1,
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 2400;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(
    Math.max(0.0001, 0.85 * volume),
    startAt + 0.006,
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.26);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.28);
}

function describeMediaError(video: HTMLVideoElement | null) {
  const code = video?.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return "媒体编码不受本机支持，请使用常见 MP3/AAC 或 H.264/AAC 格式";
  }
  if (code === MediaError.MEDIA_ERR_NETWORK) {
    return "媒体网络读取失败，请检查局域网连接";
  }
  if (code === MediaError.MEDIA_ERR_DECODE) {
    return "媒体解码失败，请更换常见音视频格式";
  }
  return "媒体无法播放，请重新加载后再试";
}

function isAudioSource(source: string | null) {
  if (!source) return false;
  try {
    return /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)(?:$|[?&#])/i.test(
      decodeURIComponent(source),
    );
  } catch {
    return /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)(?:$|[?&#])/i.test(source);
  }
}

function formatMasterClock(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${[
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":")}:${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function waitForReconnect(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}

export function ControlledDevice() {
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceNumber, setDeviceNumber] = useState<number | null>(null);
  const [totalDevices, setTotalDevices] = useState(1);
  const [rtt, setRtt] = useState(0);
  const [playbackDelay, setPlaybackDelay] = useState(30);
  const [clockAdjustment, setClockAdjustment] = useState(0);
  const [calibration, setCalibration] = useState<CalibrationState>({
    mode: "off",
    version: 0,
    targetAt: null,
    commandSentAt: null,
    targetDeviceId: null,
    freezeImmediately: false,
  });
  const [frozenClockAt, setFrozenClockAt] = useState<number | null>(null);
  const [, setVolumePercent] = useState(100);
  const [status, setStatus] = useState("正在连接控制端");
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [, setCountdown] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [, setAudioReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [, setVideoUnlocked] = useState(false);
  const [, setMediaError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [deviceImageUrl, setDeviceImageUrl] = useState("");
  const [distributionProgress, setDistributionProgress] = useState(0);
  const [displayMediaTime, setDisplayMediaTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [displayAdjustment, setDisplayAdjustment] =
    useState<DisplayAdjustment>(DEFAULT_DISPLAY_ADJUSTMENT);
  const [showDisplayAdjustment, setShowDisplayAdjustment] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const masterClockTextRef = useRef<HTMLElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rttRef = useRef(0);
  const networkSamplesRef = useRef<number[]>([]);
  const clockOffsetSamplesRef = useRef<number[]>([]);
  const playbackDelayRef = useRef(30);
  const clockAdjustmentRef = useRef(0);
  const displayedClockAtRef = useRef(0);
  const frozenClockAtRef = useRef<number | null>(null);
  const calibrationVersionRef = useRef(-1);
  const calibrationStepRef = useRef("");
  const calibrationModeRef = useRef<CalibrationState["mode"]>("off");
  const calibrationFreezeTimerRef = useRef<number | null>(null);
  const calibrationFrameRef = useRef<number | null>(null);
  const volumeRef = useRef(1);
  const clockOffsetRef = useRef(0);
  const syncStateRef = useRef<SyncState | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const preloadAbortRef = useRef<AbortController | null>(null);
  const playbackObjectUrlRef = useRef<string | null>(null);
  const preloadedMediaRef = useRef<{
    remoteUrl: string;
    playbackUrl: string;
    objectUrl: string;
  } | null>(null);
  const mediaReportRef = useRef<{
    status: MediaStatus;
    progress: number;
    error: string;
    videoUrl: string;
    appliedSyncVersion: number;
  }>({
    status: "waiting",
    progress: 0,
    error: "",
    videoUrl: "",
    appliedSyncVersion: 0,
  });
  const versionRef = useRef(-1);
  const preloadVersionRef = useRef(-1);
  const dingVersionRef = useRef(-1);
  const imageVersionRef = useRef(-1);
  const timerRef = useRef<number | null>(null);
  const dingTimerRef = useRef<number | null>(null);
  const displayAdjustmentTimerRef = useRef<number | null>(null);

  const reportMedia = useCallback(
    (
      status: MediaStatus,
      error = "",
      videoUrl = videoUrlRef.current ?? "",
      progress = mediaReportRef.current.progress,
    ) => {
      mediaReportRef.current = {
        ...mediaReportRef.current,
        status,
        progress,
        error,
        videoUrl,
      };
    },
    [],
  );

  useEffect(() => {
    let savedAdjustment: DisplayAdjustment | null = null;
    try {
      const saved = window.localStorage.getItem(
        DISPLAY_ADJUSTMENT_STORAGE_KEY,
      );
      if (saved) {
        savedAdjustment = normalizeDisplayAdjustment(
          JSON.parse(saved) as Partial<DisplayAdjustment>,
        );
      }
    } catch {
      // Invalid or blocked local storage falls back to the neutral view.
    }
    if (!savedAdjustment) return;
    const timer = window.setTimeout(
      () => setDisplayAdjustment(savedAdjustment!),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const adjustDisplay = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        calibration.mode !== "off" ||
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          target?.tagName ?? "",
        )
      ) {
        return;
      }
      const next = adjustDisplayForKey(displayAdjustment, event.key);
      if (!next) return;
      event.preventDefault();
      setDisplayAdjustment(next);
      setShowDisplayAdjustment(true);
      try {
        window.localStorage.setItem(
          DISPLAY_ADJUSTMENT_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The adjustment remains active for this browser session.
      }
      if (displayAdjustmentTimerRef.current !== null) {
        window.clearTimeout(displayAdjustmentTimerRef.current);
      }
      displayAdjustmentTimerRef.current = window.setTimeout(() => {
        displayAdjustmentTimerRef.current = null;
        setShowDisplayAdjustment(false);
      }, 1400);
    };
    window.addEventListener("keydown", adjustDisplay);
    return () => window.removeEventListener("keydown", adjustDisplay);
  }, [calibration.mode, displayAdjustment]);

  useEffect(() => {
    const clientKey = getClientKey();
    let stopped = false;

    const downloadVideo = async (remoteUrl: string) => {
      const preloaded = preloadedMediaRef.current;
      if (preloaded?.remoteUrl === remoteUrl) {
        downloadAbortRef.current?.abort();
        if (
          playbackObjectUrlRef.current &&
          playbackObjectUrlRef.current !== preloaded.objectUrl
        ) {
          URL.revokeObjectURL(playbackObjectUrlRef.current);
        }
        playbackObjectUrlRef.current = preloaded.objectUrl;
        preloadedMediaRef.current = null;
        setDistributionProgress(100);
        setVideoReady(false);
        setVideoUnlocked(false);
        setMediaError(null);
        setStatus("下一项已提前处理完成，正在校验播放");
        reportMedia("loading", "", remoteUrl, 100);
        setVideoUrl(preloaded.playbackUrl);
        return;
      }
      downloadAbortRef.current?.abort();
      const controller = new AbortController();
      downloadAbortRef.current = controller;
      setDistributionProgress(0);
      setVideoReady(false);
      setVideoUnlocked(false);
      setMediaError(null);
      setStatus("正在接收视频 0%");
      reportMedia("loading", "", remoteUrl, 0);

      try {
        const metadataResponse = await fetch(remoteUrl, {
          method: "HEAD",
          cache: "no-cache",
          signal: controller.signal,
        });
        if (!metadataResponse.ok) {
          throw new Error(
            `无法读取视频信息（HTTP ${metadataResponse.status}）`,
          );
        }
        const totalBytes = Number(
          metadataResponse.headers.get("content-length") ?? 0,
        );
        if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
          throw new Error("服务器未返回有效的视频大小");
        }
        const contentType =
          metadataResponse.headers.get("content-type") ?? "video/mp4";
        const keepLocalBlob =
          totalBytes > 0 && totalBytes <= MAX_IN_MEMORY_VIDEO_BYTES;
        const partCount = Math.ceil(totalBytes / DOWNLOAD_PART_SIZE);
        const chunks: Array<ArrayBuffer | undefined> = new Array(partCount);
        let completedBytes = 0;
        let lastProgress = -1;
        const publishProgress = () => {
          const progress = Math.min(
            99,
            Math.floor((completedBytes / totalBytes) * 100),
          );
          if (progress !== lastProgress) {
            lastProgress = progress;
            setDistributionProgress(progress);
            setStatus(`正在接收视频 ${progress}%（支持断点续传）`);
            reportMedia("loading", "", remoteUrl, progress);
          }
        };

        let partCursor = 0;
        const downloadWorker = async () => {
          while (partCursor < partCount) {
            const partIndex = partCursor;
            partCursor += 1;
            const start = partIndex * DOWNLOAD_PART_SIZE;
            const end = Math.min(
              totalBytes - 1,
              start + DOWNLOAD_PART_SIZE - 1,
            );
            let partData: ArrayBuffer | null = null;
            let lastError: unknown;
            for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt += 1) {
              try {
                const response = await fetch(remoteUrl, {
                  headers: { range: `bytes=${start}-${end}` },
                  cache: "force-cache",
                  signal: controller.signal,
                });
                if (
                  response.status !== 206 &&
                  !(response.status === 200 && partCount === 1)
                ) {
                  throw new Error(
                    `分段读取失败（HTTP ${response.status}）`,
                  );
                }
                const buffer = await response.arrayBuffer();
                const expectedLength = end - start + 1;
                if (buffer.byteLength !== expectedLength) {
                  throw new Error(
                    `视频分片不完整（${buffer.byteLength}/${expectedLength}）`,
                  );
                }
                partData = buffer;
                break;
              } catch (error) {
                if (controller.signal.aborted || stopped) throw error;
                lastError = error;
                setStatus(
                  `网络中断，正在续传 ${lastProgress < 0 ? 0 : lastProgress}%（第 ${attempt + 1} 次重试）`,
                );
                await waitForReconnect(
                  Math.min(5000, 350 * 2 ** attempt),
                );
              }
            }
            if (!partData) {
              throw (
                lastError instanceof Error
                  ? lastError
                  : new Error("视频分片多次重试后仍失败")
              );
            }
            if (keepLocalBlob) chunks[partIndex] = partData;
            completedBytes += partData.byteLength;
            publishProgress();
          }
        };

        await Promise.all(
          Array.from(
            {
              length: Math.min(DOWNLOAD_CONCURRENCY, partCount),
            },
            () => downloadWorker(),
          ),
        );

        if (
          stopped ||
          controller.signal.aborted ||
          videoUrlRef.current !== remoteUrl
        ) {
          return;
        }
        if (playbackObjectUrlRef.current) {
          URL.revokeObjectURL(playbackObjectUrlRef.current);
          playbackObjectUrlRef.current = null;
        }
        let playbackUrl = remoteUrl;
        if (keepLocalBlob) {
          const localVideo = new Blob(chunks as ArrayBuffer[], {
            type: contentType,
          });
          const objectUrl = URL.createObjectURL(localVideo);
          playbackObjectUrlRef.current = objectUrl;
          playbackUrl = objectUrl;
        }
        setDistributionProgress(100);
        setStatus("视频已完整接收，正在校验播放");
        reportMedia("loading", "", remoteUrl, 100);
        setVideoUrl(playbackUrl);
      } catch (error) {
        if (controller.signal.aborted || stopped) return;
        const message =
          error instanceof Error ? error.message : "视频分发失败，请重试";
        setDistributionProgress(0);
        setMediaError(message);
        setVideoReady(false);
        setStatus(message);
        reportMedia("error", message, remoteUrl, 0);
      }
    };

    const prefetchVideo = async (remoteUrl: string) => {
      if (
        remoteUrl === videoUrlRef.current ||
        preloadedMediaRef.current?.remoteUrl === remoteUrl
      ) {
        return;
      }
      preloadAbortRef.current?.abort();
      const controller = new AbortController();
      preloadAbortRef.current = controller;
      try {
        const metadataResponse = await fetch(remoteUrl, {
          method: "HEAD",
          cache: "no-cache",
          signal: controller.signal,
        });
        if (!metadataResponse.ok) return;
        const totalBytes = Number(
          metadataResponse.headers.get("content-length") ?? 0,
        );
        if (
          !Number.isFinite(totalBytes) ||
          totalBytes <= 0 ||
          totalBytes > MAX_IN_MEMORY_VIDEO_BYTES
        ) {
          return;
        }
        const response = await fetch(remoteUrl, {
          cache: "force-cache",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const mediaBlob = await response.blob();
        if (stopped || controller.signal.aborted) return;
        if (preloadedMediaRef.current?.objectUrl) {
          URL.revokeObjectURL(preloadedMediaRef.current.objectUrl);
        }
        const objectUrl = URL.createObjectURL(mediaBlob);
        preloadedMediaRef.current = {
          remoteUrl,
          playbackUrl: objectUrl,
          objectUrl,
        };
      } catch {
        // A failed background preload must never disturb current playback.
      }
    };

    const applyCommand = (sync: SyncState) => {
      setSyncState(sync);
      syncStateRef.current = sync;
      if (sync.preloadVersion !== preloadVersionRef.current) {
        preloadVersionRef.current = sync.preloadVersion;
        if (sync.preloadUrl) void prefetchVideo(sync.preloadUrl);
      }
      if (sync.command === "stop") {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const video = videoRef.current;
        if (video) {
          video.pause();
          video.currentTime = 0;
        }
        setIsPlaying(false);
        setDisplayMediaTime(0);
        setCountdown(null);
        setStatus("已停止，等待控制端");
        reportMedia(
          videoUrlRef.current ? "stopped" : "waiting",
          "",
          videoUrlRef.current ?? "",
        );
        mediaReportRef.current.appliedSyncVersion = Math.max(
          mediaReportRef.current.appliedSyncVersion,
          sync.version,
        );
      }
      if (sync.version === versionRef.current) return;
      versionRef.current = sync.version;
      mediaReportRef.current.appliedSyncVersion = sync.version;
      if (
        sync.videoUrl &&
        (sync.videoUrl !== videoUrlRef.current ||
          mediaReportRef.current.status === "error")
      ) {
        videoUrlRef.current = sync.videoUrl;
        void downloadVideo(sync.videoUrl);
      }

      if (sync.command === "play" && sync.targetAt) {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        const video = videoRef.current;
        if (video) {
          video.currentTime = sync.mediaTime / 1000;
        }
        setDisplayMediaTime(sync.mediaTime / 1000);
        setStatus(
          `播放命令：浏览器校准时间到达 ${formatMasterClock(sync.targetAt)} 时开始`,
        );
        const startPlayback = () => {
          const latestSync = syncStateRef.current;
          if (
            latestSync?.command !== "play" ||
            latestSync.version !== sync.version
          ) {
            return;
          }
          const currentVideo = videoRef.current;
          if (!currentVideo) {
            setIsPlaying(false);
            setStatus("视频尚未加载，无法开始播放");
            return;
          }
          setCountdown(null);
          void currentVideo
            .play()
            .then(() => {
              const latest = syncStateRef.current;
              if (
                latest?.command !== "play" ||
                latest.version !== sync.version
              ) {
                currentVideo.pause();
                currentVideo.currentTime = 0;
                setIsPlaying(false);
                reportMedia(
                  videoUrlRef.current ? "stopped" : "waiting",
                );
                return;
              }
              setVideoUnlocked(true);
              setIsPlaying(true);
              setStatus("正在同步播放");
              reportMedia("playing");
            })
            .catch((error: unknown) => {
              setIsPlaying(false);
              if (
                currentVideo.error ||
                (error instanceof DOMException &&
                  error.name === "NotSupportedError")
              ) {
                const message = describeMediaError(currentVideo);
                setMediaError(message);
                setStatus(message);
                reportMedia("error", message);
              } else {
                setVideoUnlocked(false);
                setAudioReady(false);
                setStatus("浏览器阻止有声播放；点击或按键后将自动重试");
                reportMedia("blocked", "浏览器阻止有声播放，等待页面交互后自动重试");
              }
            });
        };
        const waitForTarget = () => {
          const latestSync = syncStateRef.current;
          if (
            latestSync?.command !== "play" ||
            latestSync.version !== sync.version
          ) {
            timerRef.current = null;
            return;
          }
          const calibratedNow =
            Date.now() +
            clockOffsetRef.current +
            clockAdjustmentRef.current;
          const playbackStartAt = getCompensatedPlaybackStartAt(
            sync.targetAt!,
            playbackDelayRef.current,
          );
          const remaining = playbackStartAt - calibratedNow;
          setCountdown(Math.max(0, remaining));
          if (remaining <= 0) {
            timerRef.current = null;
            startPlayback();
            return;
          }
          timerRef.current = window.setTimeout(
            waitForTarget,
            remaining > 25 ? Math.min(50, remaining - 15) : 1,
          );
        };
        waitForTarget();
      } else if (sync.command === "pause") {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const video = videoRef.current;
        video?.pause();
        setDisplayMediaTime(video?.currentTime ?? sync.mediaTime / 1000);
        setIsPlaying(false);
        setCountdown(null);
        setStatus("已同步暂停");
        reportMedia("paused");
      } else if (sync.command === "stop") {
        // Stop is enforced before the version check on every heartbeat so a
        // late play promise or scheduled timer cannot restart this device.
      } else if (sync.command === "prepare") {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        videoRef.current?.pause();
        setIsPlaying(false);
        setCountdown(null);
        if (sync.videoUrl === videoUrlRef.current) {
          const progress = mediaReportRef.current.progress;
          setStatus(
            progress >= 100
              ? "视频已完整接收，正在校验播放"
              : `正在接收视频 ${progress}%`,
          );
        }
      } else if (sync.command === "processing") {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        videoRef.current?.pause();
        setIsPlaying(false);
        setCountdown(null);
        setStatus(sync.message || `控制端正在处理视频 ${sync.progress}%`);
        reportMedia("waiting", "", "", 0);
      }
    };

    const applyDing = (ding: DingState) => {
      if (ding.version === dingVersionRef.current) return;
      dingVersionRef.current = ding.version;
      const localTarget = ding.targetAt
        ? ding.targetAt -
          clockOffsetRef.current -
          clockAdjustmentRef.current
        : null;
      if (!localTarget) return;
      const effectiveTarget = getCompensatedPlaybackStartAt(
        localTarget,
        playbackDelayRef.current,
      );
      if (effectiveTarget < Date.now() - 500) return;
      const wait = Math.max(0, effectiveTarget - Date.now());
      const scheduleDing = async () => {
        const context = audioContextRef.current;
        if (!context) {
          setAudioReady(false);
          setStatus("收到校准指令，但浏览器尚未开放音频权限");
          return;
        }
        try {
          if (context.state === "suspended") await context.resume();
          if (context.state !== "running") {
            setAudioReady(false);
            setStatus("音频被浏览器拦截，点击或按键后将自动重试");
            return;
          }
          setAudioReady(true);
          playDing(
            context,
            context.currentTime + wait / 1000,
            volumeRef.current,
          );
          setStatus(
            `校准音将在 ${wait}ms 后播放（手动 ${playbackDelayRef.current > 0 ? "+" : ""}${playbackDelayRef.current}ms）`,
          );
          if (dingTimerRef.current) window.clearTimeout(dingTimerRef.current);
          dingTimerRef.current = window.setTimeout(
            () => setStatus("已播放本机校准叮声"),
            wait + 300,
          );
        } catch {
          setAudioReady(false);
          setStatus("音频启动失败，等待页面交互后自动重试");
        }
      };
      void scheduleDing();
    };

    const cancelCalibrationFreeze = () => {
      if (calibrationFreezeTimerRef.current !== null) {
        window.clearTimeout(calibrationFreezeTimerRef.current);
        calibrationFreezeTimerRef.current = null;
      }
      if (calibrationFrameRef.current !== null) {
        window.cancelAnimationFrame(calibrationFrameRef.current);
        calibrationFrameRef.current = null;
      }
    };

    const readAdjustedClock = () =>
      Date.now() + clockOffsetRef.current + clockAdjustmentRef.current;

    const applyCalibration = (
      next: CalibrationState,
      currentDeviceId: number,
    ) => {
      setCalibration(next);
      calibrationModeRef.current = next.mode;
      calibrationVersionRef.current = next.version;
      const stepKey = `${next.version}:${next.mode}:${next.targetDeviceId ?? 0}`;
      if (stepKey === calibrationStepRef.current) return;
      calibrationStepRef.current = stepKey;
      cancelCalibrationFreeze();

      if (next.mode === "off" || next.mode === "live") {
        frozenClockAtRef.current = null;
        setFrozenClockAt(null);
        displayedClockAtRef.current = Math.round(readAdjustedClock());
        return;
      }

      if (next.mode === "manual") {
        const value =
          frozenClockAtRef.current ?? Math.round(readAdjustedClock());
        frozenClockAtRef.current = value;
        displayedClockAtRef.current = value;
        setFrozenClockAt(value);
        return;
      }

      if (next.mode === "freeze" && next.targetAt !== null) {
        if (
          next.freezeImmediately &&
          next.targetDeviceId !== currentDeviceId
        ) {
          if (frozenClockAtRef.current === null) {
            displayedClockAtRef.current = Math.round(readAdjustedClock());
          }
          setStatus(
            next.targetDeviceId === null
              ? "顺序自动校准已全部完成"
              : "等待前序设备完成自动校准",
          );
          return;
        }
        frozenClockAtRef.current = null;
        setFrozenClockAt(null);
        if (next.freezeImmediately) {
          const commandReceivedAt = Math.round(readAdjustedClock());
          frozenClockAtRef.current = commandReceivedAt;
          displayedClockAtRef.current = commandReceivedAt;
          setFrozenClockAt(commandReceivedAt);
          const sendReport = async () => {
            const response = await fetch("/api/calibration/report", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                clientKey,
                version: next.version,
                displayedClockAt: commandReceivedAt,
                commandReceivedAt,
              }),
            });
            if (!response.ok) {
              throw new Error("calibration report failed");
            }
            return (await response.json()) as {
              clockAdjustmentMs: number;
            };
          };
          void sendReport()
            .then((result) => {
              const nextAdjustment = Math.round(result.clockAdjustmentMs);
              const adjustmentDelta =
                nextAdjustment - clockAdjustmentRef.current;
              clockAdjustmentRef.current = nextAdjustment;
              setClockAdjustment(nextAdjustment);
              if (
                adjustmentDelta !== 0 &&
                frozenClockAtRef.current !== null
              ) {
                const correctedClock =
                  frozenClockAtRef.current + adjustmentDelta;
                frozenClockAtRef.current = correctedClock;
                displayedClockAtRef.current = correctedClock;
                setFrozenClockAt(correctedClock);
              }
              setStatus("自动校准已回传并完成时钟修正");
            })
            .catch(() =>
              setStatus("自动校准回传失败，请在控制端重新校准"),
            );
          return;
        }
        const finishFreeze = () => {
          calibrationFrameRef.current = null;
          const value = Math.round(readAdjustedClock());
          frozenClockAtRef.current = value;
          displayedClockAtRef.current = value;
          setFrozenClockAt(value);
        };
        const waitPrecisely = () => {
          const remaining = next.targetAt! - readAdjustedClock();
          if (remaining <= 0) {
            finishFreeze();
            return;
          }
          if (remaining > 32) {
            calibrationFreezeTimerRef.current = window.setTimeout(
              waitPrecisely,
              Math.max(1, remaining - 20),
            );
            return;
          }
          calibrationFrameRef.current = window.requestAnimationFrame(
            waitPrecisely,
          );
        };
        waitPrecisely();
      }
    };

    let heartbeatDeviceCount = 1;
    const heartbeat = async () => {
      try {
        const response = await fetch("/api/devices/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientKey,
            reportedRttMs: rttRef.current,
            playbackDelayMs: playbackDelayRef.current,
            mediaStatus: mediaReportRef.current.status,
            mediaProgress: mediaReportRef.current.progress,
            mediaError: mediaReportRef.current.error,
            mediaVideoUrl: mediaReportRef.current.videoUrl,
            appliedSyncVersion: mediaReportRef.current.appliedSyncVersion,
            displayedClockAt: displayedClockAtRef.current,
            calibrationReportVersion: calibrationVersionRef.current,
          }),
        });
        if (!response.ok) throw new Error("heartbeat failed");
        const result = (await response.json()) as {
          id: number;
          code: string;
          number: number;
          totalDevices: number;
          playbackDelayMs: number;
          clockAdjustmentMs: number;
          volumePercent: number;
          serverTime: number;
          sync: SyncState;
          ding: DingState;
          image: ImageState;
          calibration: CalibrationState;
        };
        if (!stopped) {
          heartbeatDeviceCount = Math.max(1, result.totalDevices);
          setDeviceId(result.id);
          setDeviceCode(result.code);
          setDeviceNumber(result.number);
          setTotalDevices(Math.max(1, result.totalDevices));
          setPlaybackDelay(result.playbackDelayMs);
          playbackDelayRef.current = result.playbackDelayMs;
          const nextClockAdjustment = result.clockAdjustmentMs ?? 0;
          const adjustmentDelta =
            nextClockAdjustment - clockAdjustmentRef.current;
          if (adjustmentDelta !== 0 && frozenClockAtRef.current !== null) {
            const shiftedFrozenClock =
              frozenClockAtRef.current + adjustmentDelta;
            frozenClockAtRef.current = shiftedFrozenClock;
            displayedClockAtRef.current = shiftedFrozenClock;
            setFrozenClockAt(shiftedFrozenClock);
          }
          clockAdjustmentRef.current = nextClockAdjustment;
          setClockAdjustment(nextClockAdjustment);
          const nextVolumePercent = Math.max(
            0,
            Math.min(100, result.volumePercent ?? 100),
          );
          setVolumePercent(nextVolumePercent);
          volumeRef.current = nextVolumePercent / 100;
          if (videoRef.current) {
            videoRef.current.volume = volumeRef.current;
          }
          if (result.image.version !== imageVersionRef.current) {
            imageVersionRef.current = result.image.version;
            setDeviceImageUrl(result.image.url);
          }
          applyCommand(result.sync);
          applyDing(result.ding);
          applyCalibration(result.calibration, result.id);
          if (result.sync.command === "idle") setStatus("在线，等待控制端指令");
        }
      } catch {
        if (!stopped) setStatus("与控制端断开，正在重连");
      }
    };

    const networkProbe = async () => {
      const sentAt = Date.now();
      const startedAt = performance.now();
      try {
        const response = await fetch(`/api/ping?probe=${sentAt}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const result = (await response.json()) as { serverTime: number };
        const measuredRtt = Math.max(
          0,
          Math.round(performance.now() - startedAt),
        );
        networkSamplesRef.current = [
          ...networkSamplesRef.current.slice(-20),
          measuredRtt,
        ];
        const filteredRtt = robustNetworkDelay(networkSamplesRef.current);
        const offsetCandidate =
          result.serverTime - (sentAt + measuredRtt / 2);
        clockOffsetSamplesRef.current = [
          ...clockOffsetSamplesRef.current.slice(-8),
          offsetCandidate,
        ];
        if (!stopped) {
          rttRef.current = filteredRtt;
          clockOffsetRef.current = median(clockOffsetSamplesRef.current);
          setRtt(filteredRtt);
        }
      } catch {
        // A lost probe is ignored; the next 100ms sample keeps the estimate stable.
      }
    };

    let networkProbeTimer: number | null = null;
    const networkProbeLoop = async () => {
      const cycleStartedAt = performance.now();
      await networkProbe();
      if (stopped) return;
      const elapsed = performance.now() - cycleStartedAt;
      networkProbeTimer = window.setTimeout(
        networkProbeLoop,
        Math.max(0, NETWORK_PROBE_MS - elapsed),
      );
    };
    void networkProbeLoop();

    let heartbeatTimer: number | null = null;
    const heartbeatLoop = async () => {
      await heartbeat();
      if (stopped) return;
      const transferInProgress =
        mediaReportRef.current.status === "loading" ||
        syncStateRef.current?.command === "processing";
      const calibrationActive = calibrationModeRef.current !== "off";
      const scaledHeartbeatMs =
        heartbeatDeviceCount >= 80
          ? 900
          : heartbeatDeviceCount >= 40
            ? 650
            : heartbeatDeviceCount >= 15
              ? 400
              : HEARTBEAT_MS;
      const baseHeartbeatMs = Math.max(
        calibrationActive
          ? 50
          : transferInProgress
            ? 800
            : HEARTBEAT_MS,
        calibrationActive ? 50 : scaledHeartbeatMs,
      );
      const jitterMs = calibrationActive
        ? 0
        : Math.round(
            Math.random() * Math.min(180, baseHeartbeatMs / 3),
          );
      heartbeatTimer = window.setTimeout(
        heartbeatLoop,
        baseHeartbeatMs + jitterMs,
      );
    };
    heartbeatTimer = window.setTimeout(
      heartbeatLoop,
      Math.round(Math.random() * HEARTBEAT_START_SPREAD_MS),
    );
    return () => {
      stopped = true;
      if (networkProbeTimer !== null) window.clearTimeout(networkProbeTimer);
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (dingTimerRef.current) window.clearTimeout(dingTimerRef.current);
      if (displayAdjustmentTimerRef.current !== null) {
        window.clearTimeout(displayAdjustmentTimerRef.current);
      }
      cancelCalibrationFreeze();
      downloadAbortRef.current?.abort();
      preloadAbortRef.current?.abort();
      if (playbackObjectUrlRef.current) {
        URL.revokeObjectURL(playbackObjectUrlRef.current);
        playbackObjectUrlRef.current = null;
      }
      if (preloadedMediaRef.current?.objectUrl) {
        URL.revokeObjectURL(preloadedMediaRef.current.objectUrl);
        preloadedMediaRef.current = null;
      }
    };
  }, [reportMedia]);

  useEffect(() => {
    let animationFrame = 0;
    const updateTimecode = () => {
      const video = videoRef.current;
      if (video) setDisplayMediaTime(video.currentTime);
      if (isPlaying) {
        animationFrame = window.requestAnimationFrame(updateTimecode);
      }
    };
    animationFrame = window.requestAnimationFrame(updateTimecode);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isPlaying, syncState?.version]);

  useEffect(() => {
    let animationFrame = 0;
    const updateMasterClock = () => {
      const liveClock =
        Date.now() + clockOffsetRef.current + clockAdjustmentRef.current;
      const calibratedNow =
        frozenClockAtRef.current ?? Math.round(liveClock);
      displayedClockAtRef.current = calibratedNow;
      if (masterClockTextRef.current) {
        masterClockTextRef.current.textContent =
          formatMasterClock(calibratedNow);
      }
      animationFrame = window.requestAnimationFrame(updateMasterClock);
    };
    animationFrame = window.requestAnimationFrame(updateMasterClock);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [calibration.mode, calibration.version]);

  const enableMedia = useCallback(async () => {
    const AudioContextClass =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextClass) {
      setStatus("当前浏览器不支持音频校准");
      return;
    }
    const context =
      audioContextRef.current ??
      new AudioContextClass({ latencyHint: "interactive" });
    audioContextRef.current = context;
    const video = videoRef.current;
    const currentSync = syncStateRef.current;
    let videoPlayPromise: Promise<void> | null = null;
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      setMediaError(null);
      video.muted = false;
      video.volume = Math.min(0.04, volumeRef.current);
      if (currentSync?.command === "play" && currentSync.targetAt) {
        const localTarget =
          currentSync.targetAt -
          clockOffsetRef.current -
          clockAdjustmentRef.current;
        const elapsedSeconds = Math.max(0, Date.now() - localTarget) / 1000;
        video.currentTime =
          currentSync.mediaTime / 1000 + elapsedSeconds;
      } else {
        video.currentTime = 0;
      }
      videoPlayPromise = video.play();
    }
    try {
      if (context.state === "suspended") await context.resume();
      if (context.state === "running") {
        setAudioReady(true);
      }
      if (videoPlayPromise && video) {
        await videoPlayPromise;
        video.volume = volumeRef.current;
        setVideoUnlocked(true);
        if (currentSync?.command === "play") {
          setIsPlaying(true);
          setStatus("播放权限已启用，已追上当前播放位置");
          reportMedia("playing");
        } else {
          video.pause();
          video.currentTime = 0;
          setIsPlaying(false);
          setStatus("设备已准备完成，等待控制端播放");
          reportMedia("ready");
        }
      } else if (!videoUrlRef.current) {
        setStatus("声音已自动启用，等待控制端");
      } else if (!videoReady) {
        setStatus("声音已启用，视频仍在缓冲");
      }
      if (context.state !== "running") {
        setAudioReady(false);
        setStatus("声音权限尚未开放，点击或按键后将自动重试");
      }
    } catch (error) {
      if (
        video?.error ||
        (error instanceof DOMException && error.name === "NotSupportedError")
      ) {
        const message = describeMediaError(video);
        setMediaError(message);
        setStatus(message);
        reportMedia("error", message);
      } else {
        setVideoUnlocked(false);
        setAudioReady(false);
        setStatus("浏览器仍阻止有声播放，点击或按键后将自动重试");
        reportMedia("blocked", "浏览器阻止了有声视频播放");
      }
    }
  }, [reportMedia, videoReady]);

  useEffect(() => {
    const retryMediaUnlock = () => {
      void enableMedia();
    };
    const startupTimer = window.setTimeout(retryMediaUnlock, 0);
    window.addEventListener("pointerdown", retryMediaUnlock, {
      passive: true,
    });
    window.addEventListener("keydown", retryMediaUnlock);
    return () => {
      window.clearTimeout(startupTimer);
      window.removeEventListener("pointerdown", retryMediaUnlock);
      window.removeEventListener("keydown", retryMediaUnlock);
    };
  }, [enableMedia]);

  const updateClockAdjustment = async (value: number) => {
    const next = Math.max(-60000, Math.min(60000, Math.round(value)));
    const delta = next - clockAdjustmentRef.current;
    clockAdjustmentRef.current = next;
    setClockAdjustment(next);
    if (frozenClockAtRef.current !== null && delta !== 0) {
      const shifted = frozenClockAtRef.current + delta;
      frozenClockAtRef.current = shifted;
      displayedClockAtRef.current = shifted;
      setFrozenClockAt(shifted);
    }
    if (deviceId !== null) {
      await fetch("/api/calibration/device", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: deviceId, clockAdjustmentMs: next }),
      }).catch(() => undefined);
    }
  };

  const sliceCount = Math.max(1, totalDevices);
  const sliceNumber = Math.min(
    sliceCount,
    Math.max(1, deviceNumber ?? 1),
  );
  const sliceOffset = ((sliceNumber - 1) / sliceCount) * 100;
  const isAudioMedia = isAudioSource(syncState?.videoUrl ?? null);
  const isControlProcessing = syncState?.command === "processing";
  const showWorkflowProgress =
    isControlProcessing ||
    (syncState?.command === "prepare" &&
      (distributionProgress < 100 || !videoReady));
  const visibleWorkflowProgress = isControlProcessing
    ? syncState.progress
    : distributionProgress;
  const wallProgress = mediaDuration
    ? Math.min(
        100,
        Math.max(0, (displayMediaTime / mediaDuration) * 100),
      )
    : 0;

  if (calibration.mode !== "off") {
    return (
      <main className={`device-calibration-page ${calibration.mode}`}>
        <header>
          <div>
            <span>SYNCWALL · CALIBRATION</span>
            <strong>
              设备 {deviceCode ?? "--"} · 序号 {deviceNumber ?? "--"}
            </strong>
          </div>
          <b>{status}</b>
        </header>
        <section className="calibration-clock-stage">
          <span className="calibration-mode-label">
            {calibration.mode === "freeze"
              ? frozenClockAt === null
                ? "等待静止目标时刻"
                : calibration.freezeImmediately
                  ? "收到指令后已立即静止并回传"
                  : "时间已静止"
              : calibration.mode === "manual"
                ? "手动微调"
                : "实时显示时间码"}
          </span>
          <strong ref={masterClockTextRef}>00:00:00.000</strong>
          <small>HOST BROWSER CLOCK · 精确到 1ms</small>
          {calibration.targetAt !== null && (
            <p>
              {calibration.freezeImmediately
                ? `主机发送指令 ${formatMasterClock(calibration.commandSentAt ?? calibration.targetAt)}`
                : `统一静止目标 ${formatMasterClock(calibration.targetAt)}`}{" "}
              · 回传值{" "}
              {frozenClockAt === null
                ? "等待中"
                : formatMasterClock(frozenClockAt)}
            </p>
          )}
        </section>
        <section className="device-clock-details">
          <div>
            <span>网络延迟</span>
            <strong>{rtt}ms</strong>
          </div>
          <div>
            <span>独立时间修正</span>
            <strong>{clockAdjustment > 0 ? "+" : ""}{clockAdjustment}ms</strong>
          </div>
          <div>
            <span>设备播放延迟补偿</span>
            <strong>{playbackDelay > 0 ? "+" : ""}{playbackDelay}ms</strong>
          </div>
        </section>
        <section className="device-manual-clock">
          <div>
            <span>手动校准当前时间</span>
            <small>冻结后按照片对比，以 1ms 为单位微调本机显示时间</small>
          </div>
          <div className="manual-clock-buttons">
            {[-10, -1, 1, 10].map((delta) => (
              <button
                type="button"
                key={delta}
                onClick={() => void updateClockAdjustment(clockAdjustmentRef.current + delta)}
              >
                {delta > 0 ? "+" : ""}{delta}ms
              </button>
            ))}
          </div>
          <label>
            <span>时间修正值</span>
            <input
              type="number"
              min="-60000"
              max="60000"
              step="1"
              value={clockAdjustment}
              onChange={(event) =>
                void updateClockAdjustment(Number(event.currentTarget.value))
              }
            />
            <b>ms</b>
          </label>
        </section>
      </main>
    );
  }

  const visibleWallProgress = showWorkflowProgress
    ? visibleWorkflowProgress
    : wallProgress;

  return (
    <main
      className={`device-playback-page ${
        isPlaying && !isAudioMedia ? "playing" : ""
      } ${isAudioMedia ? "audio-mode" : ""}`}
    >
      <section className="device-stage">
        {videoUrl ? (
          <div
            className="controlled-video-viewport"
            style={{
              inset: "auto",
              top: isAudioMedia
                ? 0
                : `${50 + displayAdjustment.verticalOffsetPercent}%`,
              left: 0,
              width: "100%",
              height: isAudioMedia
                ? "100%"
                : `${displayAdjustment.zoom * 100}%`,
              transform: isAudioMedia
                ? "none"
                : "translate3d(0, -50%, 0)",
            }}
          >
            <div
              className="controlled-video-wall"
              style={{
                width: isAudioMedia ? "100%" : `${sliceCount * 100}%`,
                transform: isAudioMedia
                  ? "none"
                  : `translate3d(-${sliceOffset}%, 0, 0)`,
              }}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="auto"
                onLoadStart={() => {
                  setVideoReady(false);
                  setVideoUnlocked(false);
                  setMediaError(null);
                  reportMedia("loading");
                }}
                onLoadedMetadata={(event) => {
                  event.currentTarget.defaultPlaybackRate = 1;
                  event.currentTarget.playbackRate = 1;
                  setMediaDuration(
                    Number.isFinite(event.currentTarget.duration)
                      ? event.currentTarget.duration
                      : 0,
                  );
                  setStatus("原始音视频信息已接收，正在缓冲");
                }}
                onRateChange={(event) => {
                  if (event.currentTarget.playbackRate !== 1) {
                    event.currentTarget.playbackRate = 1;
                  }
                }}
                onCanPlay={() => {
                  setVideoReady(true);
                  if (syncStateRef.current?.command === "stop") {
                    videoRef.current?.pause();
                    if (videoRef.current) videoRef.current.currentTime = 0;
                    reportMedia("stopped", "", videoUrlRef.current ?? "", 100);
                    return;
                  }
                  reportMedia("ready", "", videoUrlRef.current ?? "", 100);
                }}
                onError={() => {
                  const message = describeMediaError(videoRef.current);
                  setMediaError(message);
                  setVideoReady(false);
                  setStatus(message);
                  reportMedia("error", message);
                }}
                onEnded={() => {
                  const video = videoRef.current;
                  if (video) {
                    video.pause();
                    video.currentTime = 0;
                  }
                  setDisplayMediaTime(0);
                  setIsPlaying(false);
                  setCountdown(null);
                  reportMedia("ready", "", videoUrlRef.current ?? "", 100);
                }}
                style={{
                  opacity: isAudioMedia ? 0 : 1,
                  transform: isAudioMedia
                    ? "none"
                    : `scaleX(${displayAdjustment.horizontalScale})`,
                  transformOrigin: `${
                    ((sliceNumber - 0.5) / sliceCount) * 100
                  }% 50%`,
                }}
              />
            </div>
            {!isAudioMedia && (
              <div
                className={`display-area-frame ${
                  showDisplayAdjustment || !isPlaying ? "visible" : ""
                }`}
                aria-hidden="true"
              >
                <span>本机纵向显示区域</span>
              </div>
            )}
          </div>
        ) : (
          <div className="device-idle-visual"><i /><i /><i /></div>
        )}
        {isAudioMedia && videoUrl && (
          <div className="audio-media-visual device-audio-visual">
            <strong>AUDIO</strong>
            <span>{isPlaying ? "同步播放中" : "音频已就绪"}</span>
          </div>
        )}
        {deviceImageUrl && (
          <img className="device-target-image" src={deviceImageUrl} alt="控制端指定显示图片" />
        )}
        {!isPlaying && (
          <div className="device-waiting-identity" aria-label="本机设备标识">
            <span>WAITING · 当前显示序号</span>
            <strong>{String(deviceNumber ?? 0).padStart(2, "0")}</strong>
            <b>设备编码 {deviceCode ?? "--"}</b>
          </div>
        )}
        {showDisplayAdjustment && !isAudioMedia && videoUrl && (
          <div className="display-adjustment-hud" aria-live="polite">
            <strong>本机画面校正</strong>
            <span>
              上下 {displayAdjustment.verticalOffsetPercent > 0 ? "+" : ""}
              {displayAdjustment.verticalOffsetPercent}% · 纵向高度{" "}
              {Math.round(displayAdjustment.zoom * 100)}% · 横向{" "}
              {Math.round(displayAdjustment.horizontalScale * 100)}%
            </span>
            <small>↑↓ 位置　+− 大小　←→ 横向裁切　0 重置</small>
          </div>
        )}
        {!isAudioMedia && videoUrl && (
          <div className="display-shortcut-legend">
            本机画面：↑↓ 上下移动　+− 纵向高度　←→ 横向裁切　0 重置
          </div>
        )}
        <div className="cross-screen-progress" aria-label={`跨屏进度 ${Math.round(visibleWallProgress)}%`}>
          <div
            className="cross-screen-progress-wall"
            style={{
              width: `${sliceCount * 100}%`,
              transform: `translate3d(-${sliceOffset}%, 0, 0)`,
            }}
          >
            <i style={{ width: `${visibleWallProgress}%` }} />
          </div>
        </div>
      </section>
    </main>
  );
}
