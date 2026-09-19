import assert from "node:assert/strict";
import test from "node:test";
import { assertExternalAccountAccessAllowed } from "../src/externalAccountAccess.js";

test("external accounts are blocked outside production unless explicitly opted in", () => {
  for (const nodeEnv of [undefined, "development", "test"]) {
    assert.throws(() =>
      assertExternalAccountAccessAllowed("Labeler", "ALLOW_DEV_LABELER_WRITES", {
        NODE_ENV: nodeEnv,
      }),
    );
  }
  assert.doesNotThrow(() =>
    assertExternalAccountAccessAllowed("Labeler", "ALLOW_DEV_LABELER_WRITES", {
      NODE_ENV: "production",
    }),
  );
  assert.doesNotThrow(() =>
    assertExternalAccountAccessAllowed("Labeler", "ALLOW_DEV_LABELER_WRITES", {
      NODE_ENV: "development",
      ALLOW_DEV_LABELER_WRITES: "true",
    }),
  );
});
