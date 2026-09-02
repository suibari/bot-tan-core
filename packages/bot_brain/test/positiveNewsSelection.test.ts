import assert from "node:assert/strict";
import test from "node:test";
import type { PositiveNewsCandidate } from "../src/api/newsdata/index.js";
import { sanitizePositiveNewsSelection } from "../src/ai/positiveNewsSelection.js";

const candidates: PositiveNewsCandidate[] = [
  {
    articleId: "a1",
    title: "明るいニュース",
    categories: ["top"],
    link: "https://example.com/articles/a1",
  },
];

test("候補に存在する記事IDだけを採用し、内部IDを構造から除く", () => {
  const result = sanitizePositiveNewsSelection({
    greeting: "こんにちは",
    positiveNews: "うれしい発見があったよ",
    positiveNewsArticleId: "a1",
  }, candidates);

  assert.equal(result.selectedNewsArticleId, "a1");
  assert.equal(result.selectedNewsUrl, "https://example.com/articles/a1");
  assert.equal(result.structure.positiveNews, "うれしい発見があったよ");
  assert.equal("positiveNewsArticleId" in result.structure, false);
});

test("候補にない記事IDはニュースなしへ倒す", () => {
  const result = sanitizePositiveNewsSelection({
    positiveNews: "モデルが作ったニュース",
    positiveNewsArticleId: "unknown",
  }, candidates);

  assert.equal(result.selectedNewsArticleId, undefined);
  assert.equal(result.selectedNewsUrl, undefined);
  assert.equal(result.structure.positiveNews, "None");
});

test("GeminiがNoneを選んだ場合は記事を利用済みにしない", () => {
  const result = sanitizePositiveNewsSelection({
    positiveNews: "None",
    positiveNewsArticleId: "None",
  }, candidates);

  assert.equal(result.selectedNewsArticleId, undefined);
  assert.equal(result.selectedNewsUrl, undefined);
  assert.equal(result.structure.positiveNews, "None");
});

test("候補の記事URLがHTTP(S)でない場合はカード用URLを返さない", () => {
  const result = sanitizePositiveNewsSelection({
    positiveNews: "うれしい発見があったよ",
    positiveNewsArticleId: "unsafe",
  }, [{
    articleId: "unsafe",
    title: "不正なURL",
    categories: ["top"],
    link: "javascript:alert(1)",
  }]);

  assert.equal(result.selectedNewsArticleId, "unsafe");
  assert.equal(result.selectedNewsUrl, undefined);
});
