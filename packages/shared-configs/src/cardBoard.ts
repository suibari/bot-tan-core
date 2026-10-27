import type { CardRarity } from "./cards.js";
import type { ZenkatsuAvailability, ZenkatsuHolding } from "./zenkatsu.js";

/**
 * おすそわけボードと Ƶ（全肯定ポイント）。
 * 決定の経緯と数字の根拠は docs/zenkatsu.md の13章。
 */

/**
 * 置いたときにもらう Ƶ と、取るときに払う Ƶ。**同じ値にする**（収支が見て分かる）。
 * 値を変えると、すでに置いた人と後から置く人で受け取りが変わる点に注意。
 */
export const ZENNY_PER_CARD: Record<CardRarity, number> = {
  N: 1,
  R: 3,
  SR: 10,
  UR: 30,
  AAR: 100,
};

/**
 * 手元に残す枚数。これを超えた分だけ置ける。
 * N はお休み2日なので3枚あれば毎日ゼンカツに出せる。
 */
export const CARD_BOARD_KEEP = 3;

/** ボードに無い AAR を botたんから受け取る値段。AAR は4枚持つ人がまず現れず、ボードに並ばないため。 */
export const CARD_SHELF_AAR_PRICE = 600;

/** はじめての人に1回だけ配る Ƶ。Ƶ を持たない新しい人がボードを使えるようにする。 */
export const ZENNY_WELCOME = 30;

/**
 * そのカードを何枚置けるか。手元に CARD_BOARD_KEEP 枚を残し、お休み中の在庫には手を付けない。
 *
 *     置ける = 所持 − max(残す枚数, お休み中の枚数)
 *
 * お休み中の枚数は zenkatsuAvailability の「出せる枚数」との差で出す。
 */
export function donatableCount(
  holding: Pick<ZenkatsuHolding, "stock">,
  availability: Pick<ZenkatsuAvailability, "available">,
): number {
  const resting = Math.max(0, holding.stock - availability.available);
  return Math.max(0, holding.stock - Math.max(CARD_BOARD_KEEP, resting));
}
