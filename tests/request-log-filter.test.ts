import assert from "node:assert/strict";
import test from "node:test";
import { shouldSuppressRequestLog } from "../build/request-log-filter.mjs";

test("suppresses only high-frequency latency polling request logs", () => {
  assert.equal(
    shouldSuppressRequestLog("[mf:inf] GET /api/ping?probe=123 200 OK"),
    true,
  );
  assert.equal(
    shouldSuppressRequestLog("[mf:inf] GET /api/devices?probe=123 200 OK"),
    true,
  );
  assert.equal(
    shouldSuppressRequestLog(
      "[mf:inf] POST /api/devices/heartbeat 200 OK",
    ),
    true,
  );
});

test("keeps state changes, media actions, warnings, and errors", () => {
  assert.equal(
    shouldSuppressRequestLog("[mf:inf] POST /api/sync 200 OK"),
    false,
  );
  assert.equal(
    shouldSuppressRequestLog("[mf:inf] PATCH /api/devices 200 OK"),
    false,
  );
  assert.equal(
    shouldSuppressRequestLog("[mf:inf] POST /api/devices/ding 200 OK"),
    false,
  );
  assert.equal(
    shouldSuppressRequestLog("[mf:err] GET /api/video 500 Internal Error"),
    false,
  );
});
