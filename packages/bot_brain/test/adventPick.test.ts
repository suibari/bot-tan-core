import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAdventPickCandidates,
  buildAdventPickInstruction,
} from "../src/ai/generateAdventPick.js";

const input = {
  day: 3,
  candidates: [
    { displayName: "あい", date: "2026-08-01", text: "庭のミニトマトが初めて赤くなった！" },
    { displayName: "うえ", date: "2026-09-10", text: "おはよう" },
  ],
};

test("指示にはユーザーのポストを入れない（ポストは最後のパートだけ）", () => {
  const instruction = buildAdventPickInstruction(input);
  assert.match(instruction, /3 日目/);
  assert.doesNotMatch(instruction, /ミニトマト/);
  const candidates = buildAdventPickCandidates(input);
  assert.match(candidates, /1\. あい（2026-08-01）\n庭のミニトマトが初めて赤くなった！/);
  assert.match(candidates, /2\. うえ（2026-09-10）\nおはよう/);
});

import { adventCardTextProblem, buildAdventTextInstruction, buildAdventTextPost } from "../src/ai/generateAdventPick.js";

const ok = {
  titleJa: "焼きたてのメロンパン",
  commentJa: "ふわふわのメロンパン、いい匂いがしたよ！みんなにもおすそわけ",
  titleEn: "First melon bread",
  commentEn: "Your fluffy melon bread looked so good!",
};

test("カードの文面の検査", () => {
  assert.equal(adventCardTextProblem(ok, "あい"), undefined);
  // 2026-11-08 の実例: 見出しに一言の書きかけ、一言に作業メモ。
  assert.notEqual(adventCardTextProblem({ ...ok, titleJa: "自転車のメンテナンス結果，ねむねむさん！ 地元の" }, "ねむねむ"), undefined);
  assert.equal(adventCardTextProblem({ ...ok, commentJa: "選んだポスト：12. ヨウ 見出し：美容液 一言：やったね" }, "ヨウ"), "meta leaked");
  assert.equal(adventCardTextProblem({ ...ok, commentJa: ok.titleJa + "だね！うれしいね" }, "あい"), "comment repeats title");
  assert.equal(adventCardTextProblem({ ...ok, titleJa: "あいさんのパン" }, "あいさん"), "name in title");
  assert.equal(adventCardTextProblem({ ...ok, commentEn: "メロンパン is great" }, "あい"), "english has japanese");
  assert.equal(adventCardTextProblem({ ...ok, titleEn: "" }, "あい"), "english missing");
});

test("書く段のプロンプトは指示が先、ポストが後", () => {
  assert.doesNotMatch(buildAdventTextInstruction(3), /ミニトマト/);
  assert.match(buildAdventTextPost(input.candidates[0]), /あいさん・2026-08-01[\s\S]*ミニトマト/);
});
