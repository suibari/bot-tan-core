import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { db, nagiCommunityAffirmationDismissals } =
  await import("@bsky-affirmative-bot/database");
const { communityAffirmationDismissalCleanupCondition } =
  await import("../src/queries/communityAffirmationDismissals.js");

test("見送り削除条件は日時を型付きパラメータにし、参照先消失も対象にする", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const query = db
    .delete(nagiCommunityAffirmationDismissals)
    .where(communityAffirmationDismissalCleanupCondition(now))
    .toSQL();
  const text = query.sql.replace(/\s+/g, " ");

  assert.ok(text.includes('"expires_at" <'));
  assert.ok(text.includes("not exists"));
  assert.ok(text.includes('from "nagi"."posts"'));
  assert.ok(
    query.params.every((param) => !(param instanceof Date)),
    "cleanup must not pass a raw Date to postgres.js",
  );
  assert.ok(query.params.includes(now.toISOString()));
});
