import { CARD_DEFS, getCardDef } from "./cards.js";
import combosV1 from "./json/combos_v1.json" with { type: "json" };

/**
 * ゼンカツ！のコンボ（特定の組み合わせで発生するボーナス）。
 *
 * **隠し要素。** 出す前には見えず、成立して初めてリザルトに出る。30枚から3枚は4060通りあり
 * 自力での全探索は現実的でないので、**一度誰かが出したら記録に残して伝播させる**ことで
 * 「攻略」が成立するようにしている（発見の記録は AppView 側が持つ）。
 *
 * カード定義と同じく静的 JSON が真実源で、**一度リリースした id は変更してはならない**
 * （発見記録から永続参照されるため）。
 */

export interface ComboDefinition {
  id: number;
  volume: number;
  nameJa: string;
  nameEn: string;
  descJa: string;
  descEn: string;
  /**
   * スロットごとの「使える札」の候補（cards_v{volume}.json の id）。
   *
   * 1スロットに複数を許すのは、同じキャラの別バージョン（ラテ2種・ことみ2種）を
   * どちらでも通すため。クールダウンが重なっても片方で組めるので、成立の機会が増える。
   */
  members: number[][];
  /** 採点の倍率。 */
  bonus: number;
  /** 出す前に見せないか。今は全部 true。 */
  hidden: boolean;
}

function assertComboDefs(defs: ComboDefinition[]): ComboDefinition[] {
  const seen = new Set<string>();
  defs.forEach((combo, index) => {
    const key = `${combo.volume}:${combo.id}`;
    if (seen.has(key)) throw new Error(`combos: duplicated combo ${key}`);
    seen.add(key);
    if (combo.id !== index + 1)
      throw new Error(
        `combos: id must be sequential from 1 in file order (expected ${index + 1}, got ${combo.id})`,
      );
    if (!combo.members.length || combo.members.length > 3)
      throw new Error(`combos: members must be 1..3 slots (${key})`);
    for (const slot of combo.members) {
      if (!slot.length) throw new Error(`combos: empty slot (${key})`);
      for (const id of slot)
        // 実在しない札を指すコンボは永久に成立しない。黙って死ぬので起動時に落とす。
        if (!getCardDef(combo.volume, id))
          throw new Error(`combos: unknown card ${combo.volume}-${id} (${key})`);
    }
    // 同じ札が2つのスロットに現れると、1枚で2スロットを埋めたように見えてしまう。
    const flat = combo.members.flat();
    if (new Set(flat).size !== flat.length)
      throw new Error(`combos: a card appears in more than one slot (${key})`);
    if (!(combo.bonus > 1))
      throw new Error(`combos: bonus must be greater than 1 (${key})`);
    for (const field of ["nameJa", "nameEn", "descJa", "descEn"] as const)
      if (!combo[field]?.trim())
        throw new Error(`combos: empty ${field} (${key})`);
  });
  return defs;
}

export const COMBO_DEFS: readonly ComboDefinition[] = assertComboDefs(
  combosV1 as ComboDefinition[],
);

export const COMBO_VOLUME_LATEST = 1;

export function comboKey(combo: { volume: number; id: number }): string {
  return `${combo.volume}:${combo.id}`;
}

const COMBO_BY_KEY = new Map(COMBO_DEFS.map((c) => [comboKey(c), c]));

export function getComboDef(
  volume: number,
  id: number,
): ComboDefinition | undefined {
  return COMBO_BY_KEY.get(comboKey({ volume, id }));
}

/**
 * 出した札で成立するコンボを返す。
 *
 * 各スロットに別々の札を割り当てられるときだけ成立する（1枚で2スロットは埋められない）。
 * スロットは最大3、手札も最大3なので、素直な全探索で足りる。
 *
 * **部分集合になっているコンボは落とす。** 例えば「モルフォ三態」(相棒+子犬+蝶) は
 * 「モルフォ親子」(相棒+子犬) と「蝶と相棒」(蝶+相棒) を内包するので、そのまま数えると
 * 2.0 × 2.0 × 2.8 = **11.2倍** になって倍率が暴走する。大きいほうだけを残す。
 */
export function matchCombos(
  cards: readonly { volume: number; id: number }[],
): ComboDefinition[] {
  const matched: { combo: ComboDefinition; used: Set<number> }[] = [];
  for (const combo of COMBO_DEFS) {
    const used = new Set<number>();
    const ok = combo.members.every((slot) => {
      const at = cards.findIndex(
        (card, index) =>
          !used.has(index) &&
          card.volume === combo.volume &&
          slot.includes(card.id),
      );
      if (at < 0) return false;
      used.add(at);
      return true;
    });
    if (ok) matched.push({ combo, used });
  }

  const isProperSubset = (a: Set<number>, b: Set<number>) =>
    a.size < b.size && [...a].every((index) => b.has(index));

  return matched
    .filter(({ used }) => !matched.some((other) => isProperSubset(used, other.used)))
    .map(({ combo }) => combo);
}

/** 図鑑に出す、コンボの総数。 */
export const COMBO_TOTAL = COMBO_DEFS.length;

/** N だけで組めるコンボがあるか（新規でも触れる入口の確認用）。 */
export function combosReachableWithRarity(rarity: string): ComboDefinition[] {
  return COMBO_DEFS.filter((combo) =>
    combo.members.every((slot) =>
      slot.some((id) => CARD_DEFS.find((c) => c.id === id)?.rarity === rarity),
    ),
  );
}
