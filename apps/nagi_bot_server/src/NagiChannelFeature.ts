import { db, nagiChannels, nagiPosts } from "@bsky-affirmative-bot/database";
import { generateSingleResponse } from "@bsky-affirmative-bot/bot-brain";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, asc, desc, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
import retry from "async-retry";
import { publishNagiPost } from "./nagiPost.js";
import { topicPrompt, welcomePrompt } from "./nagiChannelPrompt.js";
import { startWorkerLoop } from "./workerLoop.js";

/** 投稿が途絶えてから話題提供するまでの時間（時間）。既定1週間。 */
const DORMANT_HOURS = Number(process.env.NAGI_CHANNEL_DORMANT_HOURS ?? 168);
/** 過疎スキャンの間隔。 */
const SCAN_INTERVAL_MS = Number(
  process.env.NAGI_CHANNEL_SCAN_INTERVAL_MS ?? 6 * 3_600_000,
);
/** 1回のスキャンで話題提供する最大チャンネル数（バースト防止）。 */
const MAX_PER_RUN = 3;

type ChannelRef = { uri: string; cid: string; name: string; description: string | null };

/** botたんとして、指定チャンネルにトップレベル投稿する（channel を付けて CH TL に載せる）。 */
async function postToChannel(channel: ChannelRef, text: string) {
  if (!text.trim()) return;
  await retry(
    () =>
      publishNagiPost({
        text,
        label: "NAGI_CHANNEL",
        langs: ["ja"],
        channel: { uri: channel.uri, cid: channel.cid },
      }),
    {
      retries: 2,
      onRetry: (error: any, attempt) =>
        console.warn(`[WARN][NAGI][channel] post retry ${attempt}:`, error?.message ?? error),
    },
  );
}

/**
 * チャンネル作成イベントのハンドラ（Phase 2）。
 * 新しいチャンネルへ botたんが「盛り上げ初回投稿」を1回だけ落とす。
 * 挨拶文は name / description から Gemini でテーマ寄せ生成する。
 */
export async function onNagiChannel(evt: any) {
  if (!evt.commit?.record) return;
  const record = evt.commit.record;
  if (record.$type !== NAGI.channel) return;
  if (!process.env.NAGI_BOT_DID) return;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return;
  const uri = `at://${evt.did}/${NAGI.channel}/${evt.commit.rkey}`;
  const channel: ChannelRef = {
    uri,
    cid: evt.commit.cid,
    name,
    description: typeof record.description === "string" ? record.description : null,
  };
  try {
    const text = await generateSingleResponse(welcomePrompt(name, channel.description), undefined, "NAGI_CHANNEL_WELCOME");
    await postToChannel(channel, text);
    console.log(`[INFO][NAGI][channel] Welcome post created for ${uri}`);
  } catch (error) {
    console.error(`[ERROR][NAGI][channel] Welcome post failed for ${uri}:`, error);
  }
}

/**
 * 過疎チャンネルへの話題提供（Phase 2）。
 *
 * 「最新投稿が bot 以外のユーザーによるもので、かつ閾値より古い」チャンネルにだけお題を落とす。
 * こうすると、一度 bot が話題提供すると最新投稿が bot になる → 次回以降は条件を満たさず沈黙し、
 * ユーザーが投稿して初めて最新がユーザー投稿に戻り、また過疎化したときだけ再度お題を出す。
 * = 反応の無いチャンネルに延々と投稿し続けない。空チャンネル（bot の歓迎投稿だけ／投稿ゼロ）も対象外。
 */
async function scanDormantChannels() {
  const botDid = process.env.NAGI_BOT_DID;
  if (!botDid) return;
  const threshold = new Date(Date.now() - DORMANT_HOURS * 3_600_000);
  // 各チャンネルの「最新投稿」1件（作者と時刻）。削除済みは除く。
  const latest = db
    .selectDistinctOn([nagiPosts.channelUri], {
      channelUri: nagiPosts.channelUri,
      did: nagiPosts.did,
      indexedAt: nagiPosts.indexedAt,
    })
    .from(nagiPosts)
    .where(and(isNull(nagiPosts.deletedAt), isNotNull(nagiPosts.channelUri)))
    .orderBy(nagiPosts.channelUri, desc(nagiPosts.indexedAt))
    .as("latest");
  const rows = await db
    .select({
      uri: nagiChannels.uri,
      cid: nagiChannels.cid,
      name: nagiChannels.name,
      description: nagiChannels.description,
    })
    .from(nagiChannels)
    // innerJoin なので投稿ゼロのチャンネルは自然に除外される。
    .innerJoin(latest, eq(latest.channelUri, nagiChannels.uri))
    .where(
      and(
        isNull(nagiChannels.deletedAt),
        ne(latest.did, botDid), // 最新がユーザー（bot 以外）の投稿
        lt(latest.indexedAt, threshold), // かつ閾値より古い（＝反応が途絶えた）
      ),
    )
    .orderBy(asc(latest.indexedAt))
    .limit(MAX_PER_RUN);

  for (const ch of rows) {
    try {
      const text = await generateSingleResponse(topicPrompt(ch.name, ch.description), undefined, "NAGI_CHANNEL_TOPIC");
      await postToChannel(ch, text);
      console.log(`[INFO][NAGI][channel] Topic post created for ${ch.uri}`);
    } catch (error) {
      console.error(`[ERROR][NAGI][channel] Topic post failed for ${ch.uri}:`, error);
    }
  }
}

/** 過疎チャンネル話題提供の定期スキャンを開始する。 */
export function startNagiChannelTopicScheduler() {
  startWorkerLoop({
    name: "NAGI_CHANNEL",
    intervalMs: SCAN_INTERVAL_MS,
    tick: scanDormantChannels,
  });
}
