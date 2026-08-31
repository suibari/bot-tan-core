import { randomBytes } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import {
  db,
  nagiBotReplyJobs,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import {
  NAGI,
  appviewRecordUri,
  isAppviewOwnedUri,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { applyMutation } from "../ingest/applyMutation.js";
import { validateRecord } from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";
import { mentionsDid } from "@bsky-affirmative-bot/bot-runtime";

/**
 * こっそり投稿は PDS に正本を持たず、この AppView の Postgres だけが持つ。
 *
 * 通常の投稿は「クライアント → PDS → firehose → applyMutation」で入ってくるが、
 * こっそりは PDS を通らないので、ここで jetstream の commit と同じ形のイベントを組み立てて
 * applyMutation に渡す。タグ抽出・埋め込みの無効化・英訳プリウォーム・自動分析のキュー・
 * botたん返信ジョブの登録まで、投稿1件に紐づく処理はすべてあちら側に集まっているため、
 * 経路を分けても取り込み結果は通常の投稿と同じになる。
 */

/**
 * rkey は TID ではなくランダムにする。TID は先頭に投稿時刻を含むので、
 * 「みんなで全肯定」の匿名要約に URI が出た時点で投稿時刻が漏れてしまう。
 */
const opaqueRkey = () => randomBytes(16).toString("base64url");

/** 著者本人だけが触れることを保証する。URI の authority は著者ではないので did 列で見る。 */
async function ownedKossoriPost(uri: string, viewerDid: string) {
  const [row] = await db
    .select({
      uri: nagiPosts.uri,
      did: nagiPosts.did,
      appviewOnly: nagiPosts.appviewOnly,
    })
    .from(nagiPosts)
    .where(and(eq(nagiPosts.uri, uri), isNull(nagiPosts.deletedAt)))
    .limit(1);
  if (!row || row.did !== viewerDid)
    throw new ApiError(400, "invalid_request", "Post not found");
  if (!row.appviewOnly)
    throw new ApiError(
      400,
      "invalid_request",
      "Post is stored on the PDS; delete it there",
    );
  return row;
}

/**
 * 返信先の検証。こっそりスレッドに入れるのは著者本人と botたんだけなので、
 * ルートが自分のこっそり投稿であることを確かめる。
 */
async function assertReplyAllowed(
  reply: { root: { uri: string }; parent: { uri: string } },
  authorDid: string,
) {
  const [root] = await db
    .select({ did: nagiPosts.did, kossori: nagiPosts.kossori })
    .from(nagiPosts)
    .where(and(eq(nagiPosts.uri, reply.root.uri), isNull(nagiPosts.deletedAt)))
    .limit(1);
  if (!root) throw new ApiError(400, "invalid_request", "Reply root not found");
  if (!root.kossori)
    throw new ApiError(
      400,
      "invalid_request",
      "Reply root is not a kossori post",
    );
  if (root.did !== authorDid && authorDid !== config.botDid)
    throw new ApiError(
      403,
      "reply_not_allowed",
      "Only the author and bot-tan can reply to a kossori thread",
    );
}

/** 本文中に botたん宛の mention facet があるか（bot_server の mentionsBot と同じ判定）。 */
const mentionsBot = (record: any): boolean =>
  mentionsDid(record, config.botDid);

/**
 * botたん返信ジョブの登録。
 *
 * 通常の投稿は nagi_bot_server の jetstream ハンドラ（onNagiPost）が積むが、こっそりは
 * firehose を通らないのでそこには届かない。こっそりスレッドで返信できるのは botたんだけ
 * なので、ここで積み損ねると誰からも返事が来ない投稿になってしまう。
 *
 * 判定は onNagiPost に合わせる。ただし「第三者のスレッドへの割り込み」は、ルートが
 * 自分のこっそり投稿であることを assertReplyAllowed が保証済みなので見ない。
 * 親が botたんかどうかも、URI の authority が著者を表さないので did 列で引く。
 */
async function enqueueBotReply(
  uri: string,
  cid: string,
  authorDid: string,
  record: any,
): Promise<void> {
  if (authorDid === config.botDid || record.botSilent === true) return;
  if (record.reply) {
    const [parent] = await db
      .select({ did: nagiPosts.did })
      .from(nagiPosts)
      .where(eq(nagiPosts.uri, record.reply.parent.uri))
      .limit(1);
    const toBot = parent?.did === config.botDid || mentionsBot(record);
    if (!toBot) return;
  }
  await db
    .insert(nagiBotReplyJobs)
    .values({ sourceUri: uri, sourceCid: cid, authorDid, recordJson: record })
    .onConflictDoNothing();
}

export type CreateKossoriPostInput = {
  text: unknown;
  facets?: unknown;
  langs?: unknown;
  createdAt: unknown;
  botSilent?: unknown;
  silentReply?: unknown;
  reply?: {
    root: { uri: string; cid: string };
    parent: { uri: string; cid: string };
  };
  /**
   * 内部利用のみ。botたんの返信をソース投稿から決まる rkey で置くことで、ジョブが
   * リトライされても返信が二重にならないようにする（PDS 側の putRecord と同じ役割）。
   * XRPC のクライアントからは渡せない（lexicon に無い）。
   */
  rkey?: string;
};

export async function createKossoriPost(
  authorDid: string,
  input: CreateKossoriPostInput,
): Promise<{ uri: string; cid: string }> {
  // 画像・リンクカードは受け取らない。blob は参照レコードのある PDS でしか保持されず、
  // こっそり投稿には参照レコードが無いので、いずれ消える画像を抱えることになるため。
  const record = {
    $type: NAGI.post,
    text: input.text,
    ...(input.facets !== undefined ? { facets: input.facets } : {}),
    ...(input.langs !== undefined ? { langs: input.langs } : {}),
    createdAt: input.createdAt,
    kossori: true,
    ...(input.botSilent === true ? { botSilent: true } : {}),
    ...(input.reply && input.silentReply === true ? { silentReply: true } : {}),
    ...(input.reply ? { reply: input.reply } : {}),
  };
  if (!validateRecord(NAGI.post, record))
    throw new ApiError(400, "invalid_request", "Invalid post record");
  if (input.reply) await assertReplyAllowed(input.reply, authorDid);

  const rkey = input.rkey ?? opaqueRkey();
  // 実 CID を計算しておくと、編集で CID が変わる前提の既存ロジック
  // （community_affirmations の source_cid 突合、edited フラグ）がそのまま効く。
  const cid = (await cidForCbor(record)).toString();
  await applyMutation(
    {
      did: authorDid,
      time_us: Date.now() * 1_000,
      commit: {
        operation: "create",
        collection: NAGI.post,
        rkey,
        cid,
        record,
      },
    },
    { appviewOnly: true, emitPush: true },
  );
  const uri = appviewRecordUri(NAGI.post, rkey);
  await enqueueBotReply(uri, cid, authorDid, record);
  return { uri, cid };
}

export async function deleteKossoriPost(
  authorDid: string,
  uri: string,
): Promise<{ deleted: boolean }> {
  if (!isAppviewOwnedUri(uri))
    throw new ApiError(400, "invalid_request", "Not a kossori post URI");
  await ownedKossoriPost(uri, authorDid);
  const rkey = uri.slice(uri.lastIndexOf("/") + 1);
  await applyMutation({
    did: authorDid,
    time_us: Date.now() * 1_000,
    commit: { operation: "delete", collection: NAGI.post, rkey },
  }, { appviewOnly: true });
  return { deleted: true };
}
