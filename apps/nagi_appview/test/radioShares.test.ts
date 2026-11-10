import assert from "node:assert/strict";
import test from "node:test";
import { NAGI, NAGI_COLLECTIONS, NAGI_INGEST_COLLECTIONS } from "@bsky-affirmative-bot/nagi-lexicon";
import type { nagiRadioShares, nagiRadioTracks } from "@bsky-affirmative-bot/database";
import { isReconcilableCollection } from "../src/ingest/reconcileRepo.js";
import { validateRecord } from "../src/ingest/validateRecord.js";
import { indexRadioShare, radioQuoteView } from "../src/queries/radioShares.js";

const did = "did:plc:alice";
const slotKey = "2026-11-10-20";
const uri = `at://${did}/${NAGI.radio}/${slotKey}`;
const ref = { uri, cid: "bafy-radio" };
const track: typeof nagiRadioTracks.$inferSelect = {
  subjectDid: did, slotKey, status: "ready", claimedAt: new Date(),
  title: "ケセラセラ", artist: "Mrs. GREEN APPLE", commentJa: "今日の曲", commentEn: "Today's song",
  videoId: null, videoTitle: null, songUrl: "https://www.youtube.com/watch?v=Jy-QS27q7lA",
  thumbnailUrl: "https://i.ytimg.com/vi/Jy-QS27q7lA/hqdefault.jpg",
  sourceUrl: null, publishedAt: new Date("2026-11-10T11:00:00Z"),
};
const share: typeof nagiRadioShares.$inferSelect = {
  uri, cid: ref.cid, did, slotKey, indexedAt: new Date(), deletedAt: null,
};

test("ラジオの公開は即時・Jetstream・repo照合のすべての経路で取り込む", () => {
  assert.equal(isReconcilableCollection(did, NAGI.radio), true);
  assert.ok(NAGI_INGEST_COLLECTIONS.includes(NAGI.radio));
  assert.ok(NAGI_COLLECTIONS.includes(NAGI.radio));
});

test("レコードは放送枠の形をした slotKey と作成日時だけを受け付ける", () => {
  const record = { $type: NAGI.radio, slotKey, createdAt: "2026-11-10T11:05:00Z" };
  assert.equal(validateRecord(NAGI.radio, record), true);
  assert.equal(validateRecord(NAGI.radio, { ...record, slotKey: "2026-11-10-21" }), false);
  assert.equal(validateRecord(NAGI.radio, { ...record, createdAt: undefined }), false);
  assert.equal(validateRecord(NAGI.radio, { ...record, $type: NAGI.cardGet }), false);
});

/** select().from().where().limit() と insert().values().onConflictDoUpdate() だけを持つ偽の tx。 */
function fakeTx(found: boolean) {
  const inserted: unknown[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (found ? [{ slotKey }] : []) }) }) }),
    insert: () => ({ values: (value: unknown) => ({ onConflictDoUpdate: async () => { inserted.push(value); } }) }),
  };
  return { tx: tx as never, inserted };
}

test("本人の ready な放送と照合できた回だけを索引する", async () => {
  const ok = fakeTx(true);
  assert.deepEqual(
    await indexRadioShare(ok.tx, { uri, cid: ref.cid, did, rkey: slotKey, record: { slotKey, createdAt: "2026-11-10T11:05:00Z" } }),
    { indexed: true },
  );
  assert.equal(ok.inserted.length, 1);

  const missing = fakeTx(false);
  assert.deepEqual(
    await indexRadioShare(missing.tx, { uri, cid: ref.cid, did, rkey: slotKey, record: { slotKey, createdAt: "2026-11-10T11:05:00Z" } }),
    { indexed: false, reason: "no_such_track" },
  );
  assert.equal(missing.inserted.length, 0);
});

test("rkey と slotKey が違うレコードは索引しない", async () => {
  const { tx, inserted } = fakeTx(true);
  assert.deepEqual(
    await indexRadioShare(tx, { uri, cid: ref.cid, did, rkey: "other", record: { slotKey, createdAt: "2026-11-10T11:05:00Z" } }),
    { indexed: false, reason: "rkey_mismatch" },
  );
  assert.equal(inserted.length, 0);
});

test("引用カードは本人の放送から曲とDJコメントを引く", () => {
  const view = radioQuoteView(ref, share, track);
  assert.equal(view.unavailable, undefined);
  assert.equal(view.title, "ケセラセラ");
  assert.equal(view.commentJa, "今日の曲");
  assert.equal(view.commentEn, "Today's song");
  assert.equal(view.songUrl, track.songUrl);
  assert.equal(view.publishedAt, "2026-11-10T11:00:00.000Z");
});

test("公開を消した・他人の放送・ミュート中の作者は中身を出さない", () => {
  assert.equal(radioQuoteView(ref, undefined, track).unavailable, true);
  assert.equal(radioQuoteView(ref, { ...share, deletedAt: new Date() }, track).unavailable, true);
  assert.equal(radioQuoteView(ref, share, { ...track, subjectDid: "did:plc:bob" }).unavailable, true);
  assert.equal(radioQuoteView(ref, share, { ...track, status: "pending" }).unavailable, true);
  const muted = radioQuoteView(ref, share, track, [did]);
  assert.equal(muted.unavailable, true);
  assert.equal(muted.title, "");
  assert.equal(muted.commentJa, undefined);
});
