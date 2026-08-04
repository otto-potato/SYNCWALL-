import assert from "node:assert/strict";
import test from "node:test";

import { getStableDeviceCode } from "../app/device-code.ts";

test("assigns stable lowercase device codes by first connection order", () => {
  assert.equal(getStableDeviceCode(1), "aa");
  assert.equal(getStableDeviceCode(2), "ab");
  assert.equal(getStableDeviceCode(26), "az");
  assert.equal(getStableDeviceCode(27), "ba");
  assert.equal(getStableDeviceCode(100), "dv");
  assert.equal(getStableDeviceCode(676), "zz");
  assert.equal(getStableDeviceCode(677), "aaa");
});
