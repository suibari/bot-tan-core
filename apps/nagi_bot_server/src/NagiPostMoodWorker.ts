/**
 * 日記の感情グラフ用に、投稿ごとの気分を採点して nagi.post_moods へ入れるワーカー。
 *
 * 対象は「採点が無い／cid が変わった（編集）／採点基準の版が古い」投稿。
 * **過去分のバックフィルもこのワーカーが兼ねる。** 新しい投稿から順に拾うので、
 * 導入直後でも直近の日から埋まり、古い日は後からゆっくり追いつく。
 *
 * ユーザーは結果を待っていない（グラフは後から見返すもの）ので即時起動の口は持たない。
 * AGENTS.md「間隔の決め方」のとおり、間隔を詰めても速くならず Ollama の並列が増えるだけ。
 */
import { db, nagiPostMoods, nagiPosts } from "@bsky-affirmative-bot/database";
import {
  POST_MOOD_VERSION,
  isOllamaConfigured,
  isPostMoodRouteLocal,
  scorePostMood,
} from "@bsky-affirmative-bot/bot-brain";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { startWorkerLoop } from "./workerLoop.js";

/**
 * 1 tick で採点する件数。1件あたり実測 1.2〜1.3 秒（gemma-4-12B、2026-09-25）なので
 * 1 tick は 30 秒前後。**Ollama へは常に直列1本。** 同じ Ollama を共用している別アプリに
 * 間を空けるため、tick の間隔はそれより長くとる。
 */
const BATCH_SIZE = 24;
const WORKER_INTERVAL_MS = 60_000;
const LOG_PREFIX = "[nagi-post-mood]";

export type PendingMoodPost = { uri: string; did: string; cid: string; text: string };

/**
 * botたん自身の投稿（全員への返信など）は除く。感情グラフは利用者の日記のためのもので、
 * 開発DBでは投稿の半分以上（4,964件中2,811件）が bot の返信だった。
 */
export async function pendingMoodPosts(limit: number): Promise<PendingMoodPost[]> {
  const botDid = process.env.NAGI_BOT_DID;
  return db
    .select({
      uri: nagiPosts.uri,
      did: nagiPosts.did,
      cid: nagiPosts.cid,
      text: nagiPosts.text,
    })
    .from(nagiPosts)
    .leftJoin(nagiPostMoods, eq(nagiPostMoods.postUri, nagiPosts.uri))
    .where(
      and(
        isNull(nagiPosts.deletedAt),
        botDid ? ne(nagiPosts.did, botDid) : undefined,
        or(
          isNull(nagiPostMoods.postUri),
          ne(nagiPostMoods.cid, nagiPosts.cid),
          ne(nagiPostMoods.version, POST_MOOD_VERSION),
        ),
      ),
    )
    .orderBy(desc(nagiPosts.recordCreatedAt))
    .limit(limit);
}

/**
 * 1件を採点して保存する。採点不能（本文が空・出力が壊れている）も valence=null で保存し、
 * 同じ投稿で Ollama を叩き続けない。**Ollama の接続失敗は保存せずに投げる**
 * （全件を採点不能で埋めてしまわないため。次の tick で拾い直す）。
 */
export async function scoreAndStore(post: PendingMoodPost): Promise<void> {
  const mood = await scorePostMood(post.text);
  // 採点の数秒のあいだに削除・編集・退会された投稿へ、古い本文の点を書き戻さない。
  const [current] = await db
    .select({ cid: nagiPosts.cid })
    .from(nagiPosts)
    .where(and(eq(nagiPosts.uri, post.uri), isNull(nagiPosts.deletedAt)));
  if (current?.cid !== post.cid) return;
  const values = {
    did: post.did,
    cid: post.cid,
    valence: mood?.valence ?? null,
    expressive: mood?.expressive ?? false,
    version: POST_MOOD_VERSION,
    scoredAt: new Date(),
  };
  await db
    .insert(nagiPostMoods)
    .values({ postUri: post.uri, ...values })
    .onConflictDoUpdate({ target: nagiPostMoods.postUri, set: values });
}

/**
 * 戻り値は採点した件数。
 * **ワーカーの tick 以外から回さないこと。** startWorkerLoop の直列性を迂回すると
 * Ollama への同時リクエストが増える（バックフィル用スクリプトを置かないのも同じ理由）。
 */
export async function runPostMoodBatch(limit = BATCH_SIZE): Promise<number> {
  const posts = await pendingMoodPosts(limit);
  let scored = 0;
  for (const post of posts) {
    try {
      await scoreAndStore(post);
      scored += 1;
    } catch (error) {
      // Ollama 側の不調は同じ tick の残りでも続くので、打ち切って次の tick に回す。
      console.error(`${LOG_PREFIX} failed to score ${post.uri}; stopping this batch:`, error);
      break;
    }
  }
  if (scored) console.log(`${LOG_PREFIX} scored ${scored}/${posts.length} posts`);
  return scored;
}

export function startNagiPostMoodWorker() {
  if (!isOllamaConfigured()) {
    console.warn(`${LOG_PREFIX} Ollama is not configured; post moods are not scored`);
    return;
  }
  if (!isPostMoodRouteLocal()) {
    // 本人しか見ない値なので外へは出さない。毎 tick 全件失敗させるより起動しないほうがよい。
    console.warn(`${LOG_PREFIX} AI_ROUTE_NAGI_POST_MOOD is not a local Ollama route; post moods are not scored`);
    return;
  }
  startWorkerLoop({
    name: "NAGI_POST_MOOD",
    intervalMs: WORKER_INTERVAL_MS,
    tick: () => runPostMoodBatch(),
  });
}
