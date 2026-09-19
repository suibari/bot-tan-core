import { randomInt } from "node:crypto";
import cardsV1 from "./json/cards_v1.json" with { type: "json" };

/**
 * 全肯定カード（1日1回引けるトレカ）の定義。
 *
 * カード定義は静的な JSON（json/cards_v1.json）が真実源で、DB には持たない。
 * 持っているのは「誰がどのカードを持っているか」だけ（nagi.card_instances）。
 * よってフレーバーの誤字修正などは JSON を直すだけで全ユーザーに反映される。
 *
 * カードの同一性は **(volume, id) の組** で決まる。id は段（volume）内での通し番号で、
 * 図鑑の並び順そのもの＝コレクションでの表示位置でもある。
 *
 * **一度リリースした (volume, id) は絶対に変更してはならない。** nagi.card_instances の
 * (card_volume, card_number) から永続参照され、将来の交換・バッジ装備でも参照され続けるため、
 * 番号の振り直しは所持データの破壊になる。段の途中にカードを差し込むこともできない
 * （新しいカードは次の段に足す）。
 */

export const CARD_RARITIES = ["N", "R", "SR", "UR", "AAR"] as const;
export type CardRarity = (typeof CARD_RARITIES)[number];

export const CARD_ATTRIBUTES = [
  "light",
  "dark",
  "fire",
  "water",
  "wind",
  "earth",
] as const;
export type CardAttribute = (typeof CARD_ATTRIBUTES)[number];

/**
 * カードの種族。属性と違い、定義側では長らく自由文字列だったのでここに正典を置く。
 *
 * お題（themes_v1.json）が「追い風の種族」を名前で指名するため、表記ゆれが入ると
 * どのカードにも一致せず、エラーも出ないまま追い風が黙って無効になる。
 * **一度リリースした種族名は変更しない**（カード定義とお題の双方から名前で参照される）。
 */
export const CARD_RACES = [
  { ja: "応援族", en: "Cheer" },
  { ja: "妖精族", en: "Fairy" },
  { ja: "家事族", en: "Chore" },
  { ja: "収集族", en: "Collector" },
  { ja: "記録族", en: "Archivist" },
  { ja: "冒険族", en: "Explorer" },
  { ja: "機械族", en: "Machine" },
  { ja: "粘体族", en: "Slime" },
  { ja: "信奉族", en: "Devotee" },
  { ja: "天候族", en: "Weather" },
  { ja: "天使族", en: "Angel" },
  { ja: "戦士族", en: "Warrior" },
  { ja: "社畜族", en: "Wageworker" },
  { ja: "創作族", en: "Creator" },
  { ja: "獣族", en: "Beast" },
  { ja: "魔法使い族", en: "Spellcaster" },
  { ja: "猫又族", en: "Nekomata" },
  { ja: "JK族", en: "JK" },
  { ja: "不死族", en: "Undead" },
  { ja: "幻蝶族", en: "Mythic Butterfly" },
] as const;

/** 種族の日本語名。お題はこれをキーに追い風の種族を指名する。 */
export type CardRaceJa = (typeof CARD_RACES)[number]["ja"];

const RACE_EN_BY_JA = new Map<string, string>(
  CARD_RACES.map((r) => [r.ja, r.en]),
);

/** 種族の英語名を引く。未知の種族なら undefined。 */
export function cardRaceEn(raceJa: string): string | undefined {
  return RACE_EN_BY_JA.get(raceJa);
}

/** その種族が正典にあるか。お題定義の検証から使う。 */
export function isCardRaceJa(value: unknown): value is CardRaceJa {
  return typeof value === "string" && RACE_EN_BY_JA.has(value);
}

export interface CardDefinition {
  /** 段内の通し番号（1始まり）。図鑑の並び順＝コレクションでの表示位置。 */
  id: number;
  /** カード段。初段=1。 */
  volume: number;
  rarity: CardRarity;
  attribute: CardAttribute;
  atk: number;
  def: number;
  nameJa: string;
  nameEn: string;
  raceJa: string;
  raceEn: string;
  textJa: string;
  textEn: string;
  /**
   * カード面に敷く背景画像のベース名。省略すると今までどおり文字だけのカードになる。
   * 実体は nagi_client の `static/card-art/{art}.webp`（記念日は `anniv-{id}`、通常段は `v{volume}-{id}`）。
   * 画像は別リポジトリにあるので、名前がズレても背景が出ないだけで壊れない。
   */
  art?: string;
}

/** `art` はそのまま URL に埋まるので、パスになりうる文字を一切入れさせない。 */
export const CARD_ART_PATTERN = /^[a-z0-9-]+$/;

/** 最新の段（volume）。二段目を出すときはここを上げ、cards_v2.json を足して CARD_DEFS に連結する。 */
export const CARD_VOLUME_LATEST = 1;

/**
 * レアリティごとの排出確率。合計が 1 になること（assertCardDefs で検証する）。
 * 期待値は N=1.4日, R=約4.5日, SR=約12.5日, UR=約55日, AAR=約500日に1回。
 */
export const RARITY_WEIGHTS: Record<CardRarity, number> = {
  N: 0.68,
  R: 0.22,
  SR: 0.08,
  UR: 0.018,
  AAR: 0.002,
};

/** 初段の想定枚数。JSON を書き換えたときに事故らないよう起動時に照合する。 */
const EXPECTED_COUNTS_V1: Record<CardRarity, number> = {
  N: 12,
  R: 9,
  SR: 6,
  UR: 2,
  AAR: 1,
};

/**
 * 定義 JSON の健全性チェック。壊れた定義のままガチャを回すと所持データが汚れて戻せないので、
 * 起動時に落とす（= 本番に壊れた JSON をデプロイした時点で気付ける）。
 */
function assertCardDefs(defs: CardDefinition[]): CardDefinition[] {
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  defs.forEach((card, index) => {
    const key = cardKey(card);
    if (seen.has(key)) throw new Error(`cards: duplicated card ${cardCode(card)}`);
    seen.add(key);
    // 配列の並び＝図鑑の並び＝id の昇順。ここがずれると表示位置と番号が食い違う。
    if (card.id !== index + 1)
      throw new Error(
        `cards: id must be sequential from 1 in file order (expected ${index + 1}, got ${card.id})`,
      );
    if (!CARD_RARITIES.includes(card.rarity))
      throw new Error(`cards: unknown rarity "${card.rarity}" (${card.id})`);
    if (!CARD_ATTRIBUTES.includes(card.attribute))
      throw new Error(
        `cards: unknown attribute "${card.attribute}" (${card.id})`,
      );
    for (const field of [
      "nameJa",
      "nameEn",
      "raceJa",
      "raceEn",
      "textJa",
      "textEn",
    ] as const) {
      if (!card[field]?.trim())
        throw new Error(`cards: empty ${field} (${card.id})`);
    }
    if (card.art !== undefined && !CARD_ART_PATTERN.test(card.art))
      throw new Error(`cards: invalid art "${card.art}" (${card.id})`);
    // 種族は CARD_RACES が正典。ja/en の対応まで照合するので、
    // 片方だけ直した中途半端な編集もここで落ちる。
    const raceEn = RACE_EN_BY_JA.get(card.raceJa);
    if (!raceEn)
      throw new Error(`cards: unknown race "${card.raceJa}" (${card.id})`);
    if (raceEn !== card.raceEn)
      throw new Error(
        `cards: race mismatch for "${card.raceJa}" (expected "${raceEn}", got "${card.raceEn}") (${card.id})`,
      );
    counts[card.rarity] = (counts[card.rarity] ?? 0) + 1;
  });

  const totalWeight = CARD_RARITIES.reduce(
    (sum, r) => sum + RARITY_WEIGHTS[r],
    0,
  );
  if (Math.abs(totalWeight - 1) > 1e-9)
    throw new Error(`cards: rarity weights must sum to 1 (got ${totalWeight})`);

  // 排出確率のあるレアリティに1枚も無いと、そのレアリティを引いた瞬間に抽選が破綻する。
  for (const rarity of CARD_RARITIES) {
    if (RARITY_WEIGHTS[rarity] > 0 && !counts[rarity])
      throw new Error(`cards: rarity ${rarity} has no cards`);
    const expected = EXPECTED_COUNTS_V1[rarity];
    if (counts[rarity] !== expected)
      throw new Error(
        `cards: rarity ${rarity} expects ${expected} cards, got ${counts[rarity] ?? 0}`,
      );
  }
  return defs;
}

/** 全カード定義（初段30枚）。 */
export const CARD_DEFS: readonly CardDefinition[] = assertCardDefs(
  cardsV1 as CardDefinition[],
);

const CARD_BY_ID = new Map(CARD_DEFS.map((c) => [cardKey(c), c]));
const CARDS_BY_RARITY = CARD_RARITIES.reduce(
  (acc, rarity) => {
    acc[rarity] = CARD_DEFS.filter((c) => c.rarity === rarity);
    return acc;
  },
  {} as Record<CardRarity, CardDefinition[]>,
);

/** カードを一意に指す内部キー。DB は (card_volume, card_number) の2列で持つ。 */
export function cardKey(card: { volume: number; id: number }): string {
  return `${card.volume}:${card.id}`;
}

/** カード面と図鑑に出す表示番号。例: v1-001 */
export function cardCode(card: { volume: number; id: number }): string {
  return `v${card.volume}-${String(card.id).padStart(3, "0")}`;
}

export function getCardDef(
  volume: number,
  id: number,
): CardDefinition | undefined {
  return CARD_BY_ID.get(cardKey({ volume, id }));
}

/** [0, 1) の一様乱数。ガチャなので Math.random ではなく CSPRNG を使う。 */
function secureRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/**
 * 1回分の抽選。レアリティを重みで引いてから、そのレアリティ内を均等に引く。
 * `rand` はテストで分布を検証するため差し替えられるようにしてある。
 */
export function rollCard(rand: () => number = secureRandom): CardDefinition {
  const rarity = rollRarity(rand());
  const pool = CARDS_BY_RARITY[rarity];
  // rand() が 1 を返しても範囲外を踏まないようクランプする。
  const index = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[index];
}

/** roll は [0, 1) 。境界の丸め誤差で抜けた場合は最後のレアリティ（= 最上位帯）に落ちる。 */
export function rollRarity(roll: number): CardRarity {
  let cumulative = 0;
  for (const rarity of CARD_RARITIES) {
    cumulative += RARITY_WEIGHTS[rarity];
    if (roll < cumulative) return rarity;
  }
  return CARD_RARITIES[CARD_RARITIES.length - 1];
}

/**
 * 「1日1回」の日付キー。JST 4:00 を日付境界にする（深夜勢が日付をまたいだ瞬間に
 * 2回引けてしまう違和感を避けるため。既存の getTodayNewGifts と同じ「4時始まり」）。
 *
 * サーバの TZ 設定に依存させたくないので、UTC からのオフセット計算で求める。
 * JST(=UTC+9) から 4 時間戻す ⇒ UTC に +5 時間して、その日付を取る。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_START_HOUR_JST = 4;
const SHIFT_MS = JST_OFFSET_MS - DAY_START_HOUR_JST * 60 * 60 * 1000;

/**
 * 日付キー "YYYY-MM-DD" を 1970-01-01 からの日数へ。
 *
 * カードのおやすみ日数もお題のローテも「何日目か」で数えるので、両方ここを使う。
 * 日付キー同士の引き算で済ませることで、タイムゾーンや時刻の混入を避けられる。
 */
export function dayIndexOfDateKey(dateKey: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new Error(`cards: invalid date key "${dateKey}"`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms)) throw new Error(`cards: invalid date key "${dateKey}"`);
  return Math.floor(ms / 86_400_000);
}

export function cardDrawDate(now: Date = new Date()): string {
  return new Date(now.getTime() + SHIFT_MS).toISOString().slice(0, 10);
}

/** 次に引けるようになる時刻（UTC の Date）。UI の「あと◯時間」表示に使う。 */
export function nextCardDrawAt(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + SHIFT_MS);
  const nextShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return new Date(nextShifted - SHIFT_MS);
}

/**
 * ドローの控え（com.suibari.nagi.cardGet）の rkey。
 *
 * **決定論的にする。** card_draws の自然キー `(did, draw_date, draw_source)` に対応させれば、
 * 再送しても上書きになるだけで重複しない。記念日は同じ日に複数ありうるので slot まで含める。
 *
 * クライアント（書く側）と AppView（照合する側）の双方がここを使う。片方だけで組み立てると、
 * 綴りがズレた瞬間に「控えたのに索引されない」が静かに起きる。
 */
export function cardGetRkey(
  drawDate: string,
  source: "my_nagi" | "reaction" | "anniversary",
  slot?: number,
): string {
  return source === "anniversary"
    ? `${drawDate}-anniv-${slot ?? 0}`
    : `${drawDate}-${source}`;
}
