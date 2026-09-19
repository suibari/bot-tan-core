import assert from "node:assert/strict";
import test from "node:test";
// モジュールが db.ts と config.ts を読むので、値の import より先にダミーを入れる
// （実際には接続も参照もしない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ||= "did:web:example.invalid";
process.env.NAGI_BOT_DID ||= "did:plc:examplebot";

const { groupPioneerCombos } = await import("../src/queries/cardNews.js");
const { getComboDef } = await import("@bsky-affirmative-bot/shared-configs");

const SUBMISSION = "at://did:plc:finder/com.suibari.nagi.zenkatsu/2026-09-19";
const OTHER = "at://did:plc:other/com.suibari.nagi.zenkatsu/2026-09-19";

test("世界初の発見を提出ごとにまとめ、表示用の名前を付ける", () => {
  const def = getComboDef(1, 1)!;
  const grouped = groupPioneerCombos([
    { comboVolume: 1, comboNumber: 1, submissionUri: SUBMISSION },
  ]);
  assert.deepEqual(grouped.get(SUBMISSION), [
    {
      volume: def.volume,
      id: def.id,
      nameJa: def.nameJa,
      nameEn: def.nameEn,
      descJa: def.descJa,
      descEn: def.descEn,
    },
  ]);
});

test("発見していない提出は入らない（ニュースでは zenkatsu のまま出る）", () => {
  const grouped = groupPioneerCombos([
    { comboVolume: 1, comboNumber: 1, submissionUri: SUBMISSION },
  ]);
  // 2人目が同じコンボを出しても discoveries には行が増えないので、ここには現れない。
  assert.equal(grouped.has(OTHER), false);
  assert.equal(grouped.size, 1);
});

test("定義から消えたコンボは黙って落とす（名前の無いピルを出さない）", () => {
  const grouped = groupPioneerCombos([
    { comboVolume: 1, comboNumber: 999_999, submissionUri: SUBMISSION },
  ]);
  assert.equal(grouped.size, 0);
});

test("同じ回で複数を世界初にしたら、まとめて1件の提出に付く", () => {
  const first = getComboDef(1, 1);
  const second = getComboDef(1, 2);
  if (!first || !second) return; // コンボが1種しか無い段では検証しない
  const grouped = groupPioneerCombos([
    { comboVolume: 1, comboNumber: 1, submissionUri: SUBMISSION },
    { comboVolume: 1, comboNumber: 2, submissionUri: SUBMISSION },
  ]);
  assert.deepEqual(
    grouped.get(SUBMISSION)?.map((c) => c.id),
    [1, 2],
  );
});
