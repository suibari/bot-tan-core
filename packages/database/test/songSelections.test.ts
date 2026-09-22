import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_SONG_SELECTION_COOLDOWN_DAYS,
  botSongSelectionCutoff,
  buildRecentBotSongSelectionsQuery,
} from "../src/songSelections.js";

test("曲の再選除外期間は30日", () => {
  assert.equal(BOT_SONG_SELECTION_COOLDOWN_DAYS, 30);
  assert.equal(
    botSongSelectionCutoff(new Date("2026-09-23T12:00:00.000Z")).toISOString(),
    "2026-08-24T12:00:00.000Z",
  );
});

test("履歴検索のtimestampパラメータはDrizzleの列エンコーダを通る", () => {
  const query = buildRecentBotSongSelectionsQuery(new Date("2026-08-24T12:00:00.000Z")).toSQL();
  assert.match(query.sql, /selected_at.*>=/);
  assert.ok(query.params.every((param) => !(param instanceof Date)));
  assert.ok(query.params.includes("2026-08-24T12:00:00.000Z"));
});
