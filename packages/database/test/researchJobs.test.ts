import assert from "node:assert/strict";
import test from "node:test";
import { isResearchUrl, researchSubjectHash } from "../src/researchJobs.js";

/**
 * 主キーの正規化。
 *
 * 同じ話題を何度も調べ直すと、ローカル 26B の推論とリプライ生成が runner を
 * 奪い合う。表記の揺れで別ジョブ扱いにならないことをここで固定する。
 */

test("空白と大小文字の揺れを同じジョブとして扱う", () => {
  const base = researchSubjectHash("最新の 夏アニメ 教えて");
  assert.equal(researchSubjectHash("最新の　夏アニメ　教えて".replace(/　/g, " ")), base);
  assert.equal(researchSubjectHash("  最新の 夏アニメ 教えて  "), base);
  assert.equal(researchSubjectHash("最新の  夏アニメ\n教えて"), base);
});

test("ASCIIの大小文字を吸収する", () => {
  assert.equal(
    researchSubjectHash("Latest Summer Anime"),
    researchSubjectHash("latest summer anime"),
  );
});

test("内容が違えば別のジョブになる", () => {
  assert.notEqual(
    researchSubjectHash("夏アニメ教えて"),
    researchSubjectHash("秋アニメ教えて"),
  );
});

test("語とURLを見分ける", () => {
  // ワーカーはこの判定で「検索する」か「本文を読む」かを分岐する。
  assert.equal(isResearchUrl("https://example.com/a"), true);
  assert.equal(isResearchUrl("  http://example.com  "), true);
  assert.equal(isResearchUrl("薬屋のひとりごと"), false);
  assert.equal(isResearchUrl("ftp://example.com"), false);
  // 語の中に URL が出てきても、先頭でなければ語として扱う。
  assert.equal(isResearchUrl("これ https://example.com"), false);
});

test("同じURLは一度しか積まない", () => {
  const a = researchSubjectHash("https://example.com/a");
  assert.equal(researchSubjectHash("  https://example.com/a "), a);
  assert.notEqual(researchSubjectHash("https://example.com/b"), a);
});
