import assert from "node:assert/strict";
import test from "node:test";
import { researchFailureState, researchSubjectHash } from "../src/researchJobs.js";

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

test("キューに積むのは語だけで、URLは扱わない", () => {
  // URL はその場で読む（grounding.ts）。非同期に回すと「次に同じリンクが来たら
  // 答えられる」になってしまい、実際の会話では役に立たない。
  const a = researchSubjectHash("薬屋のひとりごと");
  assert.equal(researchSubjectHash(" 薬屋のひとりごと "), a);
  assert.notEqual(researchSubjectHash("ブラッククローバー"), a);
});

test("やり直しても変わらない失敗は、試行回数に関係なくその場で failed にする", () => {
  // 検索は成功したが何も見つからない語を3回やり直すと、その分だけ上流を叩く。
  // 本番の検索の大半がこの空振りの繰り返しだった（2026-11-07）。
  assert.equal(researchFailureState({ attempts: 1, maxAttempts: 3, permanent: true }), "failed");
});

test("一時的な失敗は上限まで再試行する", () => {
  assert.equal(researchFailureState({ attempts: 1, maxAttempts: 3 }), "pending");
  assert.equal(researchFailureState({ attempts: 2, maxAttempts: 3, permanent: false }), "pending");
  assert.equal(researchFailureState({ attempts: 3, maxAttempts: 3 }), "failed");
});
