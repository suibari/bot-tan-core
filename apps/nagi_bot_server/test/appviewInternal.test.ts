import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getNagiAppviewInternalUrl } from "../src/appviewInternal.js";

const originalPort = process.env.NAGI_APPVIEW_INTERNAL_PORT;

after(() => {
  if (originalPort === undefined) delete process.env.NAGI_APPVIEW_INTERNAL_PORT;
  else process.env.NAGI_APPVIEW_INTERNAL_PORT = originalPort;
});

test("AppView内部APIは待受portと同じ設定からloopback URLを組み立てる", () => {
  process.env.NAGI_APPVIEW_INTERNAL_PORT = "3205";
  assert.equal(getNagiAppviewInternalUrl(), "http://127.0.0.1:3205");
});
