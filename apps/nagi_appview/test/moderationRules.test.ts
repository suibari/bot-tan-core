import assert from "node:assert/strict";
import test from "node:test";
import {
  ADULT_LABELS,
  DEFAULT_THRESHOLDS,
  evaluateScores,
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
