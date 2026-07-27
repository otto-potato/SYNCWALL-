export type TimecodeRateId =
  | "23.976"
  | "24"
  | "25"
  | "29.97-ndf"
  | "29.97-df"
  | "30"
  | "50"
  | "59.94-ndf"
  | "59.94-df"
  | "60";

export type TimecodeRate = Readonly<{
  id: TimecodeRateId;
  label: string;
  framesPerSecond: number;
  nominalFramesPerSecond: number;
  dropFrames: number;
}>;

export const DEFAULT_TIMECODE_RATE_ID: TimecodeRateId = "25";

export const TIMECODE_RATES: readonly TimecodeRate[] = [
  {
    id: "23.976",
    label: "23.976 fps",
    framesPerSecond: 24_000 / 1_001,
    nominalFramesPerSecond: 24,
    dropFrames: 0,
  },
  {
    id: "24",
    label: "24 fps",
    framesPerSecond: 24,
    nominalFramesPerSecond: 24,
    dropFrames: 0,
  },
  {
    id: "25",
    label: "25 fps",
    framesPerSecond: 25,
    nominalFramesPerSecond: 25,
    dropFrames: 0,
  },
  {
    id: "29.97-ndf",
    label: "29.97 NDF",
    framesPerSecond: 30_000 / 1_001,
    nominalFramesPerSecond: 30,
    dropFrames: 0,
  },
  {
    id: "29.97-df",
    label: "29.97 DF",
    framesPerSecond: 30_000 / 1_001,
    nominalFramesPerSecond: 30,
    dropFrames: 2,
  },
  {
    id: "30",
    label: "30 fps",
    framesPerSecond: 30,
    nominalFramesPerSecond: 30,
    dropFrames: 0,
  },
  {
    id: "50",
    label: "50 fps",
    framesPerSecond: 50,
    nominalFramesPerSecond: 50,
    dropFrames: 0,
  },
  {
    id: "59.94-ndf",
    label: "59.94 NDF",
    framesPerSecond: 60_000 / 1_001,
    nominalFramesPerSecond: 60,
    dropFrames: 0,
  },
  {
    id: "59.94-df",
    label: "59.94 DF",
    framesPerSecond: 60_000 / 1_001,
    nominalFramesPerSecond: 60,
    dropFrames: 4,
  },
  {
    id: "60",
    label: "60 fps",
    framesPerSecond: 60,
    nominalFramesPerSecond: 60,
    dropFrames: 0,
  },
] as const;

export function getTimecodeRate(id: string): TimecodeRate {
  return (
    TIMECODE_RATES.find((rate) => rate.id === id) ??
    TIMECODE_RATES.find((rate) => rate.id === DEFAULT_TIMECODE_RATE_ID)!
  );
}

export function secondsToFrame(seconds: number, rate: TimecodeRate) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds * rate.framesPerSecond + 1e-7);
}

export function frameToSeconds(frame: number, rate: TimecodeRate) {
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  return safeFrame / rate.framesPerSecond;
}

export function getMaximumSeekFrame(
  durationSeconds: number,
  rate: TimecodeRate,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, Math.ceil(durationSeconds * rate.framesPerSecond) - 1);
}

export function clampFrameToDuration(
  frame: number,
  durationSeconds: number,
  rate: TimecodeRate,
) {
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  return Math.min(safeFrame, getMaximumSeekFrame(durationSeconds, rate));
}

function frameToDisplayFrame(frame: number, rate: TimecodeRate) {
  const safeFrame = Math.max(0, Math.floor(frame));
  if (!rate.dropFrames) return safeFrame;

  const framesPerTenMinutes =
    rate.nominalFramesPerSecond * 60 * 10 - rate.dropFrames * 9;
  const framesPerDroppedMinute =
    rate.nominalFramesPerSecond * 60 - rate.dropFrames;
  const completeTenMinuteBlocks = Math.floor(
    safeFrame / framesPerTenMinutes,
  );
  const remainingFrames = safeFrame % framesPerTenMinutes;
  const completeDroppedMinutes =
    remainingFrames < rate.dropFrames
      ? 0
      : Math.floor(
          (remainingFrames - rate.dropFrames) / framesPerDroppedMinute,
        );

  return (
    safeFrame +
    rate.dropFrames *
      (completeTenMinuteBlocks * 9 + completeDroppedMinutes)
  );
}

export function formatFrameTimecode(frame: number, rate: TimecodeRate) {
  const displayFrame = frameToDisplayFrame(frame, rate);
  const frames = displayFrame % rate.nominalFramesPerSecond;
  const totalSeconds = Math.floor(
    displayFrame / rate.nominalFramesPerSecond,
  );
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const frameSeparator = rate.dropFrames ? ";" : ":";

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `${frameSeparator}${String(frames).padStart(2, "0")}`;
}

export function formatTimecode(seconds: number, rate: TimecodeRate) {
  return formatFrameTimecode(secondsToFrame(seconds, rate), rate);
}

export function parseTimecode(value: string, rate: TimecodeRate) {
  const match = value
    .trim()
    .match(/^(\d{2,}):([0-5]\d):([0-5]\d)([:;])(\d{2})$/);
  if (!match) return null;

  const [, hoursText, minutesText, secondsText, separator, framesText] =
    match;
  if (
    (rate.dropFrames > 0 && separator !== ";") ||
    (rate.dropFrames === 0 && separator !== ":")
  ) {
    return null;
  }

  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const frames = Number(framesText);
  if (
    !Number.isSafeInteger(hours) ||
    frames >= rate.nominalFramesPerSecond
  ) {
    return null;
  }

  if (
    rate.dropFrames > 0 &&
    minutes % 10 !== 0 &&
    seconds === 0 &&
    frames < rate.dropFrames
  ) {
    return null;
  }

  const totalMinutes = hours * 60 + minutes;
  const displayFrame =
    (hours * 3600 + minutes * 60 + seconds) *
      rate.nominalFramesPerSecond +
    frames;
  const droppedFrames =
    rate.dropFrames *
    (totalMinutes - Math.floor(totalMinutes / 10));
  const frame = displayFrame - droppedFrames;
  return Number.isSafeInteger(frame) && frame >= 0 ? frame : null;
}
