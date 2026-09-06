import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getLabelerInternalUrl } from "../src/LabelerService.js";

const originalPort = process.env.LABELER_INTERNAL_PORT;

after(() => {
  if (originalPort === undefined) delete process.env.LABELER_INTERNAL_PORT;
  else process.env.LABELER_INTERNAL_PORT = originalPort;
});

test("Labeler内部APIは待受portと同じ設定からloopback URLを組み立てる", () => {
  process.env.LABELER_INTERNAL_PORT = "3501";
  assert.equal(getLabelerInternalUrl(), "http://127.0.0.1:3501");
});
