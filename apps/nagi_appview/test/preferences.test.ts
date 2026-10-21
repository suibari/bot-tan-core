import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:testbot";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { NAGI_SUPPORTED_LANGUAGES } =
  await import("@bsky-affirmative-bot/nagi-lexicon");
const {
  parseFeedTabs,
  parseLanguagePreferences,
  parseModerationPreferences,
  upgradeLegacyFeedTabs,
} = await import("../src/queries/preferences.js");

test("投稿・翻訳設定は対応言語、browser、3プロバイダー、booleanだけを受理する", () => {
  for (const language of ["browser", ...NAGI_SUPPORTED_LANGUAGES]) {
    for (const provider of ["kagi", "deepl", "google"]) {
      assert.deepEqual(
        parseLanguagePreferences({
          post: language,
          translation: language,
          provider,
          autoTranslate: true,
        }),
        {
          post: language,
          translation: language,
          provider,
          autoTranslate: true,
        },
      );
    }
  }
  for (const invalid of [
    { post: "xx", translation: "ja", provider: "kagi", autoTranslate: true },
    { post: "ja", translation: "xx", provider: "kagi", autoTranslate: true },
    { post: "ja", translation: "en", provider: "other", autoTranslate: true },
    { post: "ja", translation: "en", provider: "kagi", autoTranslate: "yes" },
  ])
    assert.throws(() => parseLanguagePreferences(invalid));
});

test("コンテンツ表示設定は3ラベルすべてで warn/hide/ignore だけを受理する", () => {
  assert.deepEqual(
    parseModerationPreferences({
      automatic: "warn",
      selfAi: "ignore",
      selfNsfw: "hide",
    }),
    { automatic: "warn", selfAi: "ignore", selfNsfw: "hide" },
  );
  for (const invalid of [
    { automatic: "show", selfAi: "ignore", selfNsfw: "hide" },
    { automatic: "warn", selfAi: undefined, selfNsfw: "hide" },
    { automatic: "warn", selfAi: "ignore", selfNsfw: false },
  ])
    assert.throws(() => parseModerationPreferences(invalid));
});

test("hashtag タブのタグは # を外した小文字へ揃え、search タブは自由文のまま持つ", () => {
  assert.deepEqual(
    parseFeedTabs([
      { id: "t", kind: "hashtag", query: " ＃Nagi " },
      { id: "q", kind: "search", query: " Hello World " },
    ]),
    [
      { id: "t", kind: "hashtag", query: "nagi" },
      { id: "q", kind: "search", query: "Hello World" },
    ],
  );
  for (const invalid of [
    [{ id: "t", kind: "hashtag", query: "#" }],
    [{ id: "c", kind: "channel", uri: "at://did:plc:a/com.suibari.nagi.channel/1" }],
  ])
    assert.throws(() => parseFeedTabs(invalid));
});

test("廃止した channel / タグ検索のタブは hashtag タブへ寄せる", async () => {
  const channelUri = "at://did:plc:a/com.suibari.nagi.channel/1";
  const upgraded = await upgradeLegacyFeedTabs(
    [
      { id: "home", kind: "list", source: "home" },
      { id: "ch_1", kind: "channel", uri: channelUri, label: "Nagi" },
      { id: "ch_2", kind: "channel", uri: "at://did:plc:a/com.suibari.nagi.channel/gone" },
      { id: "q_1", kind: "search", query: "#nagi", queryKind: "tag" },
      { id: "q_2", kind: "search", query: "雑談", queryKind: "tag", label: "雑談" },
      { id: "q_3", kind: "search", query: "hello", queryKind: "keyword" },
    ],
    async (uris) => {
      assert.deepEqual(uris, [
        channelUri,
        "at://did:plc:a/com.suibari.nagi.channel/gone",
      ]);
      return new Map([[channelUri, "Nagi"]]);
    },
  );
  assert.deepEqual(parseFeedTabs(upgraded), [
    { id: "home", kind: "list", source: "home" },
    // 引けないチャンネルは落とし、変換後に同じタグになったタブは先の1枚だけ残す。
    { id: "ch_1", kind: "hashtag", query: "nagi" },
    { id: "q_2", kind: "hashtag", query: "雑談", label: "雑談" },
    { id: "q_3", kind: "search", query: "hello" },
  ]);
});

test("廃止した形を含まないタブはそのまま返し、チャンネルを引きに行かない", async () => {
  const tabs = [{ id: "t", kind: "hashtag", query: "nagi" }];
  const upgraded = await upgradeLegacyFeedTabs(tabs, async () => {
    throw new Error("should not load channels");
  });
  assert.equal(upgraded, tabs);
});
