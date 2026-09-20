import { ZENKATSU_REST_DAYS } from "./zenkatsu.js";
import type { CardRarity } from "./cards.js";

/** 部長賞は翌朝、ほかの賞は提出の索引時に確定する。 */
export const ZENKATSU_AWARD_KINDS = [
  "adventure",
  "solo",
  "tailwind",
  "combo",
  "botan",
] as const;
export type ZenkatsuAwardKind = (typeof ZENKATSU_AWARD_KINDS)[number];
export type ZenkatsuImmediateAwardKind = Exclude<ZenkatsuAwardKind, "botan">;

/** 1回の提出から、本人へすぐ贈る賞を判定する。 */
export function immediateZenkatsuAwards(input: {
  rarities: readonly CardRarity[];
  tailwindCount: number;
  newComboCount: number;
}): ZenkatsuImmediateAwardKind[] {
  const awards: ZenkatsuImmediateAwardKind[] = [];
  if (input.rarities.some((rarity) => ZENKATSU_REST_DAYS[rarity] >= ZENKATSU_REST_DAYS.SR))
    awards.push("adventure");
  if (input.rarities.length === 1) awards.push("solo");
  if (input.rarities.length === 3 && input.tailwindCount === 3)
    awards.push("tailwind");
  if (input.newComboCount > 0) awards.push("combo");
  return awards;
}

/** 翌朝の部長賞候補。点数は選考専用で、ユーザーには表示しない。 */
export interface ZenkatsuBotanCandidate {
  submissionUri: string;
  did: string;
  score: number;
  indexedAt: number;
}

/** 部長賞は候補を5人までに絞り、botたんが選ぶ。 */
export const ZENKATSU_BOTAN_SHORTLIST = 5;

export function shortlistForBotan<T extends ZenkatsuBotanCandidate>(
  candidates: readonly T[],
  limit = ZENKATSU_BOTAN_SHORTLIST,
): T[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || a.indexedAt - b.indexedAt)
    .slice(0, limit);
}
