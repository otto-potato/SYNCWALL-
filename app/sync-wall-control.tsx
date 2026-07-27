"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_TIMECODE_RATE_ID,
  TIMECODE_RATES,
  clampFrameToDuration,
  formatFrameTimecode,
  formatTimecode,
  frameToSeconds,
  getMaximumSeekFrame,
  getTimecodeRate,
  parseTimecode,
  secondsToFrame,
  type TimecodeRateId,
} from "./timecode";

const CALIBRATION_SAFETY_WINDOW_MS = 2000;
const PLAYBACK_TARGET_LEAD_MS = 3000;
const MAX_PLAYBACK_DELAY_MS = 3000;
const PING_INTERVAL_MS = 100;
const MAX_DEVICES = 100;
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;
const TRANSFER_RETRIES = 6;
const TIMECODE_RATE_STORAGE_KEY = "syncwall-timecode-rate";

type Phase = "ready" | "processing" | "distributing";
type PlayState = "idle" | "scheduled" | "playing" | "paused";

type Device = {
  id: number;
  code: string;
  number: number;
  name: string;
  networkDelay: number;
  playbackDelay: number;
  clockAdjustmentMs: number;
  displayedClockAt: number | null;
  calibrationReportVersion: number;
  volumePercent: number;
  jitter: number;
  samples: number[];
  online: boolean;
  mediaStatus: string;
  mediaProgress: number;
  mediaError: string;
  mediaVideoUrl: string;
  appliedSyncVersion: number;
  imageUrl: string;
  imageVersion: number;
};

const emptyDevice: Device = {
  id: 0,
  code: "--",
  number: 0,
  name: "未连接",
  networkDelay: 0,
  playbackDelay: 0,
  clockAdjustmentMs: 0,
  displayedClockAt: null,
  calibrationReportVersion: 0,
  volumePercent: 100,
  jitter: 0,
  samples: [],
  online: false,
  mediaStatus: "waiting",
  mediaProgress: 0,
  mediaError: "",
  mediaVideoUrl: "",
  appliedSyncVersion: 0,
  imageUrl: "",
  imageVersion: 0,
};

type SyncCommand =
  | "processing"
  | "prepare"
  | "play"
  | "pause"
  | "stop";

type SyncUpdate = {
  command: SyncCommand;
  targetAt?: number | null;
  videoUrl?: string | null;
  mediaTime?: number;
  timecodeRate?: TimecodeRateId;
  progress?: number;
  message?: string;
};

type CalibrationState = {
  mode: "off" | "live" | "freeze" | "manual";
  version: number;
  targetAt: number | null;
  commandSentAt: number | null;
};

type UploadedPart = {
  partNumber: number;
  etag: string;
};

type MultipartSession = {
  fingerprint: string;
  key: string;
  uploadId: string;
  partSize: number;
  parts: Record<string, UploadedPart>;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustDelayStats(samples: number[]) {
  const window = samples.slice(-21);
  const center = median(window);
  const deviation = median(window.map((value) => Math.abs(value - center)));
  const limit = Math.max(8, center * 0.35, deviation * 3);
  const stable = window.filter((value) => Math.abs(value - center) <= limit);
  const accepted = stable.length >= 3 ? stable : window;
  return {
    delay: Math.round(median(accepted)),
    jitter: accepted.length
      ? Math.round(Math.max(...accepted) - Math.min(...accepted))
      : 0,
  };
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getMediaContentType(file: File) {
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    return file.type;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mp4" || extension === "m4v") return "video/mp4";
  if (extension === "webm") return "video/webm";
  if (extension === "mov") return "video/quicktime";
  if (extension === "ogv") return "video/ogg";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "aac") return "audio/aac";
  if (extension === "wav") return "audio/wav";
  if (extension === "flac") return "audio/flac";
  if (extension === "ogg" || extension === "oga" || extension === "opus") {
    return "audio/ogg";
  }
  return null;
}

function getImageContentType(file: File) {
  if (file.type.startsWith("image/")) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return null;
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

function formatClock(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? totalSeconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatAbsoluteClock(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${[
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":")}:${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatSignedMilliseconds(value: number) {
  return `${value > 0 ? "+" : ""}${value}ms`;
}

function mediaStatusLabel(status: string) {
  return (
    {
      waiting: "等待视频",
      loading: "缓冲中",
      needs_action: "需点准备",
      ready: "已就绪",
      playing: "播放中",
      paused: "已暂停",
      stopped: "已停止",
      blocked: "播放受阻",
      error: "解码失败",
    }[status] ?? "未知"
  );
}

async function postSyncState(update: SyncUpdate) {
  const response = await fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetAt: null,
      videoUrl: null,
      mediaTime: 0,
      timecodeRate: DEFAULT_TIMECODE_RATE_ID,
      progress: 0,
      message: "",
      ...update,
    }),
  });
  if (!response.ok) throw new Error("同步状态发送失败");
  return (await response.json()) as {
    serverTime: number;
    sync: { version: number; targetAt: number | null };
  };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}

function fileFingerprint(file: File) {
  const source = `${file.name}|${file.size}|${file.lastModified}|${file.type}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}-${file.size}`;
}

function uploadPart(
  url: string,
  body: Blob,
  onProgress: (loadedBytes: number) => void,
) {
  return new Promise<UploadedPart>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.responseType = "text";
    request.upload.onprogress = (event) => {
      onProgress(event.loaded);
    };
    request.onerror = () => reject(new Error("视频传输连接失败"));
    request.onabort = () => reject(new Error("视频传输已取消"));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as UploadedPart);
        } catch {
          reject(new Error("分片上传响应无效"));
        }
        return;
      }
      reject(new Error(`视频分片上传失败（HTTP ${request.status}）`));
    };
    request.send(body);
  });
}

async function retryTransfer<T>(operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSFER_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < TRANSFER_RETRIES) {
        await wait(Math.min(5000, 350 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("视频传输多次重试后仍失败");
}

async function uploadVideoMultipart(
  file: File,
  contentType: string,
  onProgress: (progress: number) => void,
) {
  const fingerprint = fileFingerprint(file);
  const storageKey = `syncwall-multipart-${fingerprint}`;
  let session: MultipartSession | null = null;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as MultipartSession;
      if (
        parsed.fingerprint === fingerprint &&
        parsed.partSize === UPLOAD_PART_SIZE &&
        parsed.key.startsWith("videos/") &&
        parsed.uploadId
      ) {
        session = parsed;
      }
    }
  } catch {
    session = null;
  }

  if (!session) {
    const created = await retryTransfer(async () => {
      const response = await fetch("/api/video/upload?action=create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName: encodeURIComponent(file.name),
          contentType,
          fileSize: file.size,
        }),
      });
      if (!response.ok) {
        throw new Error(`无法创建分片上传（HTTP ${response.status}）`);
      }
      return (await response.json()) as {
        key: string;
        uploadId: string;
      };
    });
    session = {
      fingerprint,
      key: created.key,
      uploadId: created.uploadId,
      partSize: UPLOAD_PART_SIZE,
      parts: {},
    };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(session));
    } catch {
      // The current page can still resume failed parts even if storage is full.
    }
  }

  const currentSession = session;
  const partCount = Math.ceil(file.size / UPLOAD_PART_SIZE);
  const missingParts = Array.from({ length: partCount }, (_, index) => index + 1)
    .filter((partNumber) => !currentSession.parts[String(partNumber)]);
  let completedBytes = Object.values(currentSession.parts).reduce(
    (total, part) => {
      const start = (part.partNumber - 1) * UPLOAD_PART_SIZE;
      return total + Math.min(UPLOAD_PART_SIZE, file.size - start);
    },
    0,
  );
  const activeBytes = new Map<number, number>();
  const publishProgress = () => {
    const activeTotal = Array.from(activeBytes.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    onProgress(
      Math.min(100, ((completedBytes + activeTotal) / file.size) * 100),
    );
  };
  publishProgress();

  let cursor = 0;
  const uploadWorker = async () => {
    while (cursor < missingParts.length) {
      const partNumber = missingParts[cursor];
      cursor += 1;
      const start = (partNumber - 1) * UPLOAD_PART_SIZE;
      const end = Math.min(start + UPLOAD_PART_SIZE, file.size);
      const chunk = file.slice(start, end, contentType);
      const query = new URLSearchParams({
        action: "part",
        key: currentSession.key,
        uploadId: currentSession.uploadId,
        partNumber: String(partNumber),
      });
      const part = await retryTransfer(async () => {
        activeBytes.set(partNumber, 0);
        publishProgress();
        return uploadPart(
          `/api/video/upload?${query.toString()}`,
          chunk,
          (loadedBytes) => {
            activeBytes.set(partNumber, loadedBytes);
            publishProgress();
          },
        );
      });
      activeBytes.delete(partNumber);
      completedBytes += chunk.size;
      currentSession.parts[String(partNumber)] = part;
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(currentSession),
        );
      } catch {
        // Keep the in-memory session active.
      }
      publishProgress();
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(UPLOAD_CONCURRENCY, Math.max(1, missingParts.length)),
      },
      () => uploadWorker(),
    ),
  );
  const parts = Object.values(currentSession.parts).sort(
    (left, right) => left.partNumber - right.partNumber,
  );
  if (parts.length !== partCount) {
    throw new Error("部分视频分片缺失，请重新选择同一文件继续上传");
  }

  const finalVideoUrl = `/api/video?key=${encodeURIComponent(
    currentSession.key,
  )}`;
  let completed: { url?: string; error?: string };
  try {
    completed = await retryTransfer(async () => {
      const query = new URLSearchParams({
        action: "complete",
        key: currentSession.key,
        uploadId: currentSession.uploadId,
      });
      const response = await fetch(`/api/video/upload?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      });
      if (!response.ok) {
        throw new Error(`合并视频分片失败（HTTP ${response.status}）`);
      }
      return (await response.json()) as { url?: string; error?: string };
    });
  } catch (error) {
    const verification = await fetch(finalVideoUrl, {
      method: "HEAD",
      cache: "no-store",
    }).catch(() => null);
    if (!verification?.ok) throw error;
    completed = { url: finalVideoUrl };
  }
  if (!completed.url) {
    throw new Error(completed.error || "视频分片合并失败");
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // A completed upload no longer depends on local resume metadata.
  }
  onProgress(100);
  return completed.url;
}

function playTone(audioContext: AudioContext, time: number, pan: number) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 2400;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.48, time + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
  if (typeof audioContext.createStereoPanner === "function") {
    const panner = audioContext.createStereoPanner();
    panner.pan.value = pan;
    oscillator.connect(gain).connect(panner).connect(audioContext.destination);
  } else {
    oscillator.connect(gain).connect(audioContext.destination);
  }
  oscillator.start(time);
  oscillator.stop(time + 0.28);
}

export function SyncWallControl() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [playState, setPlayState] = useState<PlayState>("idle");
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopRound, setLoopRound] = useState(0);
  const [isDetecting, setIsDetecting] = useState(true);
  const [sampleTick, setSampleTick] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [targetTimestamp, setTargetTimestamp] = useState<number | null>(null);
  const [absoluteTargetAt, setAbsoluteTargetAt] = useState<number | null>(null);
  const [videoName, setVideoName] = useState("SYNCWALL_DEMO_01.mp4");
  const [videoSize, setVideoSize] = useState("184.6 MB");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(42);
  const [currentTime, setCurrentTime] = useState(0);
  const [timecodeRateId, setTimecodeRateId] = useState<TimecodeRateId>(
    DEFAULT_TIMECODE_RATE_ID,
  );
  const [timecodeDraft, setTimecodeDraft] = useState("00:00:00:00");
  const [isEditingTimecode, setIsEditingTimecode] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(100);
  const [pendingStopVersion, setPendingStopVersion] = useState<number | null>(
    null,
  );
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [toast, setToast] = useState("等待被控端连接");
  const [calibration, setCalibration] = useState<CalibrationState>({
    mode: "off",
    version: 0,
    targetAt: null,
    commandSentAt: null,
  });
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);
  const controlClockTextRef = useRef<HTMLElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timersRef = useRef<number[]>([]);
  const devicesRef = useRef<Device[]>([]);
  const playProbeInFlightRef = useRef(false);
  const manualProbeTimerRef = useRef<number | null>(null);
  const loopEnabledRef = useRef(false);
  const loopRestartTimerRef = useRef<number | null>(null);
  const restartLoopRef = useRef<() => void>(() => undefined);
  const loopRoundRef = useRef(0);
  const commandGenerationRef = useRef(0);
  const currentTimeRef = useRef(0);
  const cancelTimecodeEditRef = useRef(false);
  const durationRef = useRef(42);
  const playbackClockRef = useRef({
    mediaTime: 0,
    startedAt: 0,
  });
  const timecodeRate = useMemo(
    () => getTimecodeRate(timecodeRateId),
    [timecodeRateId],
  );

  useEffect(() => {
    let frame = 0;
    const updateClock = () => {
      if (controlClockTextRef.current) {
        controlClockTextRef.current.textContent = formatAbsoluteClock(Date.now());
      }
      frame = window.requestAnimationFrame(updateClock);
    };
    frame = window.requestAnimationFrame(updateClock);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const selectedDevice =
    devices.find((device) => device.id === selectedId) ??
    devices[0] ??
    emptyDevice;

  const maxJitter = devices.length
    ? Math.max(...devices.map((device) => device.jitter))
    : 0;
  const systemHealth = devices.length
    ? maxJitter <= 4
      ? "稳定"
      : maxJitter <= 8
        ? "良好"
        : "需检查"
    : "待连接";

  const updateTransportTime = useCallback(
    (requestedTime: number) => {
      const nextTime = clamp(
        Number.isFinite(requestedTime) ? requestedTime : 0,
        0,
        Math.max(0, durationRef.current),
      );
      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
      return nextTime;
    },
    [],
  );

  useEffect(() => {
    let savedRateId: string | null = null;
    try {
      savedRateId = window.localStorage.getItem(
        TIMECODE_RATE_STORAGE_KEY,
      );
    } catch {
      // A browser that blocks localStorage can still use the default 25 fps.
    }
    const savedRate = TIMECODE_RATES.find(
      (rate) => rate.id === savedRateId,
    );
    if (!savedRate) return;
    const timer = window.setTimeout(
      () => setTimecodeRateId(savedRate.id),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let stopped = false;
    const loadDevices = async () => {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });
        if (!response.ok) throw new Error("device list unavailable");
        const result = (await response.json()) as {
          devices: Array<{
            id: number;
            code: string;
            number: number;
            networkDelay: number;
            playbackDelay: number;
            clockAdjustmentMs: number;
            displayedClockAt: number | null;
            calibrationReportVersion: number;
            volumePercent: number;
            mediaStatus: string;
            mediaProgress: number;
            mediaError: string;
            mediaVideoUrl: string;
            appliedSyncVersion: number;
            imageUrl: string;
            imageVersion: number;
          }>;
          calibration: CalibrationState;
        };
        if (stopped) return;
        if (isDetecting) setSampleTick((tick) => tick + 1);
        setDevices((current) => {
          const nextDevices = result.devices.map((remote) => {
            const previous = current.find((device) => device.id === remote.id);
            const samples = isDetecting
              ? [
                  ...(previous?.samples ?? []).slice(-20),
                  remote.networkDelay,
                ]
              : (previous?.samples ?? [remote.networkDelay]);
            const delayStats = robustDelayStats(samples);
            return {
              id: remote.id,
              code: remote.code ?? "--",
              number: remote.number,
              name: `节点 ${String(remote.number).padStart(3, "0")}`,
              networkDelay: delayStats.delay,
              playbackDelay: remote.playbackDelay,
              clockAdjustmentMs: remote.clockAdjustmentMs ?? 0,
              displayedClockAt: remote.displayedClockAt ?? null,
              calibrationReportVersion:
                remote.calibrationReportVersion ?? 0,
              volumePercent: remote.volumePercent ?? 100,
              jitter: delayStats.jitter,
              samples,
              online: true,
              mediaStatus: remote.mediaStatus,
              mediaProgress: remote.mediaProgress ?? 0,
              mediaError: remote.mediaError,
              mediaVideoUrl: remote.mediaVideoUrl,
              appliedSyncVersion: remote.appliedSyncVersion ?? 0,
              imageUrl: remote.imageUrl ?? "",
              imageVersion: remote.imageVersion ?? 0,
            };
          });
          devicesRef.current = nextDevices;
          return nextDevices;
        });
        setCalibration(result.calibration);
        setSelectedId((current) =>
          result.devices.some((device) => device.id === current)
            ? current
            : (result.devices[0]?.id ?? 0),
        );
      } catch {
        if (!stopped) setToast("设备状态服务正在重连");
      }
    };
    void loadDevices();
    const timer = window.setInterval(
      loadDevices,
      isDetecting ? PING_INTERVAL_MS : 1000,
    );
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isDetecting]);

  const measureNetworkNow = useCallback(async () => {
    const response = await fetch(`/api/devices?probe=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("即时延迟检测失败");
    const result = (await response.json()) as {
      devices: Array<{ id: number; networkDelay: number }>;
    };
    const remoteDelays = new Map(
      result.devices.map((device) => [device.id, device.networkDelay]),
    );
    const nextDevices = devicesRef.current.map((device) => {
      const rawDelay = remoteDelays.get(device.id);
      if (rawDelay === undefined) return device;
      const samples = [...device.samples.slice(-20), rawDelay];
      const delayStats = robustDelayStats(samples);
      return {
        ...device,
        networkDelay: delayStats.delay,
        jitter: delayStats.jitter,
        samples,
      };
    });
    devicesRef.current = nextDevices;
    setDevices(nextDevices);
    setSampleTick((tick) => tick + 1);
    return nextDevices;
  }, []);

  useEffect(() => {
    if (pendingStopVersion === null) return;
    const acknowledged = devices.filter(
      (device) =>
        device.appliedSyncVersion >= pendingStopVersion &&
        device.mediaStatus !== "playing",
    ).length;
    const timer = window.setTimeout(() => {
      if (devices.length === 0 || acknowledged === devices.length) {
        setPendingStopVersion(null);
        setToast(
          devices.length
            ? `全部 ${devices.length} 台设备已确认停止`
            : "全部停止指令已保存；当前没有在线设备",
        );
        return;
      }
      setToast(
        `全部停止确认中：${acknowledged}/${devices.length} 台设备已停止`,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [devices, pendingStopVersion]);

  useEffect(() => {
    if (
      !videoUrl ||
      videoUrl.startsWith("blob:") ||
      phase === "processing"
    ) {
      return;
    }
    const updateDistributionState = (
      progress: number,
      nextPhase: Phase,
      message: string,
    ) => {
      const timer = window.setTimeout(() => {
        setUploadProgress(progress);
        setPhase(nextPhase);
        setToast(message);
      }, 0);
      return () => window.clearTimeout(timer);
    };
    if (devices.length === 0) {
      if (phase === "distributing") {
        return updateDistributionState(
          100,
          "ready",
          "视频处理完成；设备接入后会自动开始分发",
        );
      }
      return;
    }
    const progressValues = devices.map((device) =>
      device.mediaVideoUrl === videoUrl ? device.mediaProgress : 0,
    );
    const averageProgress = Math.round(
      progressValues.reduce((sum, value) => sum + value, 0) /
        progressValues.length,
    );
    const allDistributed = devices.every(
      (device) =>
        device.mediaVideoUrl === videoUrl &&
        device.mediaProgress >= 100 &&
        !["waiting", "loading", "error"].includes(device.mediaStatus),
    );
    if (allDistributed && phase !== "ready") {
      return updateDistributionState(
        averageProgress,
        "ready",
        `视频已完整分发到 ${devices.length} 台设备，可以开始同步播放`,
      );
    } else if (!allDistributed && phase === "ready") {
      return updateDistributionState(
        averageProgress,
        "distributing",
        `正在分发视频：设备平均进度 ${averageProgress}%`,
      );
    }
    const timer = window.setTimeout(
      () => setUploadProgress(averageProgress),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [devices, phase, videoUrl]);

  useEffect(() => {
    let stopped = false;
    void fetch("/api/sync", { cache: "no-store" })
      .then((response) => response.json())
      .then(
        (result: {
          sync?: {
            command?: string;
            videoUrl?: string | null;
            mediaTime?: number;
          };
        }) => {
          if (stopped || !result.sync?.videoUrl) return;
          setVideoUrl(result.sync.videoUrl);
          if (result.sync.command === "pause") {
            updateTransportTime((result.sync.mediaTime ?? 0) / 1000);
            setPlayState("paused");
          }
        },
      )
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [updateTransportTime]);

  useEffect(() => {
    if (targetTimestamp === null || playState !== "scheduled") return;

    let frame = 0;
    const updateCountdown = () => {
      const left = Math.max(0, targetTimestamp - performance.now());
      setCountdown(left);
      if (left > 0) {
        frame = window.requestAnimationFrame(updateCountdown);
      } else {
        setPlayState("playing");
        setToast("所有设备已跨过统一播放时刻");
      }
    };
    frame = window.requestAnimationFrame(updateCountdown);
    return () => window.cancelAnimationFrame(frame);
  }, [playState, targetTimestamp]);

  useEffect(() => {
    if (playState !== "playing") return;
    let animationFrame = 0;
    const updatePlaybackClock = () => {
      const elapsedSeconds =
        (performance.now() - playbackClockRef.current.startedAt) / 1000;
      const nextTime =
        playbackClockRef.current.mediaTime + Math.max(0, elapsedSeconds);
      if (nextTime >= duration) {
        const shouldRestart = loopEnabledRef.current;
        currentTimeRef.current = 0;
        setCurrentTime(0);
        setTargetTimestamp(null);
        setAbsoluteTargetAt(null);
        setPlayState("idle");
        videoRefs.current.forEach((video) => {
          if (video) {
            video.pause();
            video.currentTime = 0;
          }
        });
        if (shouldRestart) {
          setToast("本轮播放结束，控制端正在生成下一轮绝对播放时刻");
          loopRestartTimerRef.current = window.setTimeout(() => {
            loopRestartTimerRef.current = null;
            restartLoopRef.current();
          }, 120);
        }
        return;
      }
      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
      animationFrame = window.requestAnimationFrame(updatePlaybackClock);
    };
    animationFrame = window.requestAnimationFrame(updatePlaybackClock);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [duration, playState]);

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      if (manualProbeTimerRef.current) {
        window.clearTimeout(manualProbeTimerRef.current);
      }
      if (loopRestartTimerRef.current) {
        window.clearTimeout(loopRestartTimerRef.current);
      }
      if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    },
    [videoUrl],
  );

  const scheduleDevicePlayback = useCallback(
    (
      slot: number,
      mediaTime: number,
      remainingUntilTarget: number,
    ) => {
      const playTimer = window.setTimeout(() => {
        const video = videoRefs.current[slot];
        if (video && videoUrl) {
          video.currentTime = mediaTime;
          void video.play().catch(() => undefined);
        }
      }, Math.max(0, remainingUntilTarget));
      timersRef.current.push(playTimer);
    },
    [videoUrl],
  );

  const broadcastSync = async (
    command: "play" | "pause" | "stop",
    targetAt: number | null = null,
    mediaTime = currentTimeRef.current,
  ) => {
    const sharedVideoUrl =
      videoUrl && !videoUrl.startsWith("blob:") ? videoUrl : null;
    return postSyncState({
        command,
        targetAt,
        videoUrl: sharedVideoUrl,
        mediaTime: Math.round(mediaTime * 1000),
        timecodeRate: timecodeRateId,
        progress: 100,
        message:
          command === "stop"
            ? "控制端要求全部设备立即停止"
            : "",
    });
  };

  const handlePlay = async (isLoopRestart = false) => {
    const requestGeneration = commandGenerationRef.current;
    if (devices.length === 0) {
      setToast("当前没有在线设备，无法开始播放");
      return;
    }
    if (phase !== "ready") {
      setToast("请等待音视频处理和分发完成");
      return;
    }

    if (playState === "playing" && !isLoopRestart) {
      const pausedAt = updateTransportTime(
        playbackClockRef.current.mediaTime +
          Math.max(
            0,
            (performance.now() - playbackClockRef.current.startedAt) / 1000,
          ),
      );
      videoRefs.current.forEach((video) => video?.pause());
      setTargetTimestamp(null);
      setAbsoluteTargetAt(null);
      setPlayState("paused");
      void broadcastSync("pause", null, pausedAt).catch(() =>
        setToast("暂停指令发送失败，请重试"),
      );
      setToast("已向全部设备发送暂停指令");
      return;
    }
    if (!videoUrl || videoUrl.startsWith("blob:")) {
      setToast("请先上传并完成音视频分发");
      return;
    }
    const unreadyDevices = devices.filter(
      (device) =>
        device.mediaVideoUrl !== videoUrl ||
        !["ready", "paused", "stopped", "playing"].includes(
          device.mediaStatus,
        ),
    );
    if (unreadyDevices.length) {
      setToast(
        `设备 ${unreadyDevices.map((device) => device.number).join("、")} 尚未就绪，请在对应屏幕点击准备或查看错误`,
      );
      return;
    }

    if (playProbeInFlightRef.current) return;
    playProbeInFlightRef.current = true;
    setToast("正在测量即时延迟，并下发统一绝对播放时刻");
    void measureNetworkNow()
      .catch(() => undefined)
      .finally(() => {
        playProbeInFlightRef.current = false;
      });
    const requestedTargetAt = Date.now() + PLAYBACK_TARGET_LEAD_MS;

    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    const startMediaTime = isLoopRestart ? 0 : currentTimeRef.current;
    if (isLoopRestart) updateTransportTime(0);
    let playCommand: Awaited<ReturnType<typeof broadcastSync>>;
    try {
      playCommand = await broadcastSync(
        "play",
        requestedTargetAt,
        startMediaTime,
      );
    } catch {
      setToast(
        isLoopRestart
          ? "下一轮播放命令发送失败，500ms 后重试"
          : "播放指令发送失败，请重试",
      );
      if (isLoopRestart && loopEnabledRef.current) {
        loopRestartTimerRef.current = window.setTimeout(() => {
          loopRestartTimerRef.current = null;
          restartLoopRef.current();
        }, 500);
      }
      return;
    }
    if (requestGeneration !== commandGenerationRef.current) {
      void broadcastSync("stop", null, 0).catch(() => undefined);
      return;
    }
    const targetAt = playCommand.sync.targetAt;
    if (!targetAt) {
      setToast("主机未返回播放目标时刻，请重试");
      return;
    }
    const remainingUntilTarget = Math.max(
      0,
      targetAt - playCommand.serverTime,
    );
    const target = performance.now() + remainingUntilTarget;
    playbackClockRef.current = {
      mediaTime: startMediaTime,
      startedAt: target,
    };
    setTargetTimestamp(target);
    setAbsoluteTargetAt(targetAt);
    setCountdown(remainingUntilTarget);
    setPlayState("scheduled");
    setPendingStopVersion(null);
    loopRoundRef.current = isLoopRestart ? loopRoundRef.current + 1 : 1;
    setLoopRound(loopRoundRef.current);
    devicesRef.current.forEach((_, slot) =>
      scheduleDevicePlayback(
        slot,
        startMediaTime,
        remainingUntilTarget,
      ),
    );
    setToast(
      `${
        loopEnabledRef.current ? `循环第 ${loopRoundRef.current} 轮：` : ""
      }当主机校准时间到达 ${formatAbsoluteClock(targetAt)} 时开始播放`,
    );
  };

  useEffect(() => {
    restartLoopRef.current = () => {
      if (!loopEnabledRef.current) return;
      if (playProbeInFlightRef.current) {
        loopRestartTimerRef.current = window.setTimeout(() => {
          loopRestartTimerRef.current = null;
          restartLoopRef.current();
        }, 200);
        return;
      }
      void handlePlay(true);
    };
  });

  const stopPlayback = async () => {
    commandGenerationRef.current += 1;
    if (loopRestartTimerRef.current) {
      window.clearTimeout(loopRestartTimerRef.current);
      loopRestartTimerRef.current = null;
    }
    loopRoundRef.current = 0;
    setLoopRound(0);
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    videoRefs.current.forEach((video) => {
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
    });
    setTargetTimestamp(null);
    setAbsoluteTargetAt(null);
    setCountdown(0);
    playbackClockRef.current = { mediaTime: 0, startedAt: 0 };
    updateTransportTime(0);
    setPlayState("idle");
    setToast("正在向全部设备发送强制停止并等待确认");
    try {
      const result = await broadcastSync("stop", null, 0);
      setPendingStopVersion(result.sync.version);
    } catch {
      setPendingStopVersion(null);
      setToast("全部停止指令发送失败，请再次点击");
    }
  };

  const seekToFrame = useCallback(
    (requestedFrame: number, announce = false) => {
      const frame = clampFrameToDuration(
        requestedFrame,
        duration,
        timecodeRate,
      );
      const nextTime = updateTransportTime(
        frameToSeconds(frame, timecodeRate),
      );
      videoRefs.current.forEach((video) => {
        if (!video) return;
        video.pause();
        try {
          video.currentTime = nextTime;
        } catch {
          // Metadata can briefly be unavailable while a new source is attached.
        }
      });
      const normalizedTimecode = formatFrameTimecode(frame, timecodeRate);
      setTimecodeDraft(normalizedTimecode);
      if (announce) setToast(`已定位到 ${normalizedTimecode}`);
      return frame;
    },
    [duration, timecodeRate, updateTransportTime],
  );

  const stepTimecodeFrame = (direction: -1 | 1) => {
    const currentFrame = secondsToFrame(
      currentTimeRef.current,
      timecodeRate,
    );
    seekToFrame(currentFrame + direction, true);
  };

  const commitTimecode = (value: string) => {
    setIsEditingTimecode(false);
    const requestedFrame = parseTimecode(value, timecodeRate);
    if (requestedFrame === null) {
      const restored = formatTimecode(currentTimeRef.current, timecodeRate);
      setTimecodeDraft(restored);
      setToast(
        `时间码无效，请使用 ${timecodeRate.dropFrames ? "HH:MM:SS;FF" : "HH:MM:SS:FF"}`,
      );
      return;
    }
    const frame = seekToFrame(requestedFrame);
    if (frame !== requestedFrame) {
      setToast(
        `输入超出素材长度，已定位到 ${formatFrameTimecode(frame, timecodeRate)}`,
      );
    } else {
      setToast(`已定位到 ${formatFrameTimecode(frame, timecodeRate)}`);
    }
  };

  const changeTimecodeRate = (requestedRateId: string) => {
    const nextRate = getTimecodeRate(requestedRateId);
    setTimecodeRateId(nextRate.id);
    setTimecodeDraft(formatTimecode(currentTimeRef.current, nextRate));
    try {
      window.localStorage.setItem(
        TIMECODE_RATE_STORAGE_KEY,
        nextRate.id,
      );
    } catch {
      // The selection remains active for this session when storage is blocked.
    }
    const sharedVideoUrl =
      videoUrl && !videoUrl.startsWith("blob:") ? videoUrl : null;
    const command = playState === "paused" ? "pause" : "stop";
    const mediaTime =
      playState === "paused" ? currentTimeRef.current : 0;
    void postSyncState({
      command,
      targetAt: null,
      videoUrl: sharedVideoUrl,
      mediaTime: Math.round(mediaTime * 1000),
      timecodeRate: nextRate.id,
      progress: 100,
      message: "时间码帧率已同步到全部设备",
    }).catch(() => setToast("时间码帧率同步失败，请重试"));
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const contentType = getMediaContentType(file);
    if (!contentType) {
      setToast("请选择常见视频或音频文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024 * 1024) {
      setToast("单个音视频文件不能超过 5GB");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    setVideoUrl(objectUrl);
    setVideoName(file.name);
    setVideoSize(formatBytes(file.size));
    setPhase("processing");
    setPlayState("idle");
    setPendingStopVersion(null);
    setTargetTimestamp(null);
    playbackClockRef.current = { mediaTime: 0, startedAt: 0 };
    updateTransportTime(0);
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    videoRefs.current.forEach((video) => video?.pause());

    let stageProgress = 2;
    let lastPublishedProgress = -1;
    let lastPublishedAt = 0;
    let publishQueue: Promise<unknown> = Promise.resolve();
    const updateProcessingProgress = (
      requestedProgress: number,
      message: string,
      force = false,
    ) => {
      stageProgress = Math.max(
        stageProgress,
        Math.min(99, Math.round(requestedProgress)),
      );
      setUploadProgress(stageProgress);
      setToast(message);
      const now = Date.now();
      if (
        force ||
        stageProgress - lastPublishedProgress >= 3 ||
        now - lastPublishedAt >= 600
      ) {
        lastPublishedProgress = stageProgress;
        lastPublishedAt = now;
        publishQueue = publishQueue
          .catch(() => undefined)
          .then(() =>
            postSyncState({
              command: "processing",
              timecodeRate: timecodeRateId,
              progress: stageProgress,
              message,
            }),
          );
      }
    };
    updateProcessingProgress(
      2,
      "控制端正在准备上传音视频",
      true,
    );

    try {
      const uploadedVideoUrl = await uploadVideoMultipart(
        file,
        contentType,
        (progress) =>
          updateProcessingProgress(
            2 + progress * 0.93,
            `正在并发上传音视频 ${Math.round(progress)}%（支持断点续传）`,
          ),
      );
      updateProcessingProgress(
        95,
        "音视频上传完成，正在通知被控端接收并处理",
        true,
      );
      await publishQueue;
      URL.revokeObjectURL(objectUrl);
      setVideoUrl(uploadedVideoUrl);
      setPhase(devices.length ? "distributing" : "ready");
      setUploadProgress(devices.length ? 0 : 100);
      setToast(
        devices.length
          ? `正在向 ${devices.length} 台设备分发音视频并等待本机处理`
          : "音视频已保存，等待被控设备接入",
      );
      await postSyncState({
          command: "prepare",
          targetAt: null,
          videoUrl: uploadedVideoUrl,
          mediaTime: 0,
          timecodeRate: timecodeRateId,
          progress: 100,
          message: "音视频上传完成，正在由各被控端接收并处理",
      });
    } catch (error) {
      setPhase("ready");
      setUploadProgress(0);
      const message =
        error instanceof Error ? error.message : "音视频上传或分发失败，请重试";
      setToast(message);
      void postSyncState({
        command: "stop",
        timecodeRate: timecodeRateId,
        progress: 0,
        message,
      }).catch(() => undefined);
    }
  };

  const updatePlaybackDelay = (value: number) => {
    if (!selectedDevice.online) return;
    const nextValue = clamp(
      value,
      -MAX_PLAYBACK_DELAY_MS,
      MAX_PLAYBACK_DELAY_MS,
    );
    setDevices((current) => {
      const nextDevices = current.map((device) =>
        device.id === selectedId
          ? { ...device, playbackDelay: nextValue }
          : device,
      );
      devicesRef.current = nextDevices;
      return nextDevices;
    });
    void fetch("/api/devices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: selectedId,
        playbackDelayMs: nextValue,
      }),
    });
    if (manualProbeTimerRef.current) {
      window.clearTimeout(manualProbeTimerRef.current);
    }
    manualProbeTimerRef.current = window.setTimeout(() => {
      void measureNetworkNow().catch(() =>
        setToast("手动延迟已保存；即时网络检测失败，将继续自动重试"),
      );
    }, 60);
  };

  const updateVolume = (value: number) => {
    if (!selectedDevice.online) return;
    const nextValue = clamp(Math.round(value), 0, 100);
    setDevices((current) => {
      const nextDevices = current.map((device) =>
        device.id === selectedId
          ? { ...device, volumePercent: nextValue }
          : device,
      );
      devicesRef.current = nextDevices;
      return nextDevices;
    });
    void fetch("/api/devices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: selectedId,
        volumePercent: nextValue,
      }),
    });
  };

  const handleDeviceImage = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !selectedDevice.online) {
      setToast("请先选择一台在线设备");
      return;
    }
    const contentType = getImageContentType(file);
    if (!contentType) {
      setToast("请选择 JPG、PNG、WebP 或 GIF 图片");
      input.value = "";
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setToast("单张图片不能超过 50MB");
      input.value = "";
      return;
    }
    const targetId = selectedDevice.id;
    const targetCode = selectedDevice.code;
    try {
      const imageUrl = await uploadVideoMultipart(
        file,
        contentType,
        (progress) =>
          setToast(`正在向设备 ${targetCode} 上传图片 ${Math.round(progress)}%`),
      );
      const response = await fetch("/api/devices/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: targetId, imageUrl }),
      });
      if (!response.ok) throw new Error("设备图片发送失败");
      setDevices((current) =>
        current.map((device) =>
          device.id === targetId ? { ...device, imageUrl } : device,
        ),
      );
      setToast(`图片已发送到设备 ${targetCode}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "图片发送失败，请重试");
    } finally {
      input.value = "";
    }
  };

  const clearDeviceImage = async () => {
    if (!selectedDevice.online) return;
    const targetId = selectedDevice.id;
    const targetCode = selectedDevice.code;
    const response = await fetch("/api/devices/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: targetId, imageUrl: "" }),
    });
    if (!response.ok) {
      setToast(`设备 ${targetCode} 图片清除失败`);
      return;
    }
    setDevices((current) =>
      current.map((device) =>
        device.id === targetId ? { ...device, imageUrl: "" } : device,
      ),
    );
    setToast(`已清除设备 ${targetCode} 的图片`);
  };

  const handleDing = async () => {
    if (!selectedDevice.online) {
      setToast("请先选择一台在线设备");
      return;
    }
    const AudioContextClass =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextClass) {
      setToast("当前浏览器不支持音频校准");
      return;
    }
    const context =
      audioContextRef.current ?? new AudioContextClass({ latencyHint: "interactive" });
    audioContextRef.current = context;
    if (context.state === "suspended") await context.resume();
    const requestStartedAt = performance.now();
    try {
      const response = await fetch("/api/devices/ding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: selectedDevice.id,
        }),
      });
      if (!response.ok) throw new Error("ding command failed");
      const result = (await response.json()) as {
        serverTime: number;
        ding: { targetAt: number | null };
      };
      const requestRtt = performance.now() - requestStartedAt;
      const estimatedServerNow = result.serverTime + requestRtt / 2;
      const localWaitSeconds =
        Math.max(
          0,
          (result.ding.targetAt ?? estimatedServerNow) - estimatedServerNow,
        ) / 1000;
      const start = context.currentTime + localWaitSeconds;
      playTone(context, start, -0.7);
      playTone(context, start, 0.7);
      setToast(
        `设备 ${selectedDevice.number} 校准叮声：${CALIBRATION_SAFETY_WINDOW_MS}ms 校准窗口，网络 ${selectedDevice.networkDelay}ms`,
      );
    } catch {
      setToast(`设备 ${selectedDevice.number} 已离线，校准音未发送`);
    }
  };

  const sendCalibrationCommand = async (
    command: "start" | "show" | "freeze" | "auto" | "manual" | "exit",
  ) => {
    try {
      const response = await fetch("/api/calibration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const result = (await response.json()) as {
        error?: string;
        adjusted?: number;
        calibration?: CalibrationState;
      };
      if (!response.ok || !result.calibration) {
        throw new Error(result.error || "校准指令发送失败");
      }
      setCalibration(result.calibration);
      const labels = {
        start: `已让 ${devicesRef.current.length} 台设备进入校准页面`,
        show: "所有设备恢复显示实时时间码",
        freeze: "已下发静止时间指令；设备将在统一目标时刻冻结",
        auto: `自动校准完成：已修正 ${result.adjusted ?? 0} 台设备的独立时钟`,
        manual: "已进入手动校准；请在各被控端以 1ms 微调",
        exit: "所有设备已返回视频播放页面",
      };
      setToast(labels[command]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "校准指令发送失败");
    }
  };

  const updateDeviceClock = async (deviceId: number, value: number) => {
    const next = Math.max(-60000, Math.min(60000, Math.round(value)));
    setDevices((current) => {
      const updated = current.map((device) =>
        device.id === deviceId
          ? { ...device, clockAdjustmentMs: next }
          : device,
      );
      devicesRef.current = updated;
      return updated;
    });
    await fetch("/api/calibration/device", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: deviceId, clockAdjustmentMs: next }),
    }).catch(() => undefined);
  };

  const moveDevice = (id: number, direction: -1 | 1) => {
    const index = devices.findIndex((device) => device.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= devices.length) return;
    const copy = [...devices];
    [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]];
    setDevices(copy);
    void fetch("/api/devices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: copy.map((device) => device.id) }),
    });
  };

  const handleDrop = (targetId: number) => {
    if (draggedId === null || draggedId === targetId) return;
    const sourceIndex = devices.findIndex((device) => device.id === draggedId);
    const targetIndex = devices.findIndex((device) => device.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const copy = [...devices];
    const [moved] = copy.splice(sourceIndex, 1);
    copy.splice(targetIndex, 0, moved);
    setDevices(copy);
    void fetch("/api/devices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: copy.map((device) => device.id) }),
    });
    setDraggedId(null);
  };

  const sharedVideoReadyDevices =
    videoUrl && !videoUrl.startsWith("blob:")
      ? devices.filter(
          (device) =>
            device.mediaVideoUrl === videoUrl &&
            ["ready", "paused", "stopped", "playing"].includes(
              device.mediaStatus,
            ),
        ).length
      : 0;
  const phaseLabel = {
    ready: devices.length
      ? sharedVideoReadyDevices === devices.length
        ? "全部就绪"
        : `${sharedVideoReadyDevices}/${devices.length} 就绪`
      : "等待连接",
    processing: `音视频上传 ${uploadProgress}%`,
    distributing: `正在分发 ${uploadProgress}%`,
  }[phase];

  const maximumSeekFrame = getMaximumSeekFrame(duration, timecodeRate);
  const currentFrame = clampFrameToDuration(
    secondsToFrame(currentTime, timecodeRate),
    duration,
    timecodeRate,
  );
  const progressPercent = duration
    ? Math.min(100, (currentTime / duration) * 100)
    : 0;
  const transportIsLocked =
    playState === "playing" || playState === "scheduled";
  const timecodeControlsDisabled =
    transportIsLocked || phase !== "ready" || !videoUrl;
  const displayedTimecode = isEditingTimecode
    ? timecodeDraft
    : formatTimecode(currentTime, timecodeRate);
  const isAudioMedia = isAudioSource(videoUrl);
  const selectedMaxAdvance = MAX_PLAYBACK_DELAY_MS;

  const delayBars = useMemo(
    () =>
      selectedDevice.samples.slice(-15).map((sample, index) => ({
        value: sample,
        height: clamp(16 + (sample - 20) * 0.9, 18, 58),
        key: `${sampleTick}-${index}`,
      })),
    [sampleTick, selectedDevice.samples],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>SYNCWALL</strong>
            <span>毫秒级多屏音视频同步</span>
          </div>
        </div>
        <div className="top-status">
          <span className={`status-dot ${isDetecting ? "pulse" : ""}`} />
          延迟检测 {isDetecting ? "运行中 · 10次/秒" : "已暂停"}
        </div>
        <button className="ghost-button" type="button" onClick={() => setIsDetecting(!isDetecting)}>
          {isDetecting ? "暂停检测" : "继续检测"}
        </button>
      </header>

      <section className="hero-strip" aria-label="同步状态">
        <div>
          <span className="eyebrow">LIVE CONTROL / ROOM A-01</span>
          <h1>
            {devices.length} 屏同步控制台
            <span className="ready-pill">
              <b />
              {phaseLabel}
            </span>
          </h1>
        </div>
        <div className="hero-metrics">
          <div>
            <span>绝对播放提前量</span>
            <strong>{PLAYBACK_TARGET_LEAD_MS}</strong>
            <small>ms</small>
          </div>
          <div>
            <span>最大抖动</span>
            <strong>{maxJitter}</strong>
            <small>ms</small>
          </div>
          <div>
            <span>在线设备</span>
            <strong>{devices.length}</strong>
            <small>/ {MAX_DEVICES}</small>
          </div>
          <div>
            <span>同步健康度</span>
            <strong className="health-value">{systemHealth}</strong>
          </div>
        </div>
      </section>

      <section className={`calibration-console ${calibration.mode}`}>
        <div className="calibration-console-heading">
          <div>
            <span className="eyebrow">DUAL CLOCK CALIBRATION</span>
            <h2>双重毫秒时间校准</h2>
            <p>先自动冻结并修正独立设备时钟，再根据同一张照片在被控端手动微调；不会改动播放延迟。</p>
          </div>
          <div className="control-clock-readout">
            <span>控制端浏览器校准时间</span>
            <strong ref={controlClockTextRef}>00:00:00.000</strong>
          </div>
        </div>
        <div className="calibration-actions">
          <button type="button" onClick={() => void sendCalibrationCommand("start")}>
            开始校准
          </button>
          <button
            type="button"
            disabled={calibration.mode === "off"}
            onClick={() => void sendCalibrationCommand("show")}
          >
            显示时间码
          </button>
          <button
            type="button"
            disabled={calibration.mode === "off"}
            onClick={() => void sendCalibrationCommand("freeze")}
          >
            静止时间
          </button>
          <button
            type="button"
            disabled={calibration.targetAt === null}
            onClick={() => void sendCalibrationCommand("auto")}
          >
            自动校准
          </button>
          <button
            type="button"
            disabled={calibration.mode === "off"}
            onClick={() => void sendCalibrationCommand("manual")}
          >
            手动校准
          </button>
          <button
            className="calibration-exit"
            type="button"
            disabled={calibration.mode === "off"}
            onClick={() => void sendCalibrationCommand("exit")}
          >
            返回播放
          </button>
        </div>
        {calibration.mode !== "off" && (
          <div className="calibration-session">
            <div className="calibration-reference">
              <div>
                <span>指令发送时间</span>
                <strong>{calibration.commandSentAt ? formatAbsoluteClock(calibration.commandSentAt) : "----/--/-- --:--:--:---"}</strong>
              </div>
              <div>
                <span>统一静止目标（2000ms 安全时长）</span>
                <strong>{calibration.targetAt ? formatAbsoluteClock(calibration.targetAt) : "等待静止指令"}</strong>
              </div>
              <div>
                <span>已回传设备</span>
                <strong>
                  {devices.filter((device) =>
                    device.calibrationReportVersion === calibration.version &&
                    device.displayedClockAt !== null,
                  ).length}/{devices.length}
                </strong>
              </div>
            </div>
            <div className="calibration-device-grid">
              {devices.map((device) => {
                const reported =
                  device.calibrationReportVersion === calibration.version
                    ? device.displayedClockAt
                    : null;
                const difference =
                  reported !== null && calibration.targetAt !== null
                    ? reported - calibration.targetAt
                    : null;
                return (
                  <article key={device.id}>
                    <header>
                      <strong>设备 {device.code}</strong>
                      <span>
                        {device.networkDelay}ms 网络 · 收到后等待{" "}
                        {Math.max(0, CALIBRATION_SAFETY_WINDOW_MS - device.networkDelay)}ms
                      </span>
                    </header>
                    <div className="device-reported-clock">
                      <span>当前显示时间</span>
                      <strong>{reported === null ? "等待回传" : formatAbsoluteClock(reported)}</strong>
                      <small className={difference === 0 ? "exact" : ""}>
                        {difference === null
                          ? "尚未静止"
                          : difference === 0
                            ? "与控制端完全一致"
                            : `相差 ${formatSignedMilliseconds(difference)}`}
                      </small>
                    </div>
                    <label>
                      <span>独立时钟修正</span>
                      <input
                        type="number"
                        min="-60000"
                        max="60000"
                        step="1"
                        value={device.clockAdjustmentMs}
                        onChange={(event) =>
                          void updateDeviceClock(device.id, Number(event.currentTarget.value))
                        }
                      />
                      <b>ms</b>
                    </label>
                    <small>校准音补偿保持 {formatSignedMilliseconds(device.playbackDelay)}，不参与视频播放</small>
                  </article>
                );
              })}
              {devices.length === 0 && <p className="calibration-empty">暂无在线设备</p>}
            </div>
          </div>
        )}
      </section>

      <section className="workspace-grid">
        <div className="stage-panel">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <div>
                <h2>屏幕编排与画面预览</h2>
                <p>拖动设备卡片调整从左到右的实际位置</p>
              </div>
            </div>
            <div className="stage-actions">
              <div className={`connection-chip ${devices.length ? "online" : ""}`}>
                <i />
                {devices.length
                  ? `${devices.length} 台被控端在线`
                  : "等待被控端连接"}
              </div>
              <label className="upload-button">
                <input
                  type="file"
                  accept="video/*,audio/*"
                  onChange={handleUpload}
                />
                <span aria-hidden="true">↑</span>
                上传音频/视频
              </label>
            </div>
          </div>

          <div
            className={`screen-wall ${devices.length > 12 ? "dense" : ""}`}
            aria-label={`${devices.length} 台设备预览`}
            style={{
              gridTemplateColumns:
                devices.length === 0
                  ? "1fr"
                  : devices.length <= 8
                  ? `repeat(${devices.length}, minmax(0, 1fr))`
                  : `repeat(${devices.length}, minmax(92px, 1fr))`,
            }}
          >
            {devices.length === 0 && (
              <div className="empty-device-wall">
                <span className="empty-radar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>尚无被控端在线</strong>
                <p>在其他设备访问本站任意非控制端地址后，将自动出现在这里。</p>
              </div>
            )}
            {devices.map((device, slot) => (
              <article
                className={`device-screen ${
                  selectedId === device.id ? "selected" : ""
                } ${draggedId === device.id ? "dragging" : ""}`}
                key={device.id}
                draggable
                onDragStart={() => setDraggedId(device.id)}
                onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()}
                onDrop={() => handleDrop(device.id)}
                onClick={() => setSelectedId(device.id)}
              >
                <div className="screen-header">
                  <span>设备 {device.code} · 位置 {device.number}</span>
                  <b>
                    <i />
                    {device.networkDelay}ms
                  </b>
                </div>
                <div className="video-window">
                  {videoUrl && devices.length <= 16 ? (
                    <video
                      ref={(node) => {
                        videoRefs.current[slot] = node;
                      }}
                      src={videoUrl}
                      muted
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={(event) => {
                        if (event.currentTarget.duration) {
                          const loadedDuration = event.currentTarget.duration;
                          durationRef.current = loadedDuration;
                          setDuration(loadedDuration);
                          if (currentTimeRef.current > loadedDuration) {
                            currentTimeRef.current = 0;
                            setCurrentTime(0);
                          }
                        }
                      }}
                      style={{
                        left: 0,
                        width: isAudioMedia
                          ? "100%"
                          : `${devices.length * 100}%`,
                        opacity: isAudioMedia ? 0 : 1,
                        transform: isAudioMedia
                          ? "none"
                          : `translate3d(-${
                              (slot / devices.length) * 100
                            }%, 0, 0)`,
                      }}
                    />
                  ) : (
                    <div
                      className="demo-film"
                      style={{
                        left: `${slot * -100}%`,
                        width: `${devices.length * 100}%`,
                      }}
                      aria-label={`视频第 ${slot + 1} 段`}
                    >
                      <span>SYNC</span>
                      <span>WALL</span>
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  {isAudioMedia && videoUrl && (
                    <div className="audio-media-visual" aria-label="同步音频">
                      <strong>AUDIO</strong>
                      <span>{playState === "playing" ? "同步播放中" : "音频已就绪"}</span>
                    </div>
                  )}
                  {device.imageUrl && (
                    <img
                      className="target-device-image"
                      src={device.imageUrl}
                      alt={`设备 ${device.code} 指定图片`}
                    />
                  )}
                  {(phase === "processing" ||
                    (videoUrl &&
                      !videoUrl.startsWith("blob:") &&
                      (device.mediaVideoUrl !== videoUrl ||
                        device.mediaProgress < 100))) && (
                    <div className="screen-transfer-progress">
                      <strong>
                        {phase === "processing"
                          ? uploadProgress
                          : device.mediaVideoUrl === videoUrl
                            ? device.mediaProgress
                            : 0}
                        %
                      </strong>
                      <span>
                        {phase === "processing"
                          ? "音视频上传中"
                          : "音视频分发中"}
                      </span>
                      <div>
                        <i
                          style={{
                            width: `${
                              phase === "processing"
                                ? uploadProgress
                                : device.mediaVideoUrl === videoUrl
                                  ? device.mediaProgress
                                  : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                  <span className="slice-label">
                    {slot + 1}/{devices.length}
                  </span>
                  {playState === "scheduled" && (
                    <div className="screen-countdown">
                      <strong>
                        {absoluteTargetAt
                          ? formatAbsoluteClock(absoluteTargetAt)
                          : "--:--:--.---"}
                      </strong>
                      <small>剩余 {(countdown / 1000).toFixed(3)}s</small>
                    </div>
                  )}
                </div>
                <div className="device-footer">
                  <span>位置 {slot + 1} · {device.name}</span>
                  <span className="reorder-buttons">
                    <button
                      type="button"
                      aria-label={`设备 ${device.number} 左移`}
                      disabled={slot === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        moveDevice(device.id, -1);
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={`设备 ${device.number} 右移`}
                      disabled={slot === devices.length - 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        moveDevice(device.id, 1);
                      }}
                    >
                      →
                    </button>
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="media-card">
            <div className="media-icon" aria-hidden="true">
              <span />
            </div>
            <div className="media-meta">
              <strong>{videoName}</strong>
              <span>
                {videoSize} · {formatClock(duration)} ·{" "}
                {isAudioMedia ? "全设备同步音频" : `${devices.length} 段动态视口`}
              </span>
            </div>
            <div className="media-state">
              <span>{phaseLabel}</span>
              <div>
                <i style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          </div>

          <div className="timeline-card timecode-card">
            <div className="timeline-timecode">
              <label htmlFor="current-timecode">当前时间码</label>
              <input
                id="current-timecode"
                aria-label="当前时间码"
                spellCheck={false}
                value={displayedTimecode}
                disabled={timecodeControlsDisabled}
                onFocus={() => {
                  setTimecodeDraft(
                    formatTimecode(currentTimeRef.current, timecodeRate),
                  );
                  setIsEditingTimecode(true);
                }}
                onChange={(event) => setTimecodeDraft(event.target.value)}
                onBlur={(event) => {
                  if (cancelTimecodeEditRef.current) {
                    cancelTimecodeEditRef.current = false;
                    setIsEditingTimecode(false);
                    return;
                  }
                  commitTimecode(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTimecodeEditRef.current = true;
                    setTimecodeDraft(
                      formatTimecode(currentTimeRef.current, timecodeRate),
                    );
                    event.currentTarget.blur();
                  }
                }}
              />
              <span>
                / {formatTimecode(duration, timecodeRate)}
              </span>
            </div>

            <div className="timecode-transport">
              <button
                type="button"
                aria-label="后退一帧"
                disabled={timecodeControlsDisabled || currentFrame <= 0}
                onClick={() => stepTimecodeFrame(-1)}
              >
                −1
                <span>帧</span>
              </button>
              <div className="timeline-track">
                <i style={{ width: `${progressPercent}%` }} />
                <b style={{ left: `${progressPercent}%` }} />
                <input
                  type="range"
                  min="0"
                  max={maximumSeekFrame}
                  step="1"
                  value={currentFrame}
                  disabled={timecodeControlsDisabled}
                  aria-label="时间码定位滑块"
                  onChange={(event) =>
                    seekToFrame(Number(event.currentTarget.value))
                  }
                />
              </div>
              <button
                type="button"
                aria-label="前进一帧"
                disabled={
                  timecodeControlsDisabled ||
                  currentFrame >= maximumSeekFrame
                }
                onClick={() => stepTimecodeFrame(1)}
              >
                +1
                <span>帧</span>
              </button>
            </div>

            <div className="timecode-rate-control">
              <label htmlFor="timecode-rate">帧率</label>
              <select
                id="timecode-rate"
                aria-label="时间码帧率"
                value={timecodeRateId}
                disabled={transportIsLocked || phase !== "ready"}
                onChange={(event) =>
                  changeTimecodeRate(event.currentTarget.value)
                }
              >
                {TIMECODE_RATES.map((rate) => (
                  <option key={rate.id} value={rate.id}>
                    {rate.label}
                  </option>
                ))}
              </select>
              <span className={`play-label ${playState}`}>
                {playState === "playing"
                  ? "PLAYING"
                  : playState.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        <aside className="control-panel">
          <div className="section-heading compact">
            <div>
              <span className="step-number">02</span>
              <div>
                <h2>播放与设备输出</h2>
                <p>
                  {selectedDevice.online
                    ? `选中设备 ${selectedDevice.number} · ${selectedDevice.name}`
                    : "连接设备后可调整播放参数"}
                </p>
              </div>
            </div>
          </div>

          <div className="latency-live">
            <div className="latency-number">
              <span>实时网络延迟</span>
              <strong>{selectedDevice.networkDelay}</strong>
              <small>ms</small>
            </div>
            <div className="spark-bars" aria-label="最近十五次延迟采样">
              {delayBars.map((bar) => (
                <i
                  key={bar.key}
                  style={{ height: `${bar.height}px` }}
                  title={`${bar.value}ms`}
                />
              ))}
            </div>
            <div className="sample-row">
              <span><b className="live-dot" />100ms 抗干扰采样</span>
              <span>抖动 ±{selectedDevice.jitter}ms</span>
            </div>
          </div>

          <div className="calibration-card">
            <div className="calibration-title">
              <div>
                <span>校准音补偿</span>
                <small>
                  仅用于校准叮声，不参与视频的绝对播放时刻
                </small>
              </div>
              <label>
                <input
                  aria-label="校准音补偿"
                  type="number"
                  min="-3000"
                  max={selectedMaxAdvance}
                  value={selectedDevice.playbackDelay}
                  disabled={!selectedDevice.online}
                  onChange={(event) => updatePlaybackDelay(Number(event.target.value))}
                />
                <span>ms</span>
              </label>
            </div>
            <input
              aria-label="校准音补偿滑块"
              className="range-control"
              type="range"
              min="-3000"
              max={selectedMaxAdvance}
              value={selectedDevice.playbackDelay}
              disabled={!selectedDevice.online}
              onChange={(event) => updatePlaybackDelay(Number(event.target.value))}
            />
            <button
              type="button"
              className="ding-button"
              onClick={handleDing}
              disabled={!selectedDevice.online}
            >
              <span className="sound-waves" aria-hidden="true">)))</span>
              向设备 {selectedDevice.number || "—"} 播放校准叮声
            </button>
          </div>

          <div className="device-output-card">
            <div className="device-volume-control">
              <div>
                <span>设备 {selectedDevice.code} 音量</span>
                <strong>{selectedDevice.volumePercent}%</strong>
              </div>
              <input
                aria-label={`设备 ${selectedDevice.code} 音量`}
                type="range"
                min="0"
                max="100"
                value={selectedDevice.volumePercent}
                disabled={!selectedDevice.online}
                onChange={(event) => updateVolume(Number(event.target.value))}
              />
            </div>
            <div className="device-image-control">
              <label className={!selectedDevice.online ? "disabled" : ""}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  disabled={!selectedDevice.online}
                  onChange={handleDeviceImage}
                />
                向设备 {selectedDevice.code} 发送图片
              </label>
              <button
                type="button"
                disabled={!selectedDevice.online || !selectedDevice.imageUrl}
                onClick={() => void clearDeviceImage()}
              >
                清除图片
              </button>
            </div>
          </div>

          <div className="formula-card">
            <span>绝对播放时刻规则</span>
            <div>
              <b>点击时刻</b>
              <i>+</i>
              <b>{PLAYBACK_TARGET_LEAD_MS}</b>
              <i>=</i>
              <strong>统一目标</strong>
            </div>
            <p>网络延迟和设备播放延迟均不参与播放目标时刻</p>
          </div>

          <div className="device-table">
            <div className="table-head">
              <span>设备</span>
              <span>网络</span>
              <span>校准音补偿</span>
              <span>媒体状态</span>
              <span>时钟修正</span>
            </div>
            {devices.map((device) => (
              <button
                type="button"
                className={selectedId === device.id ? "active" : ""}
                key={device.id}
                onClick={() => setSelectedId(device.id)}
              >
                <span><b>{device.code}</b> 位置 {device.number}</span>
                <span>{device.networkDelay}ms</span>
                <span>{formatSignedMilliseconds(device.playbackDelay)}</span>
                <span
                  className={`media-state ${device.mediaStatus}`}
                  title={device.mediaError || mediaStatusLabel(device.mediaStatus)}
                >
                  {mediaStatusLabel(device.mediaStatus)}
                  {phase === "processing"
                    ? ` · ${uploadProgress}%`
                    : videoUrl &&
                        !videoUrl.startsWith("blob:") &&
                        device.mediaVideoUrl === videoUrl
                      ? ` · ${device.mediaProgress}%`
                      : ""}
                </span>
                <strong>{formatSignedMilliseconds(device.clockAdjustmentMs)}</strong>
              </button>
            ))}
            {devices.length === 0 && (
              <div className="empty-device-row">暂无在线设备</div>
            )}
          </div>
        </aside>
      </section>

      <footer className="transport-bar">
        <div className="toast-message" aria-live="polite">
          <span className="status-dot pulse" />
          {toast}
        </div>
        <div className="transport-actions">
          <button
            className={`loop-button ${loopEnabled ? "active" : ""}`}
            type="button"
            aria-pressed={loopEnabled}
            onClick={() => {
              const next = !loopEnabledRef.current;
              loopEnabledRef.current = next;
              setLoopEnabled(next);
              if (!next && loopRestartTimerRef.current) {
                window.clearTimeout(loopRestartTimerRef.current);
                loopRestartTimerRef.current = null;
              }
              setToast(
                next
                  ? "循环播放已开启：每轮都会重新下发绝对播放时刻"
                  : "循环播放已关闭",
              );
            }}
          >
            <span aria-hidden="true">↻</span>
            <b>循环 {loopEnabled ? "开启" : "关闭"}</b>
          </button>
          <button
            className="stop-button"
            type="button"
            aria-label="全部停止"
            onClick={() => void stopPlayback()}
            disabled={devices.length === 0 && playState === "idle"}
          >
            <span />
            <b>全部停止</b>
          </button>
          <button
            className="primary-play"
            type="button"
            onClick={() => void handlePlay(false)}
            disabled={
              playState === "scheduled" ||
              phase !== "ready" ||
              devices.length === 0
            }
          >
            <span className={playState === "playing" ? "pause-icon" : "play-icon"} />
            <span>
              <small>
                {playState === "scheduled"
                  ? `到达 ${
                      absoluteTargetAt
                        ? formatAbsoluteClock(absoluteTargetAt)
                        : "主机目标时刻"
                    } 时播放`
                  : playState === "playing"
                    ? loopEnabled
                      ? `循环第 ${loopRound} 轮播放中`
                      : "全部设备播放中"
                    : playState === "paused"
                      ? "从统一时间轴继续"
                      : "点击后下发主机时间 + 3000ms"}
              </small>
              {playState === "playing" ? "暂停全部设备" : "同步播放"}
            </span>
            <b>{PLAYBACK_TARGET_LEAD_MS}ms</b>
          </button>
        </div>
        <div className="clock-health">
          <span>时钟基准</span>
          <strong>MONOTONIC</strong>
          <i />
          <span>采样 #{sampleTick}</span>
        </div>
      </footer>
    </main>
  );
}
