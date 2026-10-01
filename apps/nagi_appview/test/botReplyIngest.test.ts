import assert from "node:assert/strict";
import test from "node:test";
import { shouldEnqueueBotReply } from "../src/ingest/botReplyJob.js";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
const { selectUnindexedBotReplies } = await import(
  "../src/ingest/botReplyIndexWorker.js"
);
const { isPermanentListFailure, XrpcError } = await import(
  "../src/ingest/reconcileRepo.js"
);

const base = {
  isNewPost: true,
  reconcile: false,
  appviewOnly: false,
  trackJetstream: true,
  operation: "create",
  kossori: false,
};

test("Jetstream で新しく届いた投稿には AppView も返信ジョブを積む", () => {
  assert.equal(shouldEnqueueBotReply(base), true);
});

test("ensureRecord 経由の新規投稿は update として来ても積む", () => {
  assert.equal(
    shouldEnqueueBotReply({ ...base, trackJetstream: false, operation: "update" }),
    true,
  );
});

test("再同期・既知の投稿・編集・こっそりでは積まない", () => {
  assert.equal(shouldEnqueueBotReply({ ...base, reconcile: true }), false);
  assert.equal(shouldEnqueueBotReply({ ...base, isNewPost: false }), false);
  assert.equal(shouldEnqueueBotReply({ ...base, operation: "update" }), false);
  assert.equal(shouldEnqueueBotReply({ ...base, appviewOnly: true }), false);
  assert.equal(shouldEnqueueBotReply({ ...base, kossori: true }), false);
});

test("未反映返信の検索は Date をドライバへ生で渡さない", () => {
  const { sql, params } = selectUnindexedBotReplies(new Date(), 20).toSQL();
  assert.match(sql, /not exists/i);
  assert.equal(
    params.some((param: unknown) => param instanceof Date),
    false,
  );
});

test("PDS が一覧を返せない 400 だけを恒久的な失敗として飛ばす", () => {
  assert.equal(isPermanentListFailure(new XrpcError("bad", 400)), true);
  assert.equal(isPermanentListFailure(new XrpcError("down", 502)), false);
  assert.equal(isPermanentListFailure(new Error("timeout")), false);
});
