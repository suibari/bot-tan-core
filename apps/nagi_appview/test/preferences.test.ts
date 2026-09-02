import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { NAGI_SUPPORTED_LANGUAGES } =
  await import("@bsky-affirmative-bot/nagi-lexicon");
const { parseLanguagePreferences, parseModerationPreferences } =
  await import("../src/queries/preferences.js");

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
