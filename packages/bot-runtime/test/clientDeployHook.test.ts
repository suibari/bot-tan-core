import assert from "node:assert/strict";
import test from "node:test";
import { requestClientRebuild } from "../src/clientDeployHook.js";

test("does not request a rebuild without a deploy hook URL", async () => {
  let called = false;
  const result = await requestClientRebuild("blog article=test", {
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  });
  assert.equal(result, false);
  assert.equal(called, false);
});

test("requests a client rebuild through the configured deploy hook", async () => {
  let request: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  const result = await requestClientRebuild("blog article=test", {
    deployHookUrl: "https://example.com/deploy",
    fetchImpl: async (input, options) => {
      request = input;
      init = options;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result, true);
  assert.equal(request, "https://example.com/deploy");
  assert.equal(init?.method, "POST");
});
