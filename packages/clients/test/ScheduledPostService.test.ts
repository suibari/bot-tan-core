import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import {
  SCHEDULED_POST_BODY_LIMIT_BYTES,
  ScheduledPostService,
  scheduledPostErrorDetails,
} from "../src/ScheduledPostService.js";

test("最大画像をbase64化した予約投稿がbody上限に収まる", () => {
  const request = {
    kind: "good-night",
    text: "おやすみ".repeat(1_000),
    translations: [{ lang: "en", text: "Good night".repeat(1_000) }],
    image: {
      dataBase64: Buffer.alloc(950_000).toString("base64"),
      mimeType: "image/jpeg",
      width: 1200,
      height: 900,
      alt: "今日のできごと".repeat(100),
    },
  };

  assert.ok(Buffer.byteLength(JSON.stringify(request)) < SCHEDULED_POST_BODY_LIMIT_BYTES);
});

test("Axiosエラー要約へ送信payloadを含めない", () => {
  const details = scheduledPostErrorDetails({
    isAxiosError: true,
    message: "Request failed with status code 413",
    code: "ERR_BAD_REQUEST",
    config: { data: "secret-image-base64" },
    response: {
      status: 413,
      statusText: "Payload Too Large",
      data: "Payload Too Large",
    },
  });

  assert.deepEqual(details, {
    message: "Request failed with status code 413",
    code: "ERR_BAD_REQUEST",
    status: 413,
    statusText: "Payload Too Large",
    response: "Payload Too Large",
  });
  assert.doesNotMatch(JSON.stringify(details), /secret-image-base64/);
});

test("contentByTarget に無い配信先へは、設定されていても送らない", async (t) => {
  const previous = process.env.SCHEDULED_POST_TARGETS;
  process.env.SCHEDULED_POST_TARGETS = "bsky,nagi";
  t.after(() => {
    if (previous === undefined) delete process.env.SCHEDULED_POST_TARGETS;
    else process.env.SCHEDULED_POST_TARGETS = previous;
  });
  const urls: string[] = [];
  t.mock.method(axios, "post", async (url: string) => {
    urls.push(url);
    return { data: { uri: "at://did:plc:bot/com.suibari.nagi.post/1", cid: "cid" } };
  });

  const results = await ScheduledPostService.publish({
    kind: "monologue",
    contentByTarget: { nagi: { text: "ねむ" } },
  });

  assert.deepEqual(urls, [`${process.env.NAGI_BOT_SERVER_URL || "http://localhost:3003"}/posts/scheduled`]);
  assert.deepEqual(Object.keys(results), ["nagi"]);
});

function withTargets(t: { after: (fn: () => void) => void }, value: string) {
  const previous = process.env.SCHEDULED_POST_TARGETS;
  process.env.SCHEDULED_POST_TARGETS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SCHEDULED_POST_TARGETS;
    else process.env.SCHEDULED_POST_TARGETS = previous;
  });
}

const nagiLink = { label: "🌐 English", seeMoreLabel: "もっと見る" };
const NAGI_SERVER = process.env.NAGI_BOT_SERVER_URL || "http://localhost:3003";
const nagiUri = "at://did:plc:bot/com.suibari.nagi.post/1";

test("Nagi へのリンクを載せる回は、Nagi を先に出してその投稿を Bluesky へ渡す", async (t) => {
  withTargets(t, "bsky,nagi");
  const sent: Array<{ url: string; body: any }> = [];
  t.mock.method(axios, "post", async (url: string, body: any) => {
    sent.push({ url, body });
    return url.startsWith(NAGI_SERVER)
      ? { data: { uri: nagiUri, cid: "nagi-cid" } }
      : { data: { uri: "at://did:plc:bot/app.bsky.feed.post/1", cid: "bsky-cid" } };
  });

  const results = await ScheduledPostService.publish({
    kind: "morning",
    contentByTarget: { bsky: { text: "おはよう", nagiLink }, nagi: { text: "おはよう" } },
  });

  assert.equal(sent.length, 2);
  assert.ok(sent[0].url.startsWith(NAGI_SERVER));
  assert.deepEqual(sent[1].body.nagiPost, { uri: nagiUri, cid: "nagi-cid" });
  assert.deepEqual(Object.keys(results).sort(), ["bsky", "nagi"]);
});

test("Nagi への投稿が失敗しても、Bluesky へはリンク無しで出す", async (t) => {
  withTargets(t, "bsky,nagi");
  t.mock.method(console, "error", () => {});
  const bskyBodies: any[] = [];
  t.mock.method(axios, "post", async (url: string, body: any) => {
    if (url.startsWith(NAGI_SERVER)) {
      const error = Object.assign(new Error("down"), { isAxiosError: true, response: { status: 500 } });
      throw error;
    }
    bskyBodies.push(body);
    return { data: { uri: "at://did:plc:bot/app.bsky.feed.post/1", cid: "bsky-cid" } };
  });

  const results = await ScheduledPostService.publish({
    kind: "morning",
    contentByTarget: { bsky: { text: "おはよう", nagiLink }, nagi: { text: "おはよう" } },
  });

  assert.equal(bskyBodies.length, 1);
  assert.equal(bskyBodies[0].nagiPost, undefined);
  assert.deepEqual(Object.keys(results), ["bsky"]);
});
