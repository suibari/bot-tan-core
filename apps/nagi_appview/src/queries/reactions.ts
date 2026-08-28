import {
  db,
  nagiActors,
  nagiEmojis,
  nagiProfiles,
  nagiReactions,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import type { ReactionView } from "@bsky-affirmative-bot/nagi-lexicon";
import { desc, eq, inArray } from "drizzle-orm";
import { emojiView } from "../services/emoji.js";
import { groupReactionViews } from "./reactionViews.js";

/** 複数subjectのリアクションを、投稿・ニュース共通の表示形式へまとめる。 */
export async function getReactionViews(
  subjectUris: string[],
  viewerDid?: string,
): Promise<Map<string, ReactionView[]>> {
  const uris = [...new Set(subjectUris)];
  if (!uris.length) return new Map();
  const rows = await db
    .select({
      subjectUri: nagiReactions.subjectUri,
      emoji: nagiReactions.emoji,
      emojiKey: nagiReactions.emojiKey,
      emojiUri: nagiReactions.emojiUri,
      subjectDid: nagiPosts.did,
      did: nagiReactions.did,
      uri: nagiReactions.uri,
      handle: nagiActors.handle,
      displayName: nagiProfiles.displayName,
      avatarCid: nagiProfiles.avatarCid,
      emojiItem: nagiEmojis,
    })
    .from(nagiReactions)
    .leftJoin(nagiPosts, eq(nagiPosts.uri, nagiReactions.subjectUri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiReactions.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiReactions.did))
    .leftJoin(nagiEmojis, eq(nagiEmojis.uri, nagiReactions.emojiUri))
    .where(inArray(nagiReactions.subjectUri, uris))
    .orderBy(desc(nagiReactions.indexedAt));

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
