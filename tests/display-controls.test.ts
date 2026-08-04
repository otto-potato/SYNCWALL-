import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DISPLAY_ADJUSTMENT,
  adjustDisplayForKey,
  getNextPlaylistIndex,
  getPlaylistIndexForEndAction,
  normalizeDisplayAdjustment,
  planPlaylistItemRemoval,
  planPlaylistUpload,
} from "../app/display-controls.ts";

test("controlled-device keyboard adjustments are independent and bounded", () => {
  assert.deepEqual(
    adjustDisplayForKey(DEFAULT_DISPLAY_ADJUSTMENT, "ArrowUp"),
    {
      verticalOffsetPercent: -1,
      zoom: 0.9,
      horizontalScale: 1,
    },
  );
  assert.equal(
    adjustDisplayForKey(DEFAULT_DISPLAY_ADJUSTMENT, "ArrowRight")
      ?.horizontalScale,
    1.025,
  );
  assert.equal(
    adjustDisplayForKey(DEFAULT_DISPLAY_ADJUSTMENT, "+")?.zoom,
    0.925,
  );
  assert.deepEqual(
    normalizeDisplayAdjustment({
      verticalOffsetPercent: 500,
      zoom: 0.1,
      horizontalScale: 8,
    }),
    {
      verticalOffsetPercent: 30,
      zoom: 0.4,
      horizontalScale: 3,
    },
  );
  assert.deepEqual(
    normalizeDisplayAdjustment({
      verticalOffsetPercent: 20,
      zoom: 1,
      horizontalScale: 1,
    }),
    {
      verticalOffsetPercent: 0,
      zoom: 1,
      horizontalScale: 1,
    },
  );
});

test("playlist advances once and only wraps when list loop is enabled", () => {
  assert.equal(getNextPlaylistIndex(0, 3, false), 1);
  assert.equal(getNextPlaylistIndex(2, 3, false), null);
  assert.equal(getNextPlaylistIndex(2, 3, true), 0);
});

test("playlist uploads append without replacing the active media", () => {
  assert.deepEqual(
    planPlaylistUpload(["playing"], ["next-a", "next-b"], 0, true),
    {
      items: ["playing", "next-a", "next-b"],
      activeIndex: 0,
      replaceActiveMedia: false,
    },
  );
  assert.deepEqual(
    planPlaylistUpload([], ["queued"], 0, true),
    {
      items: ["queued"],
      activeIndex: -1,
      replaceActiveMedia: false,
    },
  );
  assert.deepEqual(
    planPlaylistUpload([], ["first"], 0, false),
    {
      items: ["first"],
      activeIndex: 0,
      replaceActiveMedia: true,
    },
  );
});

test("end actions pause, repeat, advance, and randomize predictably", () => {
  assert.equal(getPlaylistIndexForEndAction(1, 3, "pause"), null);
  assert.equal(getPlaylistIndexForEndAction(1, 3, "single-loop"), 1);
  assert.equal(getPlaylistIndexForEndAction(2, 3, "playlist-loop"), 0);
  assert.equal(
    getPlaylistIndexForEndAction(1, 3, "playlist-random", 0),
    0,
  );
  assert.equal(
    getPlaylistIndexForEndAction(1, 3, "playlist-random", 0.999),
    2,
  );
  assert.notEqual(
    getPlaylistIndexForEndAction(2, 4, "playlist-random", 0.5),
    2,
  );
  assert.equal(
    getPlaylistIndexForEndAction(-1, 3, "single-loop", 0.5),
    -1,
  );
  assert.equal(
    getPlaylistIndexForEndAction(-1, 3, "playlist-random", 0),
    0,
  );
});

test("deleting playlist items preserves playback and reindexes safely", () => {
  assert.deepEqual(planPlaylistItemRemoval(["a", "b", "c"], 0, 1), {
    items: ["b", "c"],
    activeIndex: 0,
    removedActiveItem: false,
  });
  assert.deepEqual(planPlaylistItemRemoval(["a", "b", "c"], 1, 1), {
    items: ["a", "c"],
    activeIndex: -1,
    removedActiveItem: true,
  });
});
