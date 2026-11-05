import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
process.env.ALLOW_DEV_APPVIEW_NOTIFICATIONS = "true";
process.env.NAGI_REPORT_DISCORD_WEBHOOK_URL = "https://discord.example/reports";

const { parseReportInput, takeReportSlot, resetReportRateLimit } = await import(
  "../src/queries/reports.js"
);
const { buildReportPayload, sendReport } = await import(
  "../src/services/reports/notify.js"
);

const POST = "at://did:plc:author/com.suibari.nagi.post/3kabc";
const REACTION = "at://did:plc:reactor/com.suibari.nagi.reaction/3kdef";

test("投稿と、投稿に付いたリアクションだけを通報対象として受け付ける", () => {
  assert.deepEqual(parseReportInput({ subject: { uri: POST }, reason: "spam" }), {
    uri: POST,
    reason: "spam",
    comment: "",
  });
  assert.equal(
    parseReportInput({
      subject: { uri: POST, reactor: "did:plc:reactor" },
      reason: "harassment",
    }).reactorDid,
    "did:plc:reactor",
  );
  for (const body of [
    {},
    { subject: { uri: "at://did:plc:a/com.suibari.nagi.profile/self" }, reason: "spam" },
    { subject: { uri: REACTION }, reason: "spam" },
    { subject: { uri: POST, reactor: "someone" }, reason: "spam" },
    { subject: { uri: POST }, reason: "unknown" },
    { subject: { uri: POST }, reason: "other", comment: 1 },
    { subject: { uri: POST }, reason: "other", comment: "あ".repeat(1001) },
  ])
    assert.throws(() => parseReportInput(body), { status: 400 });
});

test("コメントは前後の空白を落として受け取る", () => {
  assert.equal(
    parseReportInput({ subject: { uri: POST }, reason: "other", comment: "  ありがとう \n" })
      .comment,
    "ありがとう",
  );
});

test("1時間に10件を超える通報は断る", () => {
  resetReportRateLimit();
  const now = Date.parse("2026-11-05T00:00:00Z");
  for (let i = 0; i < 10; i++) assert.equal(takeReportSlot("did:plc:a", now + i), true);
  assert.equal(takeReportSlot("did:plc:a", now + 10), false);
  assert.equal(takeReportSlot("did:plc:b", now + 10), true);
  assert.equal(takeReportSlot("did:plc:a", now + 60 * 60_000 + 1), true);
});

const notice = {
  reporterDid: "did:plc:reporter",
  reason: "botResponse" as const,
  comment: "@everyone ちょっと冷たく感じた",
  subjectType: "post" as const,
  subjectUri: POST,
  authorDid: "did:plc:bot",
  authorIsBot: true,
  content: "```そうなんだね```",
};

test("Discord への通知はメンションを鳴らさず、本文をコードブロックに閉じ込める", () => {
  const payload = buildReportPayload(notice);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].title, /botたんの投稿/);
  const body = payload.embeds[0].fields.find((field) => field.name === "本文");
  assert.ok(body?.value.startsWith("```\n"));
  assert.equal(body?.value.includes("```そうなんだね```"), false);
  assert.ok(payload.embeds[0].fields.some((field) => field.name === "コメント"));
});

test("リアクションの通報には、リアクション先の投稿を添える", () => {
  const payload = buildReportPayload({
    ...notice,
    reason: "harassment",
    subjectType: "reaction",
    subjectUri: REACTION,
    authorDid: "did:plc:reactor",
    authorIsBot: false,
    content: "💢",
    contextText: "今日はつらかった",
  });
  const names = payload.embeds[0].fields.map((field) => field.name);
  assert.ok(names.includes("絵文字"));
  assert.ok(names.includes("リアクション先の投稿"));
});

test("Webhook が失敗したら呼び出し側へ失敗を返す", async () => {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    sent.push(String(input));
    return new Response(null, { status: sent.length === 1 ? 204 : 500 });
  }) as typeof fetch;
  try {
    await sendReport(notice);
    await assert.rejects(sendReport(notice), /HTTP 500/);
    assert.deepEqual(sent, ["https://discord.example/reports", "https://discord.example/reports"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
