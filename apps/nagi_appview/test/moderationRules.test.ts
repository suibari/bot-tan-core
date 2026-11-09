import assert from "node:assert/strict";
import test from "node:test";
import {
  ADULT_LABELS,
  DEFAULT_THRESHOLDS,
  EXPLICIT_TERM_CATEGORY,
  GENERATION_OBSERVE_ONLY_CATEGORIES,
  evaluateScores,
  evaluateSeparatedScores,
  mapCategoryToLabel,
} from "../src/services/moderation/rules.js";

test("maps sexual categories to the right labels", () => {
  assert.equal(mapCategoryToLabel("sexual"), "sexual");
  assert.equal(mapCategoryToLabel("sexual/minors"), "!hide");
});

test("maps hate and harassment to the right labels", () => {
  assert.equal(mapCategoryToLabel("hate"), "hate");
  assert.equal(mapCategoryToLabel("hate/threatening"), "hate");
  assert.equal(mapCategoryToLabel("harassment"), "harassment");
  assert.equal(mapCategoryToLabel("harassment/threatening"), "harassment");
});

test("maps violence and self-harm to the right labels", () => {
  assert.equal(mapCategoryToLabel("violence/graphic"), "graphic-media");
  assert.equal(mapCategoryToLabel("violence"), "!warn");
  assert.equal(mapCategoryToLabel("self-harm"), "!warn");
  assert.equal(mapCategoryToLabel("self-harm/intent"), "!warn");
});

test("allows clean content", () => {
  const evaluation = evaluateScores({
    sexual: 0.01,
    hate: 0.005,
    violence: 0.02,
    "self-harm": 0.001,
  });
  assert.equal(evaluation.decision, "allow");
  assert.equal(evaluation.labels.length, 0);
});

test("does not label borderline content", () => {
  const evaluation = evaluateScores({ sexual: 0.5, hate: 0.01 });
  assert.equal(evaluation.decision, "allow");
  assert.equal(evaluation.highestCategory, "sexual");
  assert.equal(evaluation.maxScore, 0.5);
});

test("labels sensitive content above the category threshold", () => {
  const evaluation = evaluateScores({ sexual: 0.85, hate: 0.01 });
  assert.equal(evaluation.decision, "label");
  assert.ok(evaluation.labels.includes("sexual"));
});

test("rejects severe policy violations", () => {
  const evaluation = evaluateScores({
    "hate/threatening": 0.9,
    harassment: 0.8,
  });
  assert.equal(evaluation.decision, "reject-policy");
  assert.ok(evaluation.labels.includes("hate"));
});

test("rejects sexual content involving minors at a very low score", () => {
  const evaluation = evaluateScores({ "sexual/minors": 0.25 });
  assert.equal(evaluation.decision, "reject-policy");
  assert.ok(evaluation.labels.includes("!hide"));
});

/**
 * 実データでの回帰。水着画像の投稿を omni-moderation にかけた実測値
 * （本文 0.601 / 画像 0.208）ではラベルを付けない、というのが現行方針。
 * 閾値を触ったときにこの線引きが動いたら気付けるようにしておく。
 */
test("leaves a swimsuit post unlabeled at the measured scores", () => {
  assert.equal(evaluateScores({ sexual: 0.601 }).decision, "allow");
  assert.equal(evaluateScores({ sexual: 0.208 }).decision, "allow");
});

test("sexual passes the label threshold only above 0.75", () => {
  assert.equal(evaluateScores({ sexual: 0.74 }).decision, "allow");
  assert.equal(evaluateScores({ sexual: 0.76 }).decision, "label");
});

test("only supported label values are emitted", () => {
  const evaluation = evaluateScores({ "violence/graphic": 0.95, sexual: 0.99 });
  for (const label of evaluation.labels) {
    assert.ok(
      ["sexual", "nudity", "graphic-media", "hate", "harassment", "!warn", "!hide"].includes(
        label,
      ),
      `unexpected label ${label}`,
    );
  }
});

test("adult labels cover every value that blurs media", () => {
  for (const label of ["sexual", "nudity", "graphic-media", "!hide"])
    assert.ok((ADULT_LABELS as readonly string[]).includes(label));
  // !warn と hate/harassment はクライアント設定に委ねる（サーバ強制しない）。
  for (const label of ["!warn", "hate", "harassment"])
    assert.ok(!(ADULT_LABELS as readonly string[]).includes(label));
});

test("category overrides are stricter than the defaults where it matters", () => {
  const minors = DEFAULT_THRESHOLDS.categoryOverrides?.["sexual/minors"];
  assert.ok(minors);
  assert.ok(minors.reject! < DEFAULT_THRESHOLDS.rejectThreshold);
  assert.ok(minors.label! < DEFAULT_THRESHOLDS.labelThreshold);
});

test("violent anime impressions remain unrestricted, with observation reasons", () => {
  const result = evaluateSeparatedScores({
    text: { violence: 0.999, "violence/graphic": 0.999 }, image: {},
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.labels, []);
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.every(reason => reason.includes("[TEXT] [OBSERVE]")));
});

test("text violence cannot mask graphic or sexual images", () => {
  for (const image of [{ "violence/graphic": 0.95 }, { sexual: 0.99 }]) {
    const result = evaluateSeparatedScores({ text: { violence: 1 }, image });
    assert.equal(result.decision, "reject-policy");
    assert.ok(result.labels.length > 0);
    assert.ok(result.reasons.some(reason => reason.includes("[IMAGE] [REJECT]")));
  }
});

test("other text categories retain their existing restrictions", () => {
  const result = evaluateSeparatedScores({
    text: { "hate/threatening": 0.9, violence: 1 }, image: {},
  });
  assert.equal(result.decision, "reject-policy");
  assert.deepEqual(result.labels, ["hate"]);
});

test("image labels survive higher unrestricted text scores", () => {
  const result = evaluateSeparatedScores({ text: { violence: 1 }, image: { sexual: 0.85 } });
  assert.equal(result.decision, "label");
  assert.deepEqual(result.labels, ["sexual"]);
});

/**
 * 2026-11-09 の誤判定の実測値。「生徒会にも穴がある、の5話が :eichi: すぎて…
 * 性癖に刺さる」は sexual 0.375 / sexual/minors 0.197 で !hide が付いていた。
 */
test("text sexual/minors is observed, not labeled", () => {
  const result = evaluateSeparatedScores({
    text: { sexual: 0.375, "sexual/minors": 0.197, violence: 0.083 },
    image: {},
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.labels, []);
  assert.ok(result.reasons.some(reason => reason.includes("[TEXT] [OBSERVE] sexual/minors")));
});

test("text sexual/minors never rejects, however high", () => {
  const result = evaluateSeparatedScores({ text: { "sexual/minors": 0.99 }, image: {} });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.labels, []);
});

test("image sexual/minors keeps the strict thresholds", () => {
  const labeled = evaluateSeparatedScores({ text: {}, image: { "sexual/minors": 0.15 } });
  assert.equal(labeled.decision, "label");
  assert.deepEqual(labeled.labels, ["!hide"]);
  const rejected = evaluateSeparatedScores({ text: {}, image: { "sexual/minors": 0.25 } });
  assert.equal(rejected.decision, "reject-policy");
});

test("generation prompts still block text sexual/minors", () => {
  const result = evaluateSeparatedScores(
    { text: { "sexual/minors": 0.15 }, image: {} },
    { textObserveOnly: GENERATION_OBSERVE_ONLY_CATEGORIES },
  );
  assert.equal(result.decision, "label");
  assert.deepEqual(result.labels, ["!hide"]);
});

/** 2026-11-07「パイズリ」単独の実測値は sexual 0.099 で素通りしていた。 */
test("an explicit term labels the post sexual even when scores are low", () => {
  const result = evaluateSeparatedScores(
    { text: { sexual: 0.099, violence: 0.01 }, image: {} },
    { explicitTerms: ["パイズリ"] },
  );
  assert.equal(result.decision, "label");
  assert.deepEqual(result.labels, ["sexual"]);
  assert.equal(result.highestCategory, EXPLICIT_TERM_CATEGORY);
  assert.equal(result.maxScore, 1);
  assert.ok(result.reasons.includes("[TEXT] [KEYWORD] sexual: パイズリ"));
});

test("an explicit term does not weaken a stronger decision", () => {
  const result = evaluateSeparatedScores(
    { text: { "hate/threatening": 0.9 }, image: {} },
    { explicitTerms: ["フェラ"] },
  );
  assert.equal(result.decision, "reject-policy");
  assert.deepEqual(result.labels.sort(), ["hate", "sexual"]);
  assert.equal(result.highestCategory, "hate/threatening");
});

test("no explicit terms leaves the score-based decision untouched", () => {
  const result = evaluateSeparatedScores({ text: { sexual: 0.099 }, image: {} }, { explicitTerms: [] });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.labels, []);
});
