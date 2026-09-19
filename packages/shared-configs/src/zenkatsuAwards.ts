import { ZENKATSU_REST_DAYS } from "./zenkatsu.js";
import type { CardRarity } from "./cards.js";

/**
 * ゼンカツ！のトロフィー。JST 4:00 の切り替えで前日ぶんを確定する。
 *
 * **賞は1つにしない。** 毎日1人だけにすると、大多数が「取れなかった」を日次で積み上げることに
 * なり、全肯定と正面から衝突する。切り口を複数に分けて「毎日誰かしらに何か当たる」ようにし、
 * そのうえで botたん賞の特別さを保つ。
 *
 * 判定材料は提出時に計算済み（reading / score / combos）なので、追加のコストはかからない。
 */

export const ZENKATSU_AWARD_KINDS = [
  /** 今日いちばんの冒険。いちばん長くおやすみする札を切った人。 */
  "adventure",
  /** 初登板賞。初めて出す札をいちばん多く入れた人。 */
  "debut",
  /** 一枚斬り。1枚だけで答えた人。 */
  "solo",
  /** 追い風満帆。出した札が全部その日の追い風だった人。 */
  "tailwind",
  /** コンボ発見賞。その日に誰も出したことのない組み合わせを最初に出した人。 */
  "combo",
  /** botたん賞。隠し得点の上位から botたん が選ぶ。 */
  "botan",
] as const;
export type ZenkatsuAwardKind = (typeof ZENKATSU_AWARD_KINDS)[number];

/** 1件の提出のうち、賞の判定に要るぶんだけ。 */
export interface ZenkatsuAwardCandidate {
  submissionUri: string;
  did: string;
  /** 隠し得点。表示には出さない。 */
  score: number;
  /** 出した札の枚数。 */
  cardCount: number;
  /** 追い風だった枚数。 */
  tailwindCount: number;
  /** 初登板だった枚数。 */
  debutCount: number;
  /** 出した札のレアリティ。 */
  rarities: CardRarity[];
  /** その提出で**初めて発見された**コンボの数。 */
  newComboCount: number;
  /** 同点のときの決着に使う。早く出したほうを採る。 */
  indexedAt: number;
}

export type ZenkatsuAward = {
  kind: ZenkatsuAwardKind;
  did: string;
  submissionUri: string;
};

/** 同点は「先に出したほう」で決める。日をまたいでも結果が変わらないようにするため。 */
const bestOf = (
  candidates: readonly ZenkatsuAwardCandidate[],
  rank: (c: ZenkatsuAwardCandidate) => number,
): ZenkatsuAwardCandidate | undefined => {
  let best: ZenkatsuAwardCandidate | undefined;
  let bestRank = -Infinity;
  for (const c of candidates) {
    const value = rank(c);
    if (value <= 0) continue;
    if (
      value > bestRank ||
      (value === bestRank && best && c.indexedAt < best.indexedAt)
    ) {
      best = c;
      bestRank = value;
    }
  }
  return best;
};

const longestRest = (rarities: readonly CardRarity[]) =>
  rarities.reduce((max, r) => Math.max(max, ZENKATSU_REST_DAYS[r]), 0);

/**
 * 決定論で決まる賞を確定する。**各賞の受賞者は1人**にする。
 *
 * 「1枚で出した人全員」のように条件を満たす全員へ配ると、賞の意味が薄れて
 * 「毎日もらえる参加賞」になってしまう。賞の数を増やすことで裾野を広げ、
 * 1つ1つはちゃんと絞る、という配り方にしている。
 */
export function decideDeterministicAwards(
  candidates: readonly ZenkatsuAwardCandidate[],
): ZenkatsuAward[] {
  const awards: ZenkatsuAward[] = [];
  const add = (
    kind: ZenkatsuAwardKind,
    winner: ZenkatsuAwardCandidate | undefined,
  ) => {
    if (winner)
      awards.push({ kind, did: winner.did, submissionUri: winner.submissionUri });
  };

  // SR 以上（おやすみ4日以上）を切った人のうち、いちばん重い1枚を出した人。
  add(
    "adventure",
    bestOf(candidates, (c) => {
      const rest = longestRest(c.rarities);
      return rest >= ZENKATSU_REST_DAYS.SR ? rest : 0;
    }),
  );
  add("debut", bestOf(candidates, (c) => c.debutCount));
  // 1枚で答えた人のうち、いちばん噛み合っていた人。
  add(
    "solo",
    bestOf(candidates, (c) => (c.cardCount === 1 ? c.score : 0)),
  );
  // 2枚以上を全部追い風で揃えた人（1枚だと solo と被るので除く）。
  add(
    "tailwind",
    bestOf(candidates, (c) =>
      c.cardCount >= 2 && c.tailwindCount === c.cardCount ? c.score : 0,
    ),
  );
  add("combo", bestOf(candidates, (c) => c.newComboCount));
  return awards;
}

/**
 * botたん賞の候補を絞る。
 *
 * 全員の提出をモデルに読ませると入力が膨れるうえ、基準が日替わりで揺れる。
 * **サーバが隠し得点で上位を絞り、その中から botたん が選ぶ**という分担にする
 * （AGENTS.md の「モデルに算術をさせない」とも整合）。
 */
export const ZENKATSU_BOTAN_SHORTLIST = 5;

export function shortlistForBotan(
  candidates: readonly ZenkatsuAwardCandidate[],
  limit = ZENKATSU_BOTAN_SHORTLIST,
): ZenkatsuAwardCandidate[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || a.indexedAt - b.indexedAt)
    .slice(0, limit);
}
