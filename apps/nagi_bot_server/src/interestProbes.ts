/**
 * おすすめフィードの「興味の近さ」の材料のうち、Bluesky 由来のもの（nagi.actor_interest_probes）。
 * 仕様は nagi_client の openspec（API-10）。
 *
 * Nagi の埋め込み済み投稿が足りない新規登録者のために、登録時の分析で読んだ Bluesky 投稿を
 * 埋め込んで置く。本文は保存しない。Nagi 投稿で測れるようになったら消す。
 */
import type { AppBskyFeedDefs } from "@atproto/api";
import { db, generateEmbeddings, nagiActorInterestProbes } from "@bsky-affirmative-bot/database";
import { eq, sql } from "drizzle-orm";

/** 材料にする投稿の本数。AppView の PROBE_POSTS と揃える。 */
export const INTEREST_PROBE_POSTS = 10;
/** Nagi 投稿だけで測れるとみなす埋め込み済み投稿数。AppView の MIN_PROBE_POSTS と揃える。 */
export const MIN_NAGI_PROBE_POSTS = 5;

/**
 * 材料にする投稿の本文を選ぶ。返信は相手ありきの短文が多く本人の関心を表しにくいので除く。
 * リポストは getConcatAuthorFeed の時点で落ちているが、念のためここでも見る。
 */
export function selectProbeTexts(feeds: AppBskyFeedDefs.FeedViewPost[]): string[] {
  const texts: string[] = [];
  for (const feed of feeds) {
    if (feed.reason) continue;
    const record = feed.post.record as { text?: unknown; reply?: unknown };
    if (record.reply) continue;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    texts.push(text);
    if (texts.length >= INTEREST_PROBE_POSTS) break;
  }
  return texts;
}

/** Bluesky 投稿の埋め込みを保存する（前の材料は置き換える）。保存した件数を返す。 */
export async function saveBlueskyInterestProbes(
  did: string,
  texts: string[],
  embed: typeof generateEmbeddings = generateEmbeddings,
): Promise<number> {
  if (!texts.length) return 0;
  const embeddings = (await embed(texts, { background: true })).filter(
    (embedding): embedding is number[] => Array.isArray(embedding),
  );
  await db.transaction(async (tx) => {
    await tx.delete(nagiActorInterestProbes).where(eq(nagiActorInterestProbes.did, did));
    if (embeddings.length)
      await tx
        .insert(nagiActorInterestProbes)
        .values(embeddings.map((embedding, position) => ({ did, position, embedding })));
  });
  return embeddings.length;
}

/** Nagi 投稿で測れるようになった人の Bluesky 由来の材料を消す。消した人数を返す。 */
export async function pruneInterestProbes(): Promise<number> {
  const rows = await db.execute<{ did: string }>(sql`
    delete from nagi.actor_interest_probes p
     where (select count(*) from (
              select 1 from nagi.posts
               where did = p.did and deleted_at is null and embedding is not null
               limit ${MIN_NAGI_PROBE_POSTS}) n) >= ${MIN_NAGI_PROBE_POSTS}
    returning p.did
  `);
  return new Set(rows.map((row) => row.did)).size;
}
