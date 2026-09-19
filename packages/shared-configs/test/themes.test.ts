import assert from "node:assert/strict";
import test from "node:test";
import { CARD_ATTRIBUTES, CARD_DEFS, isCardRaceJa } from "../src/cards.js";
import {
  THEME_DEFS,
  THEME_TONES,
  getThemeDef,
  themeCode,
  themeForDate,
} from "../src/themes.js";

test("id は段内の通し番号で、並び順＝ファイル順", () => {
  assert.deepEqual(
    THEME_DEFS.map((t) => t.id),
    Array.from({ length: THEME_DEFS.length }, (_, i) => i + 1),
  );
  for (const theme of THEME_DEFS) {
    assert.equal(getThemeDef(theme.volume, theme.id), theme);
  }
  assert.equal(getThemeDef(1, 9999), undefined);
  assert.equal(getThemeDef(99, 1), undefined);
});

test("表示番号は t1-001 形式", () => {
  assert.equal(themeCode({ volume: 1, id: 1 }), "t1-001");
  assert.equal(themeCode({ volume: 1, id: 42 }), "t1-042");
});

test("属性は正典の6種、種族は CARD_RACES にあるものだけ", () => {
  for (const theme of THEME_DEFS) {
    assert.ok(CARD_ATTRIBUTES.includes(theme.attribute), themeCode(theme));
    if (theme.raceJa !== undefined)
      assert.ok(isCardRaceJa(theme.raceJa), themeCode(theme));
    assert.ok(THEME_TONES.includes(theme.tone), themeCode(theme));
  }
});

test("追い風の属性はどれも実在のカードに当たる（外れ属性を作らない）", () => {
  // 追い風がどのカードにも当たらないと、その日だけ追い風が死ぬ。
  for (const attribute of CARD_ATTRIBUTES) {
    const used = THEME_DEFS.some((t) => t.attribute === attribute);
    if (!used) continue;
    assert.ok(
      CARD_DEFS.some((c) => c.attribute === attribute),
      `追い風 ${attribute} に該当するカードが無い`,
    );
  }
});

test("追い風の種族は、複数枚あるものだけを指名する", () => {
  // 1枚しかない種族を指名すると、その1枚を持っていない人の追い風が消える。
  const counts = new Map<string, number>();
  for (const card of CARD_DEFS)
    counts.set(card.raceJa, (counts.get(card.raceJa) ?? 0) + 1);
  for (const theme of THEME_DEFS) {
    if (theme.raceJa === undefined) continue;
    assert.ok(
      (counts.get(theme.raceJa) ?? 0) >= 1,
      `${themeCode(theme)}: 種族 ${theme.raceJa} に該当カードが無い`,
    );
  }
});

test("トーンはネタ寄り、素直は1〜3割に収まる", () => {
  const sunao = THEME_DEFS.filter((t) => t.tone === "sunao").length;
  const ratio = sunao / THEME_DEFS.length;
  assert.ok(ratio >= 0.1 && ratio <= 0.3, `素直の割合が ${ratio}`);
});

test("themeForDate は同じ日付に同じお題を返す（決定論）", () => {
  assert.equal(themeForDate("2026-09-19"), themeForDate("2026-09-19"));
  assert.notEqual(themeForDate("2026-09-19"), themeForDate("2026-09-20"));
});

test("1巡でぜんぶのお題がちょうど1回ずつ出る", () => {
  const n = THEME_DEFS.length;
  const start = new Date(Date.UTC(2026, 0, 1));
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    seen.add(themeCode(themeForDate(d.toISOString().slice(0, 10))));
  }
  assert.equal(seen.size, n);
});

test("同じお題が同じ曜日に固定されない（お題数が7の倍数でも）", () => {
  // 素朴な 日付 % 件数 だと、件数が7の倍数のとき各お題が永久に同じ曜日に出る。
  // 初段はちょうど42件なので、ここが回帰するとすぐ踏む。
  const start = new Date(Date.UTC(2026, 0, 5)); // 月曜
  const mondays = new Set<string>();
  for (let w = 0; w < 12; w++) {
    const d = new Date(start.getTime() + w * 7 * 86_400_000);
    mondays.add(themeCode(themeForDate(d.toISOString().slice(0, 10))));
  }
  assert.ok(mondays.size > 1, "月曜に同じお題しか出ていない");
});

test("1970年より前の日付でも範囲外を踏まない", () => {
  const theme = themeForDate("1969-07-20");
  assert.ok(THEME_DEFS.includes(theme));
});

test("壊れた日付キーは弾く", () => {
  assert.throws(() => themeForDate("2026-9-19"));
  assert.throws(() => themeForDate("not-a-date"));
});
