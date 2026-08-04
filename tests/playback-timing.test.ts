import assert from "node:assert/strict";
import test from "node:test";

import { getCompensatedPlaybackStartAt } from "../app/playback-timing.ts";

test("keeps playback calibration independent from the absolute target clock", () => {
  assert.equal(getCompensatedPlaybackStartAt(10_000, 120), 9_880);
  assert.equal(getCompensatedPlaybackStartAt(10_000, -80), 10_080);
  assert.equal(getCompensatedPlaybackStartAt(10_000, 0), 10_000);
});
