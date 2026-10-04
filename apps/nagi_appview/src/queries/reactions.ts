import {
  db,
  nagiActors,
  nagiEmojis,
  nagiProfiles,
  nagiReactions,
  nagiPosts,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import type { ReactionView } from "@bsky-affirmative-bot/nagi-lexicon";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { emojiView } from "../services/emoji.js";
import { groupReactionViews } from "./reactionViews.js";

/**
 * subject ごとのリアクション行。subjectDid は「送り主を見てよい受け取り手」で、
 * ゼンカツは投稿テーブルに無いので提出の持ち主から解決する。
 */
export function reactionRowsQuery(uris: string[]) {
  return db
    .select({
      subjectUri: nagiReactions.subjectUri,
      emoji: nagiReactions.emoji,
      emojiKey: nagiReactions.emojiKey,
      emojiUri: nagiReactions.emojiUri,
      subjectDid: sql<
        string | null
      >`coalesce(${nagiPosts.did}, ${nagiZenkatsuSubmissions.did})`,
      did: nagiReactions.did,
      uri: nagiReactions.uri,
      handle: nagiActors.handle,
      displayName: nagiProfiles.displayName,
      avatarCid: nagiProfiles.avatarCid,
      emojiItem: nagiEmojis,
    })
    .from(nagiReactions)
    .leftJoin(nagiPosts, eq(nagiPosts.uri, nagiReactions.subjectUri))
    .leftJoin(
      nagiZenkatsuSubmissions,
      eq(nagiZenkatsuSubmissions.uri, nagiReactions.subjectUri),
    )
    .leftJoin(nagiActors, eq(nagiActors.did, nagiReactions.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiReactions.did))
    .leftJoin(nagiEmojis, eq(nagiEmojis.uri, nagiReactions.emojiUri))
    .where(inArray(nagiReactions.subjectUri, uris))
    .orderBy(desc(nagiReactions.indexedAt));
}

/** 複数subjectのリアクションを、投稿・ニュース共通の表示形式へまとめる。 */
export async function getReactionViews(
  subjectUris: string[],
  viewerDid?: string,
): Promise<Map<string, ReactionView[]>> {
  const uris = [...new Set(subjectUris)];
  if (!uris.length) return new Map();
  const rows = await reactionRowsQuery(uris);

  return groupReactionViews(
    rows.map((row) => ({
      ...row,
      bluemoji: row.emojiItem
        ? (emojiView(row.emojiItem) ?? undefined)
        : undefined,
    })),
    viewerDid,
  );
}
