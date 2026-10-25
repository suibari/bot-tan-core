import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_ATTRIBUTES,
  CARD_DEFS,
  CARD_RARITIES,
  RARITY_WEIGHTS,
  cardCode,
  cardDrawDate,
  getCardDef,
  nextCardDrawAt,
  rollCard,
  rollRarity,
} from "../src/cards.js";

test("初段は30枚、レアリティ内訳は 12/9/6/2/1", () => {
  assert.equal(CARD_DEFS.length, 30);
  const counts = CARD_DEFS.reduce<Record<string, number>>((acc, card) => {
    acc[card.rarity] = (acc[card.rarity] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { N: 12, R: 9, SR: 6, UR: 2, AAR: 1 });
});

test("id は段内の 1..30 の通し番号で、並び順＝図鑑の配置位置", () => {
  // 配置位置が番号そのものなので、ファイル順とidがずれてはいけない。
  assert.deepEqual(
    CARD_DEFS.map((c) => c.id),
    Array.from({ length: CARD_DEFS.length }, (_, i) => i + 1),
  );
  for (const card of CARD_DEFS) {
    assert.equal(getCardDef(card.volume, card.id), card);
  }
  assert.equal(getCardDef(1, 999), undefined);
  assert.equal(getCardDef(99, 1), undefined);
});

test("表示番号は v1-001 形式（ゼロ埋め3桁）", () => {
  assert.equal(cardCode({ volume: 1, id: 1 }), "v1-001");
  assert.equal(cardCode({ volume: 1, id: 30 }), "v1-030");
  assert.equal(cardCode({ volume: 2, id: 7 }), "v2-007");
});

test("排出確率の合計は 1", () => {
  const total = CARD_RARITIES.reduce((sum, r) => sum + RARITY_WEIGHTS[r], 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `got ${total}`);
});

test("全カードが ja/en 両方のテキストを持つ", () => {
  for (const card of CARD_DEFS) {
    for (const field of [
      "nameJa",
      "nameEn",
      "raceJa",
      "raceEn",
      "textJa",
      "textEn",
    ] as const) {
      assert.ok(
        card[field].trim().length > 0,
        `${cardCode(card)}.${field} is empty`,
      );
    }
    assert.ok(CARD_ATTRIBUTES.includes(card.attribute), cardCode(card));
    assert.ok(card.atk >= 0 && card.def >= 0, cardCode(card));
    assert.equal(card.volume, 1);
  }
});

test("SR 以上はネームド、N/R はアンネームド（段の分け方の回帰テスト）", () => {
  // ネームドキャラの札は SR 以上にしか置かない、という初段の設計ルール。
  // 名前を増やすときは意図的な変更としてこのリストも更新すること。
  const named = ["botたん", "モルフォ", "ラテ", "ことみ", "全否定bot"];
  const isNamed = (text: string) => named.some((n) => text.includes(n));
  for (const card of CARD_DEFS) {
    const highRarity = ["SR", "UR", "AAR"].includes(card.rarity);
    assert.equal(
      isNamed(card.nameJa),
      highRarity,
      `${cardCode(card)} (${card.rarity}) のネームド判定が段のルールと食い違う: ${card.nameJa}`,
    );
  }
});

test("rollRarity は境界値を重みどおりに割り当てる", () => {
  assert.equal(rollRarity(0), "N");
  assert.equal(rollRarity(0.6799), "N");
  assert.equal(rollRarity(0.68), "R");
  assert.equal(rollRarity(0.8999), "R");
  assert.equal(rollRarity(0.9), "SR");
  assert.equal(rollRarity(0.9799), "SR");
  assert.equal(rollRarity(0.98), "UR");
  assert.equal(rollRarity(0.9979), "UR");
  assert.equal(rollRarity(0.998), "AAR");
  assert.equal(rollRarity(0.9999999), "AAR");
});

/** rollCard に渡す乱数列。1つ目がレアリティ、2つ目がレアリティ内の位置を決める。 */
const rolls = (...values: number[]) => {
  let i = 0;
  return () => values[i++];
};

test("rollCard は各レアリティの全カードに到達し、それ以外は返さない", () => {
  // 出現率そのものは境界値テストで決まるので、ここではレアリティ内の均等抽選が
  // プールを取りこぼしていないか（乱数の使い回しなど）を全区間の中央で走査して確かめる。
  const reached = new Set<string>();
  let lower = 0;
  for (const rarity of CARD_RARITIES) {
    const rarityRoll = lower + RARITY_WEIGHTS[rarity] / 2;
    lower += RARITY_WEIGHTS[rarity];
    const size = CARD_DEFS.filter((card) => card.rarity === rarity).length;
    for (let i = 0; i < size; i++) {
      const card = rollCard(rolls(rarityRoll, (i + 0.5) / size));
      assert.equal(card.rarity, rarity);
      reached.add(cardCode(card));
    }
  }
  assert.deepEqual([...reached].sort(), CARD_DEFS.map(cardCode).sort());
});

test("日付境界は JST 4:00（3:59 はまだ前日、4:00 で切り替わる）", () => {
  // 2026-07-25T18:59Z = JST 07-26 03:59 → まだ 07-25 の分。
  assert.equal(cardDrawDate(new Date("2026-07-25T18:59:59Z")), "2026-07-25");
  // 2026-07-25T19:00Z = JST 07-26 04:00 → 07-26 に切り替わる。
  assert.equal(cardDrawDate(new Date("2026-07-25T19:00:00Z")), "2026-07-26");
  // JST の日付をまたぐ 00:00 では切り替わらない。
  assert.equal(cardDrawDate(new Date("2026-07-25T15:00:00Z")), "2026-07-25");
});

test("nextCardDrawAt は次の JST 4:00 を返す", () => {
  assert.equal(
    nextCardDrawAt(new Date("2026-07-25T18:59:59Z")).toISOString(),
    "2026-07-25T19:00:00.000Z",
  );
  assert.equal(
    nextCardDrawAt(new Date("2026-07-25T19:00:00Z")).toISOString(),
    "2026-07-26T19:00:00.000Z",
  );
  // 月またぎでも壊れない。
  assert.equal(
    nextCardDrawAt(new Date("2026-07-31T20:00:00Z")).toISOString(),
    "2026-08-01T19:00:00.000Z",
  );
});
