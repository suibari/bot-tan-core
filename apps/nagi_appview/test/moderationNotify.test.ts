import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.NAGI_MODERATION_DISCORD_WEBHOOK_URL ??=
  "https://discord.example/webhook";
process.env.ALLOW_DEV_APPVIEW_NOTIFICATIONS = "true";

const { notifyDecision } = await import("../src/services/moderation/notify.js");

test("Discord rejection notice includes judged text, reason, and image bytes", async () => {
  const originalFetch = globalThis.fetch;
  const webhookBodies: FormData[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "https://example.com/post.webp")
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        headers: { "content-type": "image/webp", "content-length": "4" },
      });
    assert.equal(url, "https://discord.example/webhook");
    assert.ok(init?.body instanceof FormData);
    webhookBodies.push(init.body);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await notifyDecision({
      decision: "reject-invalid",
      collection: "com.suibari.nagi.post",
      uri: "at://did:plc:author/com.suibari.nagi.post/example",
      did: "did:plc:author",
      labels: [],
      category: "invalid-input",
      score: 0,
      ruleVersion: "nagi-moderation-v3",
      update: false,
      texts: ["判定対象の本文"],
      imageUrls: ["https://example.com/post.webp"],
      reasons: ["[INVALID] invalid_image_format"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(webhookBodies.length, 1);
  const form = webhookBodies[0];
  const payload = JSON.parse(String(form.get("payload_json")));
  assert.match(payload.embeds[0].description, /判定対象の本文/);
  assert.match(payload.embeds[0].description, /invalid_image_format/);
  assert.equal(payload.embeds[1].image.url, "attachment://moderation-1.webp");
  const image = form.get("files[0]");
  assert.ok(image instanceof File);
  assert.equal(image.name, "moderation-1.webp");
  assert.equal(image.size, 4);
});
