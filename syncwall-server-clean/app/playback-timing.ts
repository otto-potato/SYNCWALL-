export function getCompensatedPlaybackStartAt(
  targetAt: number,
  playbackDelayMs: number,
) {
  const safeTarget = Number.isFinite(targetAt) ? targetAt : 0;
  const safeDelay = Number.isFinite(playbackDelayMs) ? playbackDelayMs : 0;
  return Math.round(safeTarget - safeDelay);
}
