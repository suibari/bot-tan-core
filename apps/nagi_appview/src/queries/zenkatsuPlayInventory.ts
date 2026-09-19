import { CARD_DEFS, type ZenkatsuHolding } from "@bsky-affirmative-bot/shared-configs";

type Play = { volume: number; id: number; themeDate: string };

/** 開発プレイでは図鑑の全札を借りる。実際の所持・ドロー記録には書き込まない。 */
export function zenkatsuPlayInventory(
  holdings: ZenkatsuHolding[],
  plays: Play[],
  dev: boolean,
): { holdings: ZenkatsuHolding[]; plays: Play[] } {
  if (!dev) return { holdings, plays };
  const all = new Map(holdings.map((card) => [`${card.volume}:${card.id}`, card]));
  for (const card of CARD_DEFS) {
    const key = `${card.volume}:${card.id}`;
    if (!all.has(key)) all.set(key, {
      volume: card.volume, id: card.id, rarity: card.rarity, stock: 1,
    });
  }
  return { holdings: [...all.values()], plays: [] };
}
