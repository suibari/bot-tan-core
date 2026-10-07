import assert from "node:assert/strict";
import test from "node:test";
import {
  UnsourcedUrlError,
  assertSourcedUrls,
  createUrlAllowance,
  extractUrls,
  findUnsourcedUrls,
} from "../src/ai/urlGuard.js";

test("URL の切り出しは ASCII 以外と末尾の句読点を含めない", () => {
  assert.deepEqual(
    extractUrls("見てね https://example.com/a。 https://room.bot-tan.comだよ (https://b.example/x)"),
    ["https://example.com/a", "https://room.bot-tan.com", "https://b.example/x"],
  );
});

test("材料に無い URL だけを返す", () => {
  // 2026-10-06 の現物。材料にあったのは表示名だけ。
  const allowance = createUrlAllowance({
    materials: [{ follower: { displayName: "📛 Transgender Mahou Shoujo  🦊 | 🌹🌙🌲" }, posts: ["We did it!"] }],
  });
  assert.deepEqual(
    findUnsourcedUrls("おやすみ！ https://x.com/TransgenderMahouShoujo 🦊|🌹🌙🌲", allowance),
    ["https://x.com/TransgenderMahouShoujo"],
  );
});

test("材料にある URL は表記ゆれ（末尾スラッシュ・大文字・スキーム無し）を許す", () => {
  const allowance = createUrlAllowance({
    materials: [
      "ダッシュボード：URLは https://bot-tan.com/",
      { embed: { uri_embed: "https://Example.com/Page" } },
      ["投稿: nowplayingat.suibari.com を使ってるよ"],
    ],
  });
  assert.deepEqual(
    findUnsourcedUrls(
      "https://bot-tan.com と https://example.com/page と https://nowplayingat.suibari.com/ を見てね",
      allowance,
    ),
    [],
  );
});

test("材料の中の部分一致では出典ありとしない", () => {
  const allowance = createUrlAllowance({ materials: ["https://netflix.com/title/1 と mybox.com"] });
  assert.deepEqual(findUnsourcedUrls("https://x.com と https://box.com", allowance), [
    "https://x.com",
    "https://box.com",
  ]);
});

test("origins で許可した自前サービスは材料に無くても通す", () => {
  const allowance = createUrlAllowance({ origins: ["https://room.bot-tan.com"] });
  assert.deepEqual(findUnsourcedUrls("https://room.bot-tan.com/gifts と https://evil.example", allowance), [
    "https://evil.example",
  ]);
});

test("assertSourcedUrls は複数の本文をまとめて検査し、経路名つきで投げる", () => {
  const allowance = createUrlAllowance({ materials: ["https://ok.example"] });
  assert.doesNotThrow(() => assertSourcedUrls(["https://ok.example", undefined, ""], allowance, "test"));
  assert.throws(
    () => assertSourcedUrls(["https://ok.example", "https://ng.example"], allowance, "whimsical post"),
    (error: unknown) =>
      error instanceof UnsourcedUrlError &&
      error.urls.join() === "https://ng.example" &&
      /whimsical post wrote an unexpected URL/.test(error.message),
  );
});
