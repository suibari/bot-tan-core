import assert from "node:assert/strict";
import test from "node:test";
// 判定そのものは純粋関数だが、モジュールが db.ts と config.ts を読むので、
// 値の import より先にダミーを入れておく（実際には接続も参照もしない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ||= "did:web:example.invalid";
process.env.NAGI_BOT_DID ||= "did:plc:examplebot";

const { CARD_DEFS } = await import("@bsky-affirmative-bot/shared-configs");
const { decideZenkatsuSubmission } = await import("../src/queries/zenkatsu.js");

const TODAY = "2026-09-19";
// N(light/応援族)、N(water/妖精族)、AAR(light/応援族)
const N1 = CARD_DEFS[0];
const N2 = CARD_DEFS[1];
const AAR = CARD_DEFS.find((c) => c.rarity === "AAR")!;

const holding = (def: (typeof CARD_DEFS)[number], stock = 1) => ({
  volume: def.volume,
  id: def.id,
  rarity: def.rarity,
  stock,
});

const decide = (over: Partial<Parameters<typeof decideZenkatsuSubmission>[0]> = {}) =>
  decideZenkatsuSubmission({
    rkey: TODAY,
    record: {
      themeDate: TODAY,
      cards: [{ volume: N1.volume, id: N1.id }],
      createdAt: "2026-09-19T05:00:00Z",
    },
    today: TODAY,
    theme: { attribute: "light" },
    holdings: [holding(N1)],
    labels: new Map(),
    plays: [],
    everPlayed: new Set(),
    ...over,
  });

test("所持していてお休み中でなければ通る", () => {
  const d = decide();
  assert.equal(d.ok, true);
});

test("所持していない札は索引しない", () => {
  // 偽レコードの本丸。repo には書けるが、AppView が所持と突き合わせて弾く。
  const d = decide({ holdings: [] });
  assert.deepEqual(d, { ok: false, reason: "not_owned" });
});

test("AAR を自作しても索引しない", () => {
  const d = decide({
    record: {
      themeDate: TODAY,
      cards: [{ volume: AAR.volume, id: AAR.id }],
      createdAt: "2026-09-19T05:00:00Z",
    },
    holdings: [holding(N1)],
  });
  assert.deepEqual(d, { ok: false, reason: "not_owned" });
});

test("お休み中の札は索引しない", () => {
  const d = decide({
    plays: [{ volume: N1.volume, id: N1.id, themeDate: "2026-09-18" }],
  });
  assert.deepEqual(d, { ok: false, reason: "resting" });
});

test("在庫が2枚あれば、昨日出していても出せる", () => {
  const d = decide({
    holdings: [holding(N1, 2)],
    plays: [{ volume: N1.volume, id: N1.id, themeDate: "2026-09-18" }],
  });
  assert.equal(d.ok, true);
});

test("rkey と themeDate がズレていたら索引しない", () => {
  const d = decide({ rkey: "2026-09-18" });
  assert.deepEqual(d, { ok: false, reason: "rkey_mismatch" });
});

test("当日以外の日付は索引しない（遡り提出の禁止）", () => {
  const past = decide({
    rkey: "2026-09-10",
    record: {
      themeDate: "2026-09-10",
      cards: [{ volume: N1.volume, id: N1.id }],
      createdAt: "2026-09-10T05:00:00Z",
    },
  });
  assert.deepEqual(past, { ok: false, reason: "not_today" });
});

test("同じ札を2枚入れた提出は索引しない", () => {
  const d = decide({
    record: {
      themeDate: TODAY,
      cards: [
        { volume: N1.volume, id: N1.id },
        { volume: N1.volume, id: N1.id },
      ],
      createdAt: "2026-09-19T05:00:00Z",
    },
    holdings: [holding(N1, 3)],
  });
  assert.deepEqual(d, { ok: false, reason: "invalid_selection" });
});

test("4枚以上の提出は索引しない", () => {
  const cards = CARD_DEFS.slice(0, 4).map((c) => ({ volume: c.volume, id: c.id }));
  const d = decide({
    record: { themeDate: TODAY, cards, createdAt: "2026-09-19T05:00:00Z" },
    holdings: CARD_DEFS.slice(0, 4).map((c) => holding(c)),
  });
  assert.deepEqual(d, { ok: false, reason: "invalid_selection" });
});

test("定義に無い札は索引しない", () => {
  const d = decide({
    record: {
      themeDate: TODAY,
      cards: [{ volume: 1, id: 9999 }],
      createdAt: "2026-09-19T05:00:00Z",
    },
    holdings: [{ volume: 1, id: 9999, rarity: "N", stock: 1 }],
  });
  assert.deepEqual(d, { ok: false, reason: "unknown_card" });
});

test("読みラベルは追い風と編成の傾向を必ず含む", () => {
  const d = decide();
  assert.equal(d.ok, true);
  if (!d.ok) return;
  const joined = d.reading.labels.join("\n");
  assert.match(joined, /追い風/);
  assert.match(joined, /編成の傾向/);
  // スコアではなく、計算済みの結論を日本語で渡す（モデルに算術をさせない）。
  assert.match(joined, /ATK合計\d+ \/ DEF合計\d+/);
});

test("1枚で答えた日はラベルが付き、ニュースのハイライトになる", () => {
  const d = decide();
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.ok(d.reading.labels.includes("1枚で答えた"));
  assert.equal(d.reading.highlight, true);
});

test("初登板でない札だけなら、初登板ラベルは付かない", () => {
  const d = decide({
    record: {
      themeDate: TODAY,
      cards: [
        { volume: N1.volume, id: N1.id },
        { volume: N2.volume, id: N2.id },
      ],
      createdAt: "2026-09-19T05:00:00Z",
    },
    holdings: [holding(N1), holding(N2)],
    everPlayed: new Set([`${N1.volume}:${N1.id}`, `${N2.volume}:${N2.id}`]),
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.ok(!d.reading.labels.some((l) => l.startsWith("初登板")));
});
