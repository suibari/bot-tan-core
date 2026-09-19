import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
const { appviewExternalNotificationsAllowed } = await import("../src/config.js");

test("development AppView does not send external notifications by default", () => {
  for (const nodeEnv of [undefined, "development", "test"]) {
    assert.equal(appviewExternalNotificationsAllowed({ NODE_ENV: nodeEnv }), false);
  }
  assert.equal(appviewExternalNotificationsAllowed({ NODE_ENV: "production" }), true);
  assert.equal(appviewExternalNotificationsAllowed({
    NODE_ENV: "development",
    ALLOW_DEV_APPVIEW_NOTIFICATIONS: "true",
  }), true);
});
