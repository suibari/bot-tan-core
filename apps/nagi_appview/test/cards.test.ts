import assert from "node:assert/strict";
import test from "node:test";
// 型だけの import はコンパイル時に消えるので、db.ts の実行より先に書いても副作用は無い。
import type { InstanceRow } from "../src/queries/cards.js";
// db.ts が接続文字列を要求するので、値の import より先にダミーを入れておく（実際には接続しない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const {
  ANNIVERSARY_SLOTS,
  CARD_DEFS,
  anniversaryCardNumber,
  buildAnniversaryCardDef,
} = await import("@bsky-affirmative-bot/shared-configs");
const { cardView, drawStatusOf, getCards } =
  await import("../src/queries/cards.js");

const def = CARD_DEFS[0];
const row = (over: Partial<InstanceRow> = {}): InstanceRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  cardVolume: def.volume,
  cardNumber: def.id,
  commentJa: "やったね！",
  commentEn: "Nice one!",
  duplicateCount: 1,
  acquiredAt: new Date("2026-07-25T00:00:00Z"),
  firstOwnerDid: "did:plc:owner",
  anniversaryLabel: null,
  ...over,
});

test("未所持カードは定義だけ返し、所持情報の欄は付けない", () => {
  const view = cardView(def);
  assert.equal(view.owned, false);
  assert.equal(view.instanceId, undefined);
  assert.equal(view.commentJa, undefined);
  assert.equal(view.duplicateCount, undefined);
  assert.equal(view.acquiredAt, undefined);
  // 定義部分は ja/en とも常に載る（クライアントのロケール切替を再フェッチ無しにするため）。
  // 番号は未所持でも出す（図鑑のどの枠が空いているか分かるように）。
  assert.equal(view.volume, def.volume);
  assert.equal(view.id, def.id);
  assert.equal(view.nameJa, def.nameJa);
  assert.equal(view.nameEn, def.nameEn);
  assert.equal(view.textEn, def.textEn);
});

test("所持カードは実体 id・コメント・入手時刻を載せる", () => {
  const view = cardView(def, row());
  assert.equal(view.owned, true);
  assert.equal(view.instanceId, "11111111-1111-1111-1111-111111111111");
  assert.equal(view.commentJa, "やったね！");
  assert.equal(view.commentEn, "Nice one!");
  assert.equal(view.duplicateCount, 1);
  assert.equal(view.acquiredAt, "2026-07-25T00:00:00.000Z");
  assert.equal(view.firstOwnerDid, "did:plc:owner");
});

test("コメント生成待ちの間はコメント欄を省く（空文字を返さない）", () => {
  // 引き直し直後は comment_* が NULL に戻る。UI 側で「生成中」と区別できるよう undefined にする。
  const view = cardView(def, row({ commentJa: null, commentEn: null }));
  assert.equal(view.owned, true);
  assert.ok(!("commentJa" in view));
  assert.ok(!("commentEn" in view));
});

test("引き直した回数はそのまま返る", () => {
  assert.equal(cardView(def, row({ duplicateCount: 3 })).duplicateCount, 3);
});

test("actor が DID でなければ 400 で弾く（DB へは行かない）", async () => {
  for (const actor of ["", "suibari.com", "at://did:plc:x/y", "did:foo:bar"]) {
    await assert.rejects(
      () => getCards(actor),
      (error: any) => error.status === 400 && error.error === "invalid_request",
      `actor="${actor}" should be rejected`,
    );
  }
});

test("通常枠だけを返し、廃止したリアクション枠の行は通常枠に数えない", () => {
  const now = new Date("2026-08-12T03:00:00.000Z");
  const onlyMyNagi = drawStatusOf(
    [{ source: "my_nagi", cardVolume: 1, cardNumber: 2 }],
    now,
  );
  assert.equal(onlyMyNagi.canDraw, false);
  assert.equal(onlyMyNagi.myNagi.canDraw, false);
  assert.equal("reaction" in onlyMyNagi, false);
  assert.equal(onlyMyNagi.todayCardId, 2);

  const onlyReaction = drawStatusOf(
    [{ source: "reaction", cardVolume: 1, cardNumber: 3 }],
    now,
  );
  assert.equal(onlyReaction.canDraw, true);
  assert.equal(onlyReaction.myNagi.canDraw, true);
  assert.equal("reaction" in onlyReaction, false);
  assert.equal(onlyReaction.todayCardId, undefined);
});

// --- 記念日カード。図鑑の外にある別枠で、コンプ率にも抽選にも関わらない ---

test("記念日カードも通常カードと同じ CardView に載る", () => {
  const def = buildAnniversaryCardDef(ANNIVERSARY_SLOTS.halloween, 2026);
  assert.ok(def);
  const view = cardView(
    def,
    row({
      cardVolume: 0,
      cardNumber: anniversaryCardNumber(2026, ANNIVERSARY_SLOTS.halloween),
    }),
  );
  // 演出（UR の箔押し・コンフェッティ）とコメントの深掘りを通常カードの経路で借りている。
  assert.equal(view.rarity, "UR");
  assert.equal(view.anniversary, true);
  assert.equal(view.year, 2026);
  assert.equal(view.nameJa, "ハロウィン2026");
  assert.equal(view.art, "anniv-halloween");
  assert.equal(view.owned, true);
});

test("ユーザー記念日の名前は受け取った時点のものを使う（あとで改名されても変わらない）", () => {
  const number = anniversaryCardNumber(2026, ANNIVERSARY_SLOTS.user_anniversary);
  const def = buildAnniversaryCardDef(
    ANNIVERSARY_SLOTS.user_anniversary,
    2026,
    "結婚記念日",
  );
  assert.ok(def);
  const view = cardView(
    def,
    row({ cardVolume: 0, cardNumber: number, anniversaryLabel: "結婚記念日" }),
  );
  assert.equal(view.nameJa, "結婚記念日2026");
});

test("記念日カードは図鑑の番号空間と衝突しない", () => {
  // 段 0 を予約しているので、通常段の (volume, id) と被ることがない。
  for (const slot of Object.values(ANNIVERSARY_SLOTS)) {
    const number = anniversaryCardNumber(2026, slot);
    assert.ok(
      !CARD_DEFS.some((c) => c.volume === 0 && c.id === number),
      `v0-${number} が通常カードと衝突している`,
    );
  }
});
