import assert from "node:assert/strict";
import test from "node:test";
import {
  ZENKATSU_MAX_CARDS,
  ZENKATSU_MAX_REST_DAYS,
  ZENKATSU_REST_DAYS,
  isValidZenkatsuSelection,
  zenkatsuAvailability,
  zenkatsuRestWindowStart,
  type ZenkatsuHolding,
} from "../src/zenkatsu.js";

const N: ZenkatsuHolding = { volume: 1, id: 1, rarity: "N", stock: 1 };
const AAR: ZenkatsuHolding = { volume: 1, id: 30, rarity: "AAR", stock: 1 };

test("おやすみ日数はレアが上がるほど長い（排出率と逆相関）", () => {
  assert.ok(
    ZENKATSU_REST_DAYS.N < ZENKATSU_REST_DAYS.R &&
      ZENKATSU_REST_DAYS.R < ZENKATSU_REST_DAYS.SR &&
      ZENKATSU_REST_DAYS.SR < ZENKATSU_REST_DAYS.UR &&
      ZENKATSU_REST_DAYS.UR < ZENKATSU_REST_DAYS.AAR,
  );
  assert.equal(ZENKATSU_MAX_REST_DAYS, ZENKATSU_REST_DAYS.AAR);
});

test("出していない札は在庫ぶん出せる", () => {
  const r = zenkatsuAvailability([{ ...N, stock: 3 }], [], "2026-09-19");
  assert.deepEqual(r, [{ volume: 1, id: 1, available: 3 }]);
});

test("出した札は rest 日ぶんおやすみし、rest+1 日目に戻る", () => {
  const play = [{ volume: 1, id: 1, themeDate: "2026-09-19" }];
  // N は2日おやすみ。出した当日と翌日・翌々日は出せない。
  for (const [day, expected] of [
    ["2026-09-19", 0],
    ["2026-09-20", 0],
    ["2026-09-21", 0],
    ["2026-09-22", 1],
  ] as const) {
    const [r] = zenkatsuAvailability([N], play, day);
    assert.equal(r.available, expected, day);
  }
});

test("おやすみ中は残り日数が付く", () => {
  const play = [{ volume: 1, id: 1, themeDate: "2026-09-19" }];
  assert.equal(zenkatsuAvailability([N], play, "2026-09-19")[0].restingDays, 3);
  assert.equal(zenkatsuAvailability([N], play, "2026-09-21")[0].restingDays, 1);
  assert.equal(zenkatsuAvailability([N], play, "2026-09-22")[0].restingDays, undefined);
});

test("被りは在庫になる（duplicate_count が生きる）", () => {
  // 3枚持っていれば3日連続で出せる。N は2日おやすみなので4日目には1枚目が戻る。
  const holding = [{ ...N, stock: 3 }];
  const plays = [
    { volume: 1, id: 1, themeDate: "2026-09-19" },
    { volume: 1, id: 1, themeDate: "2026-09-20" },
    { volume: 1, id: 1, themeDate: "2026-09-21" },
  ];
  assert.equal(zenkatsuAvailability(holding, plays.slice(0, 1), "2026-09-20")[0].available, 2);
  assert.equal(zenkatsuAvailability(holding, plays.slice(0, 2), "2026-09-21")[0].available, 1);
  assert.equal(zenkatsuAvailability(holding, plays, "2026-09-22")[0].available, 1);
});

test("AAR は7日おやすみ（週1しか出せない重み）", () => {
  const play = [{ volume: 1, id: 30, themeDate: "2026-09-19" }];
  assert.equal(zenkatsuAvailability([AAR], play, "2026-09-25")[0].available, 0);
  assert.equal(zenkatsuAvailability([AAR], play, "2026-09-26")[0].available, 0);
  assert.equal(zenkatsuAvailability([AAR], play, "2026-09-27")[0].available, 1);
});

test("他の札の提出はおやすみに影響しない", () => {
  const plays = [{ volume: 1, id: 2, themeDate: "2026-09-19" }];
  assert.equal(zenkatsuAvailability([N], plays, "2026-09-19")[0].available, 1);
});

test("未来日付の提出は在庫を減らさない（遡り書き込みの防御）", () => {
  const plays = [{ volume: 1, id: 1, themeDate: "2099-01-01" }];
  assert.equal(zenkatsuAvailability([N], plays, "2026-09-19")[0].available, 1);
});

test("遡る範囲はいちばん長いおやすみを覆う", () => {
  assert.equal(zenkatsuRestWindowStart("2026-09-19"), "2026-09-12");
  // 月またぎ・年またぎでも壊れない。
  assert.equal(zenkatsuRestWindowStart("2026-01-03"), "2025-12-27");
});

test("選択の形: 1〜3枚、重複なし", () => {
  assert.ok(isValidZenkatsuSelection([{ volume: 1, id: 1 }]));
  assert.ok(
    isValidZenkatsuSelection([
      { volume: 1, id: 1 },
      { volume: 1, id: 2 },
      { volume: 0, id: 202601 },
    ]),
  );
  assert.equal(isValidZenkatsuSelection([]), false);
  assert.equal(
    isValidZenkatsuSelection(
      Array.from({ length: ZENKATSU_MAX_CARDS + 1 }, (_, i) => ({
        volume: 1,
        id: i + 1,
      })),
    ),
    false,
  );
  // 同じ日に同じ札は1枚まで。
  assert.equal(
    isValidZenkatsuSelection([
      { volume: 1, id: 1 },
      { volume: 1, id: 1 },
    ]),
    false,
  );
  assert.equal(isValidZenkatsuSelection([{ volume: 1, id: 0 }]), false);
  assert.equal(isValidZenkatsuSelection([{ volume: -1, id: 1 }]), false);
});
