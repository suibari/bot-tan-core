import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { PgDialect } = await import("drizzle-orm/pg-core");
const { and } = await import("drizzle-orm");
const {
  notificationCategory,
  notificationListFilter,
  parseNotificationPreferences,
  preferenceFor,
  sanitizeStoredNotificationPreferences,
} = await import("../src/services/notificationPreferences.js");

const BOT = "did:plc:bot";
const PERSON = "did:plc:person";
const dialect = new PgDialect();

test("botたんからの返信・メンション・リアクションだけを botInteraction に振り替える", () => {
  assert.equal(notificationCategory("reply", BOT, BOT), "botInteraction");
  assert.equal(notificationCategory("mention", BOT, BOT), "botInteraction");
  assert.equal(notificationCategory("reaction", BOT, BOT), "botInteraction");
  assert.equal(notificationCategory("reply", PERSON, BOT), "reply");
  assert.equal(notificationCategory("reaction", PERSON, BOT), "reaction");
  // botたんしか送らない種別は種別のまま。
  assert.equal(notificationCategory("diary", BOT, BOT), "diary");
  assert.equal(notificationCategory("analysis", BOT, BOT), "analysis");
});

test("未設定のカテゴリは list / push とも有効", () => {
  assert.deepEqual(preferenceFor({}, "reply"), { list: true, push: true });
  assert.deepEqual(
    preferenceFor({ reply: { list: true, push: false } }, "reply"),
    { list: true, push: false },
  );
});

test("入力は既知カテゴリの boolean だけを受け、知らないカテゴリは捨てる", () => {
  assert.deepEqual(
    parseNotificationPreferences({
      botInteraction: { list: false, push: false },
      futureCategory: { list: false, push: false },
    }),
    { botInteraction: { list: false, push: false } },
  );
  for (const invalid of [
    null,
    [],
    "x",
    { reply: { list: "no", push: false } },
    { reply: { list: false } },
    { reply: true },
  ])
    assert.throws(() => parseNotificationPreferences(invalid));
});

test("保存値が壊れていたら既定（すべて有効）として読む", () => {
  assert.deepEqual(sanitizeStoredNotificationPreferences("broken"), {});
  assert.deepEqual(
    sanitizeStoredNotificationPreferences({ reply: { list: 1, push: 0 } }),
    {},
  );
});

test("通知欄の除外条件: 全部有効なら条件を足さない", () => {
  assert.deepEqual(notificationListFilter({}, BOT), []);
  assert.deepEqual(
    notificationListFilter({ reply: { list: true, push: false } }, BOT),
    [],
  );
});

test("通知欄の除外条件: botInteraction は bot からの3種別だけ、reply は bot 以外だけを外す", () => {
  const [condition] = notificationListFilter(
    {
      botInteraction: { list: false, push: false },
      reply: { list: false, push: false },
      diary: { list: false, push: false },
    },
    BOT,
  );
  const { sql, params } = dialect.sqlToQuery(and(condition)!);
  assert.equal(
    sql,
    'not (("nagi"."notifications"."type" = $1 and "nagi"."notifications"."actor_did" <> $2)' +
      ' or ("nagi"."notifications"."type" in ($3, $4, $5) and "nagi"."notifications"."actor_did" = $6)' +
      ' or "nagi"."notifications"."type" = $7)',
  );
  assert.deepEqual(params, [
    "reply",
    BOT,
    "reply",
    "mention",
    "reaction",
    BOT,
    "diary",
  ]);
});
