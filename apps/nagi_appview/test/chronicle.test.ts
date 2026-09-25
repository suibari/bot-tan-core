import assert from "node:assert/strict";
import test from "node:test";
import type { ChronicleEventView } from "@bsky-affirmative-bot/nagi-lexicon";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";
const {
  buildFirstEvents,
  chronicleDate,
  chronicleEventView,
  parseChronicleCursor,
  sortChronicleEvents,
  toDate,
} = await import("../src/queries/chronicle.js");

const event = (
  over: Partial<ChronicleEventView> & Pick<ChronicleEventView, "id" | "kind" | "date">,
): ChronicleEventView => over as ChronicleEventView;

test("chronicle event is returned only to its owner", () => {
  const item = event({ id: "first:first_diary", kind: "first_diary", date: "2026-08-02" });
  // 他人と未認証には、日付も件数も返さない（日記と同じ守り）。
  for (const viewer of ["did:plc:bob", undefined])
    assert.equal(chronicleEventView("did:plc:alice", viewer, item), undefined);
  assert.equal(chronicleEventView("did:plc:alice", "did:plc:alice", item), item);
});

test("chronicle cursor accepts only a 4-digit year", () => {
  assert.equal(parseChronicleCursor(undefined), undefined);
  assert.equal(parseChronicleCursor(""), undefined);
  assert.equal(parseChronicleCursor("2025"), 2025);
  for (const bad of ["25", "2025-01", "abcd", "2025 "])
    assert.throws(() => parseChronicleCursor(bad), /Invalid chronicle cursor/);
});

test("chronicle dates use the JST 4:00 boundary shared with the card album", () => {
  // JST 4:00 より前は前日ぶん。ここがずれると元旦カードが大晦日の欄に出る。
  // 2025-12-31T18:59Z = 2026-01-01 03:59 JST（まだ大晦日）。
  assert.equal(chronicleDate(new Date("2025-12-31T18:59:59.000Z")), "2025-12-31");
  // 2025-12-31T19:00Z = 2026-01-01 04:00 JST（ここから元旦）。
  assert.equal(chronicleDate(new Date("2025-12-31T19:00:00.000Z")), "2026-01-01");
  assert.equal(chronicleDate(new Date("2026-01-01T02:00:00.000Z")), "2026-01-01");
});

test("chronicle sorts oldest first, then fixed kind order, then id", () => {
  // 年表は「はじまりから今へ」読むので、一覧の新しい順とは逆向き。
  // 同じ日に複数載るのは普通なので、時刻ではなく kind の固定優先度で決める。
  const sorted = sortChronicleEvents([
    event({ id: "news_context:2026-08", kind: "news_context", date: "2026-08-02" }),
    event({ id: "highlight:b", kind: "highlight", date: "2026-08-02" }),
    event({ id: "first:nagi_joined", kind: "nagi_joined", date: "2026-08-02" }),
    event({ id: "anniversary:z", kind: "anniversary_card", date: "2026-08-02" }),
    event({ id: "anniversary:a", kind: "anniversary_card", date: "2026-08-02" }),
    event({ id: "first:bot_met", kind: "bot_met", date: "2026-09-01" }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    [
      "first:nagi_joined",
      "anniversary:a",
      "anniversary:z",
      "highlight:b",
      // その月のまとめの下に付くので、同じ日なら必ずいちばん後ろ。
      "news_context:2026-08",
      "first:bot_met",
    ],
  );
});

test("chronicle sort is stable across runs", () => {
  // ページをまたいだ重複排除と keyed each が、並びの安定に依存している。
  const items = [
    event({ id: "anniversary:b", kind: "anniversary_card", date: "2026-05-05" }),
    event({ id: "anniversary:a", kind: "anniversary_card", date: "2026-05-05" }),
    event({ id: "highlight:c", kind: "highlight", date: "2026-05-05" }),
  ];
  const once = sortChronicleEvents(items).map((item) => item.id);
  const twice = sortChronicleEvents([...items].reverse()).map((item) => item.id);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ["anniversary:a", "anniversary:b", "highlight:c"]);
});





test("材料が無い起点は行を作らない", () => {
  assert.deepEqual(buildFirstEvents({}), []);
  assert.deepEqual(
    buildFirstEvents({ rareCards: [{ rarity: "UR", at: null }] }),
    [],
  );
});

test("レアカードの初取得は rarity ごとに1件ずつ", () => {
  const events = buildFirstEvents({
    rareCards: [
      { rarity: "UR", at: "2026-07-02T06:00:00.000Z" },
      { rarity: "AAR", at: "2026-08-09T06:00:00.000Z" },
    ],
  });
  assert.deepEqual(
    events.map((e) => [e.kind, e.date]),
    [
      ["first_card_ur", "2026-07-02"],
      ["first_card_aar", "2026-08-09"],
    ],
  );
});

test("toDate は Date・文字列・欠損を扱う", () => {
  assert.equal(
    toDate("2026-08-02T00:00:00.000Z")?.toISOString(),
    "2026-08-02T00:00:00.000Z",
  );
  assert.equal(toDate(new Date(0))?.getTime(), 0);
  assert.equal(toDate(null), undefined);
  assert.equal(toDate(undefined), undefined);
  assert.equal(toDate("not a date"), undefined);
});

test("起点は、それを名乗っている列をそのまま読む", () => {
  // PDS が正本。AppView の索引（最古の投稿）で補正しない。
  const events = buildFirstEvents({
    profileCreatedAt: "2026-07-18T22:48:35.103Z",
    followerCreatedAt: "2024-08-25T02:26:37.351Z",
  });
  assert.equal(events.find((e) => e.kind === "nagi_joined")?.date, "2026-07-19");
  assert.equal(events.find((e) => e.kind === "bot_met")?.date, "2024-08-25");
});

test("「はじめての投稿」も「はじめての日記」も年表に出さない", () => {
  /*
   * 本番実測: 本人の最古の投稿 2026-07-18 15:02（JST 7/19 00:02）に対して
   * profiles.created_at は 2026-07-18 22:48（JST 7/19 07:48）。同じ JST 日だが、
   * カードと同じ JST 4時境界を通すと 7/18 と 7/19 に割れ、
   * 「はじめての投稿のほうが Nagi にやってきた日より前」という、ありえない並びになる。
   *
   * そもそも投稿は登録と実質同日で情報量が無く、逆転を生むだけなので載せない。
   * 「はじめての日記」も同じ理由で載せない（日記は毎日書かれるので、登録の数日後にしかならない）。
   */
  const events = buildFirstEvents({
    profileCreatedAt: "2026-07-18T22:48:35.103Z",
  });
  assert.deepEqual(
    events.map((e) => e.kind),
    ["nagi_joined"],
  );
});

test("bot_met が Nagi 登録より後に来るのは異常ではない", () => {
  // followers の行は Bluesky のフォロー以外でも作られる（Nagi の会話・日記の称号）。
  // 「出会った日」ではなく「関わりはじめた日」なので、この順序で正しい。
  const events = buildFirstEvents({
    profileCreatedAt: "2026-09-05T03:13:17.470Z",
    followerCreatedAt: "2026-09-19T02:26:37.351Z",
  });
  const joined = events.find((e) => e.kind === "nagi_joined")!;
  const met = events.find((e) => e.kind === "bot_met")!;
  assert.ok(met.date > joined.date);
});

test("材料が無い起点は行を作らない", () => {
  assert.deepEqual(buildFirstEvents({}), []);
  assert.deepEqual(
    buildFirstEvents({ rareCards: [{ rarity: "UR", at: null }] }),
    [],
  );
});

test("レアカードの初取得は rarity ごとに1件ずつ", () => {
  const events = buildFirstEvents({
    rareCards: [
      { rarity: "UR", at: "2026-07-02T06:00:00.000Z" },
      { rarity: "AAR", at: "2026-08-09T06:00:00.000Z" },
    ],
  });
  assert.deepEqual(
    events.map((e) => [e.kind, e.date]),
    [
      ["first_card_ur", "2026-07-02"],
      ["first_card_aar", "2026-08-09"],
    ],
  );
});
