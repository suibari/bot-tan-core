import assert from "node:assert/strict";
import test from "node:test";
import { CARD_DEFS } from "../src/cards.js";
import {
  COMBO_DEFS,
  combosReachableWithRarity,
  getComboDef,
  matchCombos,
} from "../src/combos.js";
import { scoreZenkatsu } from "../src/zenkatsu.js";

const card = (id: number) => ({ volume: 1, id });
const readingCard = (id: number, firstPlay = false) => {
  const def = CARD_DEFS[id - 1];
  return {
    nameJa: def.nameJa,
    rarity: def.rarity,
    attribute: def.attribute,
    raceJa: def.raceJa,
    atk: def.atk,
    def: def.def,
    stock: 1,
    firstPlay,
  };
};

test("id は連番で、指す札はすべて実在する", () => {
  assert.deepEqual(
    COMBO_DEFS.map((c) => c.id),
    Array.from({ length: COMBO_DEFS.length }, (_, i) => i + 1),
  );
  for (const combo of COMBO_DEFS) {
    assert.equal(getComboDef(combo.volume, combo.id), combo);
    for (const slot of combo.members)
      for (const id of slot) assert.ok(CARD_DEFS[id - 1], `${combo.nameJa}: ${id}`);
  }
});

test("BLTトリオは ラテ・ことみ どちらのバージョンでも成立する", () => {
  // おやすみが重なっても片方で組めるように、1スロットに複数の候補を許している。
  for (const latte of [24, 25])
    for (const kotomi of [26, 27]) {
      const hit = matchCombos([card(30), card(latte), card(kotomi)]);
      assert.ok(
        hit.some((c) => c.nameJa === "BLTトリオ"),
        `latte=${latte} kotomi=${kotomi}`,
      );
    }
});

test("1枚で2スロットは埋められない", () => {
  // ことみ2種のコンボに、片方を1枚だけ出しても成立しない。
  assert.equal(matchCombos([card(26)]).some((c) => c.nameJa === "ことみのオンとオフ"), false);
  assert.ok(matchCombos([card(26), card(27)]).some((c) => c.nameJa === "ことみのオンとオフ"));
});

test("足りない札があれば成立しない", () => {
  assert.equal(matchCombos([card(30), card(24)]).some((c) => c.nameJa === "BLTトリオ"), false);
});

test("N だけで組めるコンボが2つ以上ある（新規が触れる入口）", () => {
  // 全部が SR 以上のコンボしか無いと、始めたばかりの人が一生コンボに触れられない。
  const reachable = combosReachableWithRarity("N");
  assert.ok(reachable.length >= 2, `N で組めるコンボが ${reachable.length} 個しかない`);
});

test("追い風が多いほど隠し得点は上がる", () => {
  const theme = { attribute: "light" };
  const none = scoreZenkatsu({ theme, cards: [readingCard(2)], comboBonuses: [] });
  const one = scoreZenkatsu({ theme, cards: [readingCard(1)], comboBonuses: [] });
  assert.ok(one.value > none.value);
  assert.equal(one.tailwindCount, 1);
  assert.equal(none.tailwindCount, 0);
});

test("コンボは隠し得点を大きく押し上げる", () => {
  const theme = { attribute: "light" };
  const plain = scoreZenkatsu({
    theme,
    cards: [readingCard(1), readingCard(2), readingCard(3)],
    comboBonuses: [],
  });
  const combo = scoreZenkatsu({
    theme,
    cards: [readingCard(1), readingCard(2), readingCard(3)],
    comboBonuses: [2.0],
  });
  assert.ok(combo.value > plain.value * 1.9);
});

test("ATK/DEF は採点に影響しない（高レアを出すだけでは得をしない）", () => {
  // ここが効かないと、実測で60日かけて卓から消える N が完全に死ぬ（企画書5章）。
  const theme = { attribute: "water" };
  // 2番(N/water/ATK400) と 25番(SR/water/ATK1900)。属性も枚数も同じで ATK だけ違う。
  const weak = scoreZenkatsu({ theme, cards: [readingCard(2)], comboBonuses: [] });
  const strong = scoreZenkatsu({ theme, cards: [readingCard(25)], comboBonuses: [] });
  assert.equal(weak.value, strong.value);
});

test("1枚で出しても枚数だけで不利にはならない", () => {
  // 「1枚で決める」を選べる設計なので、枚数そのものは点に入れない。
  const theme = { attribute: "light" };
  const one = scoreZenkatsu({ theme, cards: [readingCard(1)], comboBonuses: [] });
  const two = scoreZenkatsu({
    theme,
    cards: [readingCard(1), readingCard(5)],
    comboBonuses: [],
  });
  assert.equal(one.value, two.value);
});

test("初登板はわずかに加点される", () => {
  const theme = { attribute: "light" };
  const known = scoreZenkatsu({ theme, cards: [readingCard(1, false)], comboBonuses: [] });
  const debut = scoreZenkatsu({ theme, cards: [readingCard(1, true)], comboBonuses: [] });
  assert.ok(debut.value > known.value);
  assert.equal(debut.debutCount, 1);
});

test("入れ子のコンボは大きいほうだけ残す（倍率の暴走を防ぐ）", () => {
  // モルフォ三態(相棒+子犬+蝶) は モルフォ親子(相棒+子犬) と 蝶と相棒(蝶+相棒) を内包する。
  // 全部数えると 2.0 × 2.0 × 2.8 = 11.2倍 になってしまう。
  const hits = matchCombos([card(22), card(23), card(29)]);
  assert.deepEqual(hits.map((c) => c.nameJa), ["モルフォ三態"]);

  // BLTトリオ も 親友ふたり(ラテ+ことみ) を内包する。
  const blt = matchCombos([card(30), card(24), card(26)]);
  assert.deepEqual(blt.map((c) => c.nameJa), ["BLTトリオ"]);
});

test("入れ子でない同時成立は残す", () => {
  // 肯定と否定(botたん+全否定bot) と 全肯定の系譜(伝道師+botたん) は
  // botたんを共有するだけで、どちらも相手の部分集合ではない。
  const hits = matchCombos([card(13), card(28), card(30)]);
  assert.deepEqual(
    hits.map((c) => c.nameJa).sort(),
    ["全肯定の系譜", "肯定と否定"],
  );
});

test("成立率は「たまに出る」範囲に収まっている", () => {
  // 隠し要素なので、出すぎると特別感が消え、出なさすぎると誰も発見できない。
  let hit = 0;
  let total = 0;
  for (let a = 1; a <= 30; a++)
    for (let b = a + 1; b <= 30; b++)
      for (let c2 = b + 1; c2 <= 30; c2++) {
        total += 1;
        if (matchCombos([card(a), card(b), card(c2)]).length) hit += 1;
      }
  const rate = hit / total;
  assert.ok(rate > 0.05 && rate < 0.3, `成立率が ${(rate * 100).toFixed(1)}%`);
});

test("N だけで組めるコンボが十分にある（序盤の攻略対象）", () => {
  // 全部が SR 以上だと、始めたばかりの人が何ヶ月も攻略に触れられない。
  assert.ok(combosReachableWithRarity("N").length >= 5);
});
