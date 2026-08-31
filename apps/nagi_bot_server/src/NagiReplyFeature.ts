import {
  db,
  nagiBotReplyJobs,
  nagiPosts,
  MemoryService,
} from "@bsky-affirmative-bot/database";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  classifyPostThread,
  didFromAtUri,
  mentionsDid,
} from "@bsky-affirmative-bot/bot-runtime";
import { eq } from "drizzle-orm";

/** 本文中に bot への mention facet があるか。 */
export function mentionsBot(record: any, botDid: string) {
  return mentionsDid(record, botDid);
}

/** bot 宛のリプライ（親が bot、または bot をメンション）か。 */
export function isReplyToBot(record: any, botDid: string) {
  if (!record?.reply) return false;
  const parentDid = didFromAtUri(record.reply.parent?.uri);
  return parentDid === botDid || mentionsBot(record, botDid);
}

/**
 * こっそりスレッド版の isReplyToBot。
 *
 * こっそり投稿の URI は AppView の DID 配下（著者を URI から辿らせないため）なので、
 * uriAuthorDid では親の書き手が分からない。DB の did 列で引き直す。これを怠ると
 * 「botたんへの返信」が会話モードに入らず、こっそりスレッドだけ会話が続かなくなる。
 */
export async function isKossoriReplyToBot(record: any, botDid: string) {
  if (!record?.reply) return false;
  if (mentionsBot(record, botDid)) return true;
  const parentUri = record.reply.parent?.uri;
  if (typeof parentUri !== "string") return false;
  const [parent] = await db
    .select({ did: nagiPosts.did })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, parentUri))
    .limit(1);
  return parent?.did === botDid;
}

/**
 * 第三者のスレッドへの割り込みか。
 * Bluesky の isReplyInThirdPartyThread と同じ意図だが、bot の定期ポストへの返信を
 * 会話に乗せたいので root が bot の場合も許可する。
 */
export function isThirdPartyThread(record: any, authorDid: string, botDid: string) {
  if (!record?.reply) return false;
  const kind = classifyPostThread(record, authorDid, botDid);
  return kind === "third-party-thread" || kind === "bot-thread-third-party";
}

export async function onNagiPost(evt: any) {
  if (!evt.commit?.record) {
    return;
  }

  const did = evt.did;
  const record = evt.commit.record;
  const botDid = process.env.NAGI_BOT_DID;

  if (!botDid || did === botDid || record.$type !== NAGI.post) {
    return;
  }

  // botたんサイレント機能がONの投稿には返信しない。
  if (record.botSilent) {
    console.log(`[INFO][NAGI][${did}] Skipping reply: botSilent flag enabled`);
    return;
  }

  const topLevel = !record.reply;
  const toBot = isReplyToBot(record, botDid);

  if (!topLevel && !toBot) {
    return;
  }

  // 他人のスレッド内で bot に話しかけられても割り込まない。
  if (isThirdPartyThread(record, did, botDid)) {
    console.log(`[INFO][NAGI][${did}] Skipping reply: third-party thread root`);
    return;
  }

  const uri = `at://${did}/${NAGI.post}/${evt.commit.rkey}`;

  if (toBot) {
    // bot 宛リプライは Bluesky 側と同じく Gemini を使う前に記憶・計上しておく。
    await MemoryService.upsertReply(did, {
      reply: record.text,
      uri,
      isRead: 0,
    });
    await MemoryService.logUsage("reply", did);
  }

  await db
    .insert(nagiBotReplyJobs)
    .values({
      sourceUri: uri,
      sourceCid: evt.commit.cid,
      authorDid: did,
      recordJson: record,
    })
    .onConflictDoNothing();
}
