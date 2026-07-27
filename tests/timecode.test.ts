import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMECODE_RATES,
  clampFrameToDuration,
  formatFrameTimecode,
  formatTimecode,
  frameToSeconds,
  getMaximumSeekFrame,
  getTimecodeRate,
  parseTimecode,
  secondsToFrame,
} from "../app/timecode.ts";

test("formats zero and rolls over seconds, minutes, and hours", () => {
  const rate = getTimecodeRate("25");
  assert.equal(formatFrameTimecode(0, rate), "00:00:00:00");
  assert.equal(formatFrameTimecode(24, rate), "00:00:00:24");
  assert.equal(formatFrameTimecode(25, rate), "00:00:01:00");
  assert.equal(formatFrameTimecode(25 * 60, rate), "00:01:00:00");
  assert.equal(formatFrameTimecode(25 * 3600, rate), "01:00:00:00");
  assert.equal(formatFrameTimecode(25 * 100 * 3600, rate), "100:00:00:00");
});

test("round-trips representative frames for every supported rate", () => {
  for (const rate of TIMECODE_RATES) {
    const samples = [
      0,
      rate.nominalFramesPerSecond - 1,
      rate.nominalFramesPerSecond,
      Math.round(rate.framesPerSecond * 61),
      Math.round(rate.framesPerSecond * 601),
      Math.round(rate.framesPerSecond * 3601),
    ];
    for (const frame of samples) {
      const timecode = formatFrameTimecode(frame, rate);
      assert.equal(
        parseTimecode(timecode, rate),
        frame,
        `${rate.id} failed to round-trip ${timecode}`,
      );
    }
  }
});

test("uses SMPTE drop-frame labels at minute and ten-minute boundaries", () => {
  const rate2997 = getTimecodeRate("29.97-df");
  assert.equal(formatFrameTimecode(1_799, rate2997), "00:00:59;29");
  assert.equal(formatFrameTimecode(1_800, rate2997), "00:01:00;02");
  assert.equal(formatFrameTimecode(17_982, rate2997), "00:10:00;00");
  assert.equal(parseTimecode("00:01:00;02", rate2997), 1_800);
  assert.equal(parseTimecode("00:10:00;00", rate2997), 17_982);

  const rate5994 = getTimecodeRate("59.94-df");
  assert.equal(formatFrameTimecode(3_599, rate5994), "00:00:59;59");
  assert.equal(formatFrameTimecode(3_600, rate5994), "00:01:00;04");
  assert.equal(formatFrameTimecode(35_964, rate5994), "00:10:00;00");
  assert.equal(parseTimecode("00:01:00;04", rate5994), 3_600);
});

test("rejects malformed, skipped, and out-of-range frame labels", () => {
  const rate25 = getTimecodeRate("25");
  assert.equal(parseTimecode("00:00:00:25", rate25), null);
  assert.equal(parseTimecode("00:00:60:00", rate25), null);
  assert.equal(parseTimecode("00:00:00;00", rate25), null);
  assert.equal(parseTimecode("not-a-timecode", rate25), null);

  const rate2997 = getTimecodeRate("29.97-df");
  assert.equal(parseTimecode("00:01:00;00", rate2997), null);
  assert.equal(parseTimecode("00:01:00;01", rate2997), null);
  assert.equal(parseTimecode("00:01:00:02", rate2997), null);
  assert.equal(parseTimecode("00:10:00;00", rate2997), 17_982);
});

test("converts seconds and clamps seeks to the last playable frame", () => {
  const rate = getTimecodeRate("25");
  assert.equal(secondsToFrame(1.999, rate), 49);
  assert.equal(frameToSeconds(49, rate), 1.96);
  assert.equal(getMaximumSeekFrame(2, rate), 49);
  assert.equal(clampFrameToDuration(-10, 2, rate), 0);
  assert.equal(clampFrameToDuration(50, 2, rate), 49);
  assert.equal(formatTimecode(2, rate), "00:00:02:00");
});
