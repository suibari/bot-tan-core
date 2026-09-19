import assert from "node:assert/strict";
import test from "node:test";
import { assertBotPdsAccessAllowed, createBotAgent } from "../src/agent.js";

test("bot PDS login is closed by default in development and when NODE_ENV is absent", () => {
  for (const nodeEnv of ["development", undefined, "test"]) {
    assert.throws(
      () => assertBotPdsAccessAllowed({ NODE_ENV: nodeEnv }),
      /Bot PDS login is disabled/,
    );
  }
});

test("production login and intentional disposable-account testing are allowed", () => {
  assert.doesNotThrow(() => assertBotPdsAccessAllowed({ NODE_ENV: "production" }));
  assert.doesNotThrow(() =>
    assertBotPdsAccessAllowed({
      NODE_ENV: "development",
      ALLOW_DEV_BOT_PDS_WRITES: "true",
    }),
  );
  assert.throws(() =>
    assertBotPdsAccessAllowed({
      NODE_ENV: "development",
      ALLOW_DEV_BOT_PDS_WRITES: "1",
    }),
  );
});

test("the actual bot login stops before contacting the PDS in development", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldOverride = process.env.ALLOW_DEV_BOT_PDS_WRITES;
  process.env.NODE_ENV = "development";
  delete process.env.ALLOW_DEV_BOT_PDS_WRITES;
  try {
    const runtime = createBotAgent({
      identifier: "did:plc:example",
      password: "unused",
      service: "http://127.0.0.1:1",
    });
    await assert.rejects(runtime.login(), /Bot PDS login is disabled/);
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldOverride === undefined) delete process.env.ALLOW_DEV_BOT_PDS_WRITES;
    else process.env.ALLOW_DEV_BOT_PDS_WRITES = oldOverride;
  }
});
