import assert from "node:assert/strict";
import test from "node:test";
// モジュールが db.ts と config.ts を読むので、import より先にダミーを入れておく（接続はしない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ||= "did:web:example.invalid";
process.env.NAGI_BOT_DID ||= "did:plc:examplebot";

const { db, nagiZenkatsuSubmissions } = await import("@bsky-affirmative-bot/database");
const { zenkatsuMuteFilter } = await import("../src/queries/zenkatsu.js");

test("ミュートが無ければゼンカツの回答を絞らない", () => {
  assert.equal(zenkatsuMuteFilter({ actors: [], tags: ["foo"] }), undefined);
});

test("ミュートした作者の回答を除き、タグのミュートは見ない", () => {
  const condition = zenkatsuMuteFilter({ actors: ["did:plc:a", "did:plc:b"], tags: ["foo"] });
  const { sql, params } = db
    .select({ uri: nagiZenkatsuSubmissions.uri })
    .from(nagiZenkatsuSubmissions)
    .where(condition)
    .toSQL();
  assert.match(sql, /"did" not in \(\$1, \$2\)/);
  assert.deepEqual(params, ["did:plc:a", "did:plc:b"]);
});
