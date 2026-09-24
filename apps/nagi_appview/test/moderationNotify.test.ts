import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.NAGI_MODERATION_DISCORD_WEBHOOK_URL ??=
  "https://discord.example/webhook";
process.env.ALLOW_DEV_APPVIEW_NOTIFICATIONS = "true";
process.env.DISCORD_BOT_INTERNAL_PORT = "3905";

import { readFile } from "node:fs/promises";

const { notifyDecision, recordModerationFailure, resetModerationFailureState } =
  await import("../src/services/moderation/notify.js");

const BOT_URL = "http://127.0.0.1:3905/moderation/notices";
const WEBHOOK_URL = "https://discord.example/webhook";

const notice = {
  decision: "reject-invalid" as const,
  collection: "com.suibari.nagi.post",
  uri: "at://did:plc:author/com.suibari.nagi.post/example",
  cid: "bafyreiexample",
  did: "did:plc:author",
  labels: [],
  category: "invalid-input",
  score: 0,
  ruleVersion: "nagi-moderation-v3",
  update: false,
  texts: ["判定対象の本文"],
  imageUrls: ["https://example.com/post.webp"],
  reasons: ["[INVALID] invalid_image_format"],
};

/** 画像は常に返し、bot と webhook への送信を記録する fetch に差し替える。 */
async function withFetch(
  bot: () => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<{ bot: FormData[]; webhook: FormData[] }> {
  const originalFetch = globalThis.fetch;
  const sent = { bot: [] as FormData[], webhook: [] as FormData[] };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "https://example.com/post.webp")
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        headers: { "content-type": "image/webp", "content-length": "4" },
      });
    assert.ok(init?.body instanceof FormData);
    if (url === BOT_URL) {
      sent.bot.push(init.body);
      return bot();
    }
    assert.equal(url, WEBHOOK_URL);
    sent.webhook.push(init.body);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

function assertNoticeForm(form: FormData) {
  const payload = JSON.parse(String(form.get("payload_json")));
  assert.match(payload.embeds[0].description, /判定対象の本文/);
  assert.match(payload.embeds[0].description, /invalid_image_format/);
  assert.equal(payload.embeds[1].image.url, "attachment://moderation-1.webp");
  const image = form.get("files[0]");
  assert.ok(image instanceof File);
  assert.equal(image.name, "moderation-1.webp");
  assert.equal(image.size, 4);
}

test("decision notices go to discord_bot with the subject for the release button", async () => {
  const sent = await withFetch(
    () => new Response(null, { status: 204 }),
    () => notifyDecision(notice),
  );
  assert.equal(sent.webhook.length, 0);
  assert.equal(sent.bot.length, 1);
  assertNoticeForm(sent.bot[0]);
  assert.equal(sent.bot[0].get("moderation_uri"), notice.uri);
  // 解除ボタンを「この内容」に結び付けるための cid。
  assert.equal(sent.bot[0].get("moderation_cid"), notice.cid);
  assert.equal(sent.bot[0].get("moderation_decision"), "reject-invalid");
});

test("a failing discord_bot falls back to the webhook", async () => {
  const sent = await withFetch(
    () => new Response(null, { status: 503 }),
    () => notifyDecision(notice),
  );
  assert.equal(sent.bot.length, 1);
  assert.equal(sent.webhook.length, 1);
  assertNoticeForm(sent.webhook[0]);
  // Webhook はボタンを出せないので、操作用のフィールドは送らない。
  assert.equal(sent.webhook[0].get("moderation_uri"), null);
});

test("an unreachable discord_bot falls back to the webhook", async () => {
  const sent = await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    () => notifyDecision(notice),
  );
  assert.equal(sent.webhook.length, 1);
});

test("outage alerts carry no release button", async () => {
  resetModerationFailureState();
  const sent = await withFetch(
    () => new Response(null, { status: 204 }),
    async () => {
      for (let i = 0; i < 5; i++) await recordModerationFailure(new Error("x"));
    },
  );
  resetModerationFailureState();
  assert.equal(sent.bot.length, 1);
  assert.equal(sent.bot[0].get("moderation_uri"), null);
});

/**
 * AppView の内部 API と discord_bot の受け口は同じホストの 127.0.0.1 に並ぶ。
 * サンプルどおりに設定して片方が EADDRINUSE にならないこと。
 */
test("the sample environment gives the discord_bot listener its own port", async () => {
  const { DISCORD_BOT_INTERNAL_DEFAULT_PORT } = await import(
    "@bsky-affirmative-bot/shared-configs"
  );
  const sample = await readFile(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  const ports = new Map<string, string>();
  for (const match of sample.matchAll(/^([A-Z_]+_PORT)=(\d+)$/gm))
    ports.set(match[1], match[2]);
  const discord = ports.get("DISCORD_BOT_INTERNAL_PORT");
  assert.equal(discord, String(DISCORD_BOT_INTERNAL_DEFAULT_PORT));
  for (const [name, port] of ports)
    if (name !== "DISCORD_BOT_INTERNAL_PORT")
      assert.notEqual(port, discord, `${name} collides with the discord_bot listener`);
  // 既定値どうしも重ねない（AppView の内部 API の既定は 3004）。
  assert.notEqual(DISCORD_BOT_INTERNAL_DEFAULT_PORT, 3004);
});
