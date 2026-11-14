import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cards = readFileSync(new URL("../src/queries/cards.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes/xrpc.ts", import.meta.url), "utf8");
const schema = readFileSync(
  new URL("../../../packages/database/src/nagiSchema.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../../packages/database/drizzle/0049_nagi_guest_card_draws.sql", import.meta.url),
  "utf8",
);

test("guest card draw reuses the authoritative roll and daily boundary", () => {
  assert.match(cards, /export async function drawGuestCard/);
  assert.match(cards, /const rolled = rollCard\(\)/);
  assert.match(cards, /const drawDate = cardDrawDate\(now\)/);
  assert.match(cards, /const expiresAt = nextCardDrawAt\(now\)/);
});

test("guest device secret is hashed and one draw per device and date is enforced", () => {
  assert.match(cards, /createHash\("sha256"\)/);
  assert.match(schema, /deviceTokenHash: text\("device_token_hash"\)/);
  assert.match(schema, /nagi_guest_card_draw_device_date_idx/);
  assert.match(migration, /UNIQUE INDEX[\s\S]*device_token_hash[\s\S]*draw_date/);
});

test("sign-in claims the exact guest card through the existing authenticated draw route", () => {
  assert.match(routes, /requiredServiceAuth\(NAGI\.drawCard\)/);
  assert.match(routes, /drawCard\(req\.viewerDid!, guestToken\)/);
  assert.match(cards, /rolled = def/);
  assert.match(cards, /claimedByDid: viewerDid, claimedAt: now/);
});

test("an account draw already made that day wins and the guest draw is discarded", () => {
  assert.match(
    cards,
    /if \(!won\)[\s\S]*claimedByDid: viewerDid, claimedAt: now[\s\S]*card: \{ volume: existing\.cardVolume, id: existing\.cardNumber \}/,
  );
  assert.doesNotMatch(cards, /guest_draw_conflict/);
});

test("public guest drawing has an independent rate limit", () => {
  assert.match(routes, /NAGI\.drawGuestCard}`,[\s\S]{0,100}guestCardLimiter/);
});

test("the retired reaction slot is rejected and never draws", () => {
  assert.match(routes, /if \(source !== "my_nagi" && source !== "anniversary"\)/);
  assert.doesNotMatch(routes, /reactionUri/);
  assert.doesNotMatch(cards, /verifyReactionCardTrigger/);
});
