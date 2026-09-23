import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_SONG_SELECTION_COOLDOWN_DAYS,
  SCHEDULED_POST_SONG_SCOPE,
  botSongSelectionScopeKey,
  botSongSelectionCutoff,
  buildRecentBotSongSelectionsQuery,
  djSongSelectionScope,
  isBotSongSelectionWithinCooldown,
} from "../src/songSelections.js";

test("曲の再選除外期間は30日", () => {
  assert.equal(BOT_SONG_SELECTION_COOLDOWN_DAYS, 30);
  assert.equal(
    botSongSelectionCutoff(new Date("2026-09-23T12:00:00.000Z")).toISOString(),
    "2026-08-24T12:00:00.000Z",
  );
});

test("30日境界は両端を含み、1ms古い履歴と未来時刻は除外する", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  assert.equal(isBotSongSelectionWithinCooldown(new Date("2026-08-24T12:00:00.000Z"), now), true);
  assert.equal(isBotSongSelectionWithinCooldown(new Date("2026-08-24T11:59:59.999Z"), now), false);
  assert.equal(isBotSongSelectionWithinCooldown(new Date("2026-09-23T12:00:00.000Z"), now), true);
  assert.equal(isBotSongSelectionWithinCooldown(new Date("2026-09-23T12:00:00.001Z"), now), false);
});

test("履歴検索のtimestampパラメータはDrizzleの列エンコーダを通る", () => {
  const query = buildRecentBotSongSelectionsQuery(
    SCHEDULED_POST_SONG_SCOPE,
    new Date("2026-09-23T12:00:00.000Z"),
  ).toSQL();
  assert.match(query.sql, /selected_at.*>=/);
  assert.match(query.sql, /selected_at.*<=/);
  assert.match(query.sql, /reservation_expires_at.*>/);
  assert.ok(query.params.every((param) => !(param instanceof Date)));
  assert.ok(query.params.includes("publishing"));
  assert.ok(query.params.includes("2026-08-24T12:00:00.000Z"));
  assert.ok(query.params.includes("2026-09-23T12:00:00.000Z"));
});

test("定期ポストとDJ、DJ利用者ごとに履歴スコープを分ける", () => {
  const alice = djSongSelectionScope("did:plc:alice");
  const bob = djSongSelectionScope("did:plc:bob");
  assert.notEqual(botSongSelectionScopeKey(SCHEDULED_POST_SONG_SCOPE), botSongSelectionScopeKey(alice));
  assert.notEqual(botSongSelectionScopeKey(alice), botSongSelectionScopeKey(bob));
  assert.equal(botSongSelectionScopeKey(alice), "dj:did:plc:alice");
  assert.equal(botSongSelectionScopeKey(alice).includes("\u0000"), false);

  const query = buildRecentBotSongSelectionsQuery(
    alice,
    new Date("2026-09-23T12:00:00.000Z"),
  ).toSQL();
  assert.ok(query.params.includes("dj"));
  assert.ok(query.params.includes("did:plc:alice"));
});

test("DJ履歴の利用者キーにはDIDだけを受け付ける", () => {
  assert.throws(() => djSongSelectionScope("bsky:alice"), /requires a DID/);
});
