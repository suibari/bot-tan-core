import assert from "node:assert/strict";
import test from "node:test";
import { CARD_ATTRIBUTES, CARD_DEFS, isCardRaceJa } from "../src/cards.js";
import {
  THEME_DEFS,
  THEME_TONES,
  getThemeDef,
  themeCode,
  pickThemeForDate,
  themeKey,
  type ThemeDefinition,
  type ThemeHistoryEntry,
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

function dateKey(start: string, offset: number): string {
  return new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** start から days 日ぶん、本番と同じく毎日1件ずつ焼き付けていく。 */
function simulate(
  start: string,
  days: number,
  defs: readonly ThemeDefinition[] = THEME_DEFS,
  history: ThemeHistoryEntry[] = [],
): ThemeHistoryEntry[] {
  for (let i = 0; i < days; i++) {
    const themeDate = dateKey(start, i);
    const theme = pickThemeForDate(themeDate, history, defs);
    history.push({ themeDate, volume: theme.volume, id: theme.id });
  }
  return history;
}

test("同じ日付・同じ履歴なら同じお題を返す（決定論）", () => {
  assert.equal(
    pickThemeForDate("2026-09-19", []),
    pickThemeForDate("2026-09-19", []),
  );
});

test("まだ出ていないお題を優先し、1巡でぜんぶちょうど1回ずつ出る", () => {
  const history = simulate("2026-01-01", THEME_DEFS.length);
  const seen = new Set(history.map(themeKey));
  assert.equal(seen.size, THEME_DEFS.length);
});

test("お題を足すと、足したお題が先に全部出る", () => {
  const old = THEME_DEFS.slice(0, 42);
  // 旧42件で2巡ちょっと回したあとに、残りを足す。
  const history = simulate("2026-01-01", 100, old);
  const added = simulate(dateKey("2026-01-01", 100), THEME_DEFS.length - 42, THEME_DEFS, [
    ...history,
  ]).slice(100);
  assert.deepEqual(
    new Set(added.map(themeKey)),
    new Set(THEME_DEFS.slice(42).map(themeKey)),
  );
});

test("全部出たあとも、最近出たお題はすぐには戻らない", () => {
  const n = THEME_DEFS.length;
  const history = simulate("2026-01-01", n * 4);
  const last = new Map<string, number>();
  history.forEach((entry, day) => {
    const key = themeKey(entry);
    const prev = last.get(key);
    if (prev !== undefined)
      assert.ok(day - prev >= Math.floor(n / 2), `${key} が ${day - prev} 日で再登場`);
    last.set(key, day);
  });
});

test("同じお題が同じ曜日に固定されない（お題数が7の倍数でも）", () => {
  // 古い順に1件ずつ取るだけだと、2巡目以降が1巡目の繰り返しになり、
  // 件数が7の倍数のとき各お題が永久に同じ曜日に出る。
  const defs = THEME_DEFS.slice(0, 42);
  const history = simulate("2026-01-05", 42 * 6, defs); // 月曜始まり
  const first = themeKey(history[0]);
  const weekdays = new Set(
    history.flatMap((entry, day) => (themeKey(entry) === first ? [day % 7] : [])),
  );
  assert.ok(weekdays.size > 1, "同じお題が同じ曜日にしか出ていない");
});

test("その日以降の履歴は無視する（さかのぼって開いた日の選択に未来を混ぜない）", () => {
  const future: ThemeHistoryEntry[] = THEME_DEFS.map((t, i) => ({
    themeDate: dateKey("2026-02-01", i),
    volume: t.volume,
    id: t.id,
  }));
  assert.equal(
    pickThemeForDate("2026-01-15", future),
    pickThemeForDate("2026-01-15", []),
  );
});

test("1970年より前の日付でも範囲外を踏まない", () => {
  const theme = pickThemeForDate("1969-07-20", []);
  assert.ok(THEME_DEFS.includes(theme));
});

test("壊れた日付キーは弾く", () => {
  assert.throws(() => pickThemeForDate("2026-9-19", []));
  assert.throws(() => pickThemeForDate("not-a-date", []));
});
