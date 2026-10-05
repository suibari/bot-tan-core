import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoodNightPostTexts,
  buildWhimsicalPostTexts,
  getNagiThreadUrl,
  getBlueskyPostUrl,
  selectGoodNightLearnedTerms,
} from "../src/scheduledPostContent.js";

test("ニュースURLはNagiだけに追加しBluesky本文は変えない", () => {
  const result = buildWhimsicalPostTexts({
    textJa: "うれしいニュースだよ",
    textEn: "Here is some happy news",
    moodSong: "MyMoodSong:\nSong - Artist\nhttps://youtube.example/song",
    selectedNewsUrl: "https://news.example/article",
  });

  assert.equal(
    result.bskyJa,
    "うれしいニュースだよ\n\nMyMoodSong:\nSong - Artist\nhttps://youtube.example/song",
  );
  assert.doesNotMatch(result.bskyJa, /news\.example/);
  assert.match(result.nagiJa, /https:\/\/news\.example\/article/);
  assert.match(result.nagiJa, /https:\/\/youtube\.example\/song/);
  assert.match(result.nagiEn, /https:\/\/news\.example\/article/);
});

test("曲を確認できなければMyMoodSongを省略し、ニュースURLも増やさない", () => {
  const result = buildWhimsicalPostTexts({
    textJa: "今日はのんびりだよ",
    textEn: "Taking it easy today",
  });

  assert.equal(result.bskyJa, "今日はのんびりだよ");
  assert.doesNotMatch(result.bskyJa, /MyMoodSong|Not found/);
  assert.equal(result.nagiJa, result.bskyJa);
  assert.equal(result.nagiEn, result.bskyEn);
});

test("Nagi選出時は両方のおやすみ本文へスレッドURLを1回追加する", () => {
  const result = buildGoodNightPostTexts({
    textJa: "今日もありがとう。おやすみー！",
    textEn: "Thank you for today. Good night!",
    sourcePost: {
      network: "nagi",
      uri: "at://did:plc:example/com.suibari.nagi.post/3mexample",
    },
  });

  const url = "https://nagi.suibari.com/thread/did%3Aplc%3Aexample/3mexample";
  assert.equal(result.sourceUrl, url);
  assert.equal(result.bsky.match(new RegExp(url, "g"))?.length, 1);
  assert.equal(result.nagiJa.match(new RegExp(url, "g"))?.length, 1);
  assert.doesNotMatch(result.nagiEn, /nagi\.suibari\.com\/thread/);
});

test("Bluesky選出時はNagi本文だけにBluesky投稿URLを追加する", () => {
  const result = buildGoodNightPostTexts({
    textJa: "今日もありがとう。おやすみー！",
    textEn: "Thank you for today. Good night!",
    sourcePost: {
      network: "bsky",
      uri: "at://did:plc:example/app.bsky.feed.post/3mexample",
    },
  });

  assert.equal(result.sourceUrl, "https://bsky.app/profile/did:plc:example/post/3mexample");
  assert.equal(
    result.bsky,
    "今日もありがとう。おやすみー！\n\nThank you for today. Good night!",
  );
  assert.equal(result.nagiJa, "今日もありがとう。おやすみー！\n\nhttps://bsky.app/profile/did:plc:example/post/3mexample");
  assert.equal(result.nagiEn, "Thank you for today. Good night!");
});

test("不正なAT URIからNagiスレッドURLを作らない", () => {
  assert.equal(
    getNagiThreadUrl("at://did:plc:example/app.bsky.feed.post/rkey"),
    undefined,
  );
  assert.equal(getNagiThreadUrl("https://example.com/post"), undefined);
});

test("今日覚えた言葉は件数と日本語文字数の両方で絞る", () => {
  const selected = selectGoodNightLearnedTerms([
    { label: "葬送のフリーレン" },
    { label: "ぬいぐるみ" },
    { label: "ブルアカ" },
    { label: "4件目" },
  ]);

  assert.deepEqual(selected.map((term) => term.label), [
    "葬送のフリーレン",
    "ぬいぐるみ",
    "ブルアカ",
  ]);
});

test("長い言葉は飛ばして後続を拾い、日本語文字数の上限は超えない", () => {
  // 1件目だけで textEn の日本語混入ガードを埋め切る長さ。ここで打ち切ると
  // 「今日は何も覚えなかった」になってしまう。
  const selected = selectGoodNightLearnedTerms([
    { label: "とても長い名前のついた架空の作品タイトルその一" },
    { label: "ブルアカ" },
  ]);

  assert.deepEqual(selected.map((term) => term.label), ["ブルアカ"]);
});

test("候補が無ければ空のまま返す", () => {
  assert.deepEqual(selectGoodNightLearnedTerms([]), []);
});

test("Bluesky投稿URLはDIDを使い、別collectionや不正なURIを拒否する", () => {
  assert.equal(getBlueskyPostUrl("at://did:web:example.com/app.bsky.feed.post/abc"),
    "https://bsky.app/profile/did:web:example.com/post/abc");
  for (const uri of ["https://example.com/post", "at://did:plc:example/com.suibari.nagi.post/abc",
    "at://did:plc:example/app.bsky.feed.post/", "at://did:plc:example/app.bsky.feed.post/abc/extra"]) {
    assert.equal(getBlueskyPostUrl(uri), undefined);
  }
});

test("Nagiブログ選出時は両方の本文にブログ専用URLを追加する", () => {
  const result = buildGoodNightPostTexts({
    textJa: "おやすみ！", textEn: "Good night!",
    sourcePost: { network: "nagi", uri: "at://did:plc:example/site.standard.document/article" },
  });
  const url = "https://nagi.suibari.com/blog/did%3Aplc%3Aexample/article";
  assert.equal(result.sourceUrl, url);
  assert.equal(result.bsky, `おやすみ！\n\nGood night!\n\n${url}`);
  assert.equal(result.nagiJa, `おやすみ！\n\n${url}`);
  assert.equal(result.nagiEn, "Good night!");
});
