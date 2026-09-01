import assert from "node:assert/strict";
import test from "node:test";
import { researchSubjectHash } from "../src/researchJobs.js";

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
