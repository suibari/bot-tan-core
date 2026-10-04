import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
const { reactionRowsQuery } = await import("../src/queries/reactions.js");
const { groupReactionViews } = await import("../src/queries/reactionViews.js");

test("ゼンカツへのリアクションは提出の持ち主を受け取り手として解決する", () => {
  const { sql } = reactionRowsQuery([
    "at://did:example:author/com.suibari.nagi.zenkatsu/2026-10-04",
  ]).toSQL();
  assert.match(sql, /left join "nagi"\."zenkatsu_submissions"/);
  assert.match(
    sql,
    /coalesce\("nagi"\."posts"\."did", "nagi"\."zenkatsu_submissions"\."did"\)/,
  );
});

test("ゼンカツの持ち主には送り主が見え、第三者には見えない", () => {
  const subjectUri = "at://did:example:author/com.suibari.nagi.zenkatsu/2026-10-04";
  const rows = [
    {
      subjectUri,
      emoji: "🎉",
      emojiKey: "🎉",
      emojiUri: null,
      subjectDid: "did:example:author",
      did: "did:example:bot",
      uri: "at://did:example:bot/com.suibari.nagi.reaction/1",
      handle: "bot.example",
      displayName: "botたん",
      avatarCid: null,
    },
  ];
  const owner = groupReactionViews(rows, "did:example:author").get(subjectUri)![0];
  assert.equal(owner.reactors[0]?.did, "did:example:bot");
  const stranger = groupReactionViews(rows, "did:example:other").get(subjectUri)![0];
  assert.deepEqual(stranger.reactors, []);
});
