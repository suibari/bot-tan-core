import assert from "node:assert/strict";
import test from "node:test";
import { nightVideoPickedPost, pickWhimsicalNagiNews } from "../src/ScheduledPostCoordinator.js";

const news = {
  uri: "at://did:plc:bot/com.suibari.nagi.news/3n",
  cid: "cid",
  rkey: "3n",
  articleId: "article-1",
  titleJa: "見出し",
  commentJa: "紹介文",
};

test("気まぐれ：最近紹介した記事を除いて、bot の Nagi ニュースを1件選ぶ", async () => {
  let received: any;
  const picked = await pickWhimsicalNagiNews({
    botDid: "did:plc:bot",
    recent: async () => ["article-0"],
    pick: async (params) => {
      received = params;
      return news;
    },
  });
  assert.equal(picked, news);
  assert.deepEqual(received, { botDid: "did:plc:bot", excludeArticleIds: ["article-0"] });
});

test("気まぐれ：ニュースを選べなくても投稿は止めない（ニュース無しで出す）", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  assert.equal(await pickWhimsicalNagiNews({
    botDid: "did:plc:bot",
    recent: async () => [],
    pick: async () => { throw new Error("db down"); },
  }), undefined);
  const previous = process.env.NAGI_BOT_DID;
  delete process.env.NAGI_BOT_DID;
  t.after(() => { if (previous !== undefined) process.env.NAGI_BOT_DID = previous; });
  assert.equal(await pickWhimsicalNagiNews({ pick: async () => news, recent: async () => [] }), undefined);
});

test("おやすみ：夜の動画の紹介元を、短い表示名と説明文で渡す", () => {
  assert.deepEqual(nightVideoPickedPost({
    source_display_name: "ねこまる🐾ゆるふわ@いろいろ描きます",
    caption: " ねこまるさんの投稿を紹介したよ。 ",
    hook: null,
  }), { displayName: "ねこまる🐾ゆるふわ", caption: "ねこまるさんの投稿を紹介したよ。" });
  assert.equal(nightVideoPickedPost({ source_display_name: null, caption: "説明" }), undefined);
  assert.equal(nightVideoPickedPost(null), undefined);
});
