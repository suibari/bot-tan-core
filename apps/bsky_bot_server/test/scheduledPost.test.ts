import assert from "node:assert/strict";
import test from "node:test";
import { agent } from "../src/bsky/agent.js";
import { buildScheduledExternal, publishScheduledPost } from "../src/ScheduledPostFeature.js";

function productionEnv(t: { after: (fn: () => void) => void }) {
  const previousEnv = process.env.NODE_ENV;
  const previousLeaflet = process.env.LEAFLET_USERNAME;
  process.env.NODE_ENV = "production";
  delete process.env.LEAFLET_USERNAME;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousLeaflet === undefined) delete process.env.LEAFLET_USERNAME;
    else process.env.LEAFLET_USERNAME = previousLeaflet;
  });
}

const video = { uri: "at://did:plc:bot/app.bsky.feed.post/video", cid: "video-cid" };

test("夜の動画がある日は、動画を RP だけして、出来事を別スレッドで出す", async (t) => {
  productionEnv(t);
  const calls: string[] = [];
  t.mock.method(agent, "repost", async (uri: string, cid: string) => {
    assert.equal(uri, video.uri);
    assert.equal(cid, video.cid);
    calls.push("repost");
    return { uri: "at://repost", cid: "repost-cid" };
  });
  t.mock.method(agent, "post", async (record: any) => {
    calls.push("post");
    assert.equal(record.text, "おやすみ！");
    assert.equal(record.reply, undefined);
    assert.equal(record.embed, undefined);
    return { uri: "at://post", cid: "post-cid" };
  });
  const result = await publishScheduledPost({
    kind: "good-night", text: "おやすみ！",
    nightVideo: video,
  });
  assert.deepEqual(calls, ["repost", "post"]);
  assert.deepEqual(result, {
    uri: "at://post", cid: "post-cid",
    nightVideoRepost: { uri: "at://repost", cid: "repost-cid" },
  });
});

test("動画の紹介に失敗しても出来事スレッドは出す", async (t) => {
  productionEnv(t);
  t.mock.method(agent, "repost", async () => { throw new Error("repost down"); });
  t.mock.method(agent, "post", async (record: any) => {
    if (record.reply) throw new Error("reply down");
    return { uri: "at://post", cid: "post-cid" };
  });
  t.mock.method(console, "error", () => {});
  const result = await publishScheduledPost({
    kind: "good-night", text: "おやすみ！",
    nightVideo: video,
  });
  assert.deepEqual(result, { uri: "at://post", cid: "post-cid" });
});

test("夜の動画が無い日は RP もリプライもしない", async (t) => {
  productionEnv(t);
  t.mock.method(agent, "repost", async () => { throw new Error("should not repost"); });
  const posted: any[] = [];
  t.mock.method(agent, "post", async (record: any) => {
    posted.push(record);
    return { uri: "at://post", cid: "post-cid" };
  });
  await publishScheduledPost({ kind: "good-night", text: "おやすみ！" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].reply, undefined);
});

const newsCard = {
  uri: "https://nagi.suibari.com/news/3news",
  title: "見出し",
  description: "Example News · Nagi のニュース",
  thumbUrl: "https://image.example/news.jpg",
};

test("気まぐれ：Nagi のニュースページのカードに記事の画像をサムネとして付ける", async (t) => {
  productionEnv(t);
  const thumb = { ref: "bafythumb", mimeType: "image/jpeg", size: 4 } as any;
  t.mock.method(agent, "uploadBlob", async (data: Buffer, opts: any) => {
    assert.equal(data.toString(), "jpeg");
    assert.equal(opts.encoding, "image/jpeg");
    return { data: { blob: thumb } };
  });
  t.mock.method(globalThis, "fetch", async (input: any) => {
    assert.equal(String(input), newsCard.thumbUrl);
    return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });
  });
  let posted: any;
  t.mock.method(agent, "post", async (record: any) => {
    posted = record;
    return { uri: "at://post", cid: "post-cid" };
  });
  // safeFetch は DNS を引くので、ここでは解決結果を差し替えずに fetchImage を注入した版で検証する。
  const card = await buildScheduledExternal(newsCard, {
    fetchImage: (async (url: string) => fetch(url)) as any,
  });
  assert.deepEqual(card, {
    uri: newsCard.uri, title: newsCard.title, description: newsCard.description, thumb,
  });

  await publishScheduledPost({
    kind: "whimsical",
    text: "ニュースだよ！みんなは最近どう？\n\nMyMoodSong:\nSong - Artist\nhttps://www.youtube.com/watch?v=stub",
    external: { ...newsCard, thumbUrl: undefined },
  });
  // 本文の YouTube URL から自動でカードを作らず、渡したカードを優先する。
  assert.deepEqual(posted.embed, {
    $type: "app.bsky.embed.external",
    external: { uri: newsCard.uri, title: newsCard.title, description: newsCard.description },
  });
});

test("気まぐれ：サムネを取れなければサムネ無しのカードで出す", async (t) => {
  t.mock.method(console, "warn", () => {});
  const card = await buildScheduledExternal(newsCard, {
    fetchImage: (async () => new Response("gone", { status: 404 })) as any,
    upload: async () => { throw new Error("must not upload"); },
  });
  assert.deepEqual(card, { uri: newsCard.uri, title: newsCard.title, description: newsCard.description });
});

test("Nagi の投稿があれば、1件の投稿に Nagi へのリンクと長文の目印を付ける", async (t) => {
  productionEnv(t);
  t.mock.method(console, "warn", () => {});
  const records: any[] = [];
  t.mock.method(agent, "post", async (record: any) => {
    records.push(record);
    return { uri: "at://post", cid: "post-cid" };
  });
  const nagiPost = { uri: "at://did:plc:bot/com.suibari.nagi.post/3kpost", cid: "nagi-cid" };
  await publishScheduledPost({
    kind: "good-night",
    text: "おやすみ".repeat(100),
    nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" },
    nagiPost,
  });
  assert.equal(records.length, 1);
  assert.match(records[0].text, /…もっと見る\n\n🌐 English$/);
  assert.deepEqual(
    records[0].facets.map((facet: any) => facet.features[0].uri),
    [
      "https://nagi.suibari.com/thread/did%3Aplc%3Abot/3kpost",
      "https://nagi.suibari.com/thread/did%3Aplc%3Abot/3kpost",
    ],
  );
  assert.equal(records[0].embed, undefined);
  assert.deepEqual(records[0]["com.suibari.nagi.longPost"], nagiPost);
});

test("Nagi の投稿が無い回は、リンクを付けずに本文と末尾を出す", async (t) => {
  productionEnv(t);
  t.mock.method(console, "warn", () => {});
  const records: any[] = [];
  t.mock.method(agent, "post", async (record: any) => {
    records.push(record);
    return { uri: "at://post", cid: "post-cid" };
  });
  await publishScheduledPost({
    kind: "morning",
    text: "おはよう！",
    footer: "#全肯定質問コーナー",
    nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "おはよう！\n\n#全肯定質問コーナー");
  assert.equal(records[0]["com.suibari.nagi.longPost"], undefined);
});
