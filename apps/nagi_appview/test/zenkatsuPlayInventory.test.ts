import assert from "node:assert/strict";
import test from "node:test";
import { CARD_DEFS, zenkatsuAvailability } from "@bsky-affirmative-bot/shared-configs";
import { zenkatsuPlayInventory } from "../src/queries/zenkatsuPlayInventory.js";

test("開発プレイは未所持もクールダウン中も全札を出せ、元の所持は変更しない", () => {
  const card = CARD_DEFS[0];
  const holdings = [{ volume: card.volume, id: card.id, rarity: card.rarity, stock: 1 }];
  const plays = [{ volume: card.volume, id: card.id, themeDate: "2026-09-19" }];
  const inventory = zenkatsuPlayInventory(holdings, plays, true);
  assert.equal(inventory.holdings.length, CARD_DEFS.length);
  assert.equal(new Set(inventory.holdings.map(c => `${c.volume}:${c.id}`)).size, CARD_DEFS.length);
  assert.ok(zenkatsuAvailability(inventory.holdings, inventory.plays, "2026-09-19").every(c => c.available > 0));
  assert.equal(holdings.length, 1);
  assert.equal(plays.length, 1);
});

test("本番は未所持を足さず、クールダウンを維持する", () => {
  const card = CARD_DEFS[0];
  const holdings = [{ volume: card.volume, id: card.id, rarity: card.rarity, stock: 1 }];
  const plays = [{ volume: card.volume, id: card.id, themeDate: "2026-09-19" }];
  const inventory = zenkatsuPlayInventory(holdings, plays, false);
  assert.equal(inventory.holdings, holdings);
  assert.equal(inventory.plays, plays);
  assert.equal(zenkatsuAvailability(inventory.holdings, inventory.plays, "2026-09-19")[0].available, 0);
  assert.deepEqual(zenkatsuPlayInventory([], [], false).holdings, []);
});
