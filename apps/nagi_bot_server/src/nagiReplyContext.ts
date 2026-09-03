import {
  db,
  nagiActors,
  nagiEmojis,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
  searchBotMemory,
  selectReplyMemoryContext,
} from "@bsky-affirmative-bot/database";
import {
  blobImagesToImageRefs,
  resolvePdsUrl,
} from "@bsky-affirmative-bot/bot-runtime";
import type { ImageRef } from "@bsky-affirmative-bot/shared-configs";
import { loadPreferredName } from "@bsky-affirmative-bot/clients";
import { and, desc, eq, isNull } from "drizzle-orm";

type ContextLink = { uri: string; title?: string; description?: string };

/**
 * プロンプトへ載せる過去投稿1件あたりの長さ。
 *
 * 記憶は「何を話した人か」を思い出すための手掛かりであって全文再読ではないので、
 * 先頭だけで足りる。書記素単位で切るのは絵文字・結合文字を割らないため。
 */
const MEMORY_EXCERPT_LIMIT = 400;

type NagiReactionPromptRow = {
  emoji: string;
  emojiUri: string | null;
  emojiName: string | null;
};

/** DBのリアクション行を、生成プロンプトへ渡す最小限の情報へ変換する。 */
export function receivedNagiReaction(row?: NagiReactionPromptRow) {
  if (!row) return undefined;
  return {
    emoji: row.emoji,
    ...(row.emojiUri
      ? { customEmojiName: row.emojiName ?? row.emoji }
      : {}),
  };
}

export function clipMemoryExcerpt(text: string): string {
  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(text)];
  if (graphemes.length <= MEMORY_EXCERPT_LIMIT) return text;
  return graphemes
    .slice(0, MEMORY_EXCERPT_LIMIT)
    .map((entry) => entry.segment)
    .join("");
}

export function extractContextLinks(record: any) {
  const links: ContextLink[] = [];
  const seen = new Set<string>();
  let cardLinkCount = 0;
  let facetLinkCount = 0;
  if (Array.isArray(record?.linkCards)) {
    for (const card of record.linkCards) {
      if (typeof card?.uri !== "string" || seen.has(card.uri)) continue;
      seen.add(card.uri);
      links.push({
        uri: card.uri,
        ...(typeof card.title === "string" ? { title: card.title } : {}),
        ...(typeof card.description === "string"
          ? { description: card.description }
          : {}),
      });
      cardLinkCount++;
    }
  }
  if (!Array.isArray(record?.facets))
    return { links, cardLinkCount, facetLinkCount };
  for (const facet of record.facets) {
    if (!Array.isArray(facet?.features)) continue;
    for (const feature of facet.features) {
      if (
        feature?.$type === "app.bsky.richtext.facet#link" &&
        typeof feature.uri === "string"
      ) {
        facetLinkCount++;
        if (seen.has(feature.uri)) continue;
        seen.add(feature.uri);
        links.push({ uri: feature.uri });
      }
    }
  }
  return { links, cardLinkCount, facetLinkCount };
}

const profileView = (
  did: string,
  actor?: { handle: string } | null,
  profile?: { displayName: string; description: string | null } | null,
) => ({
  did,
  handle: actor?.handle ?? did,
  displayName: profile?.displayName ?? actor?.handle ?? did,
  description: profile?.description ?? undefined,
});

export async function loadNagiReplyAuthor(did: string) {
  const [actors, profiles] = await Promise.all([
    db.select().from(nagiActors).where(eq(nagiActors.did, did)).limit(1),
    db.select().from(nagiProfiles).where(eq(nagiProfiles.did, did)).limit(1),
  ]);
  return {
    view: profileView(did, actors[0], profiles[0]),
    pdsUrl: actors[0]?.pdsUrl,
  };
}

export async function buildNagiReplyContext(job: any) {
  const record: any = job.recordJson;
  const botDid = process.env.NAGI_BOT_DID!;
  const text = typeof record.text === "string" ? record.text : "";

  const [
    author,
    preferredName,
    ownMemoryRows,
    friendMemoryRows,
    researchRows,
    reactionRows,
    quoteRows,
  ] = await Promise.all([
      loadNagiReplyAuthor(job.authorDid),
      // 本人が「こう呼んで」と申告していればそれを使う（無ければ displayName）。
      loadPreferredName(job.authorDid),
      text.trim()
        ? searchBotMemory({
            query: text,
            purpose: "reply_history",
            authorId: job.authorDid,
            limit: 10,
          }).catch((error) => {
            console.warn(`[WARN][${job.authorDid}] Failed to retrieve own bot memory:`, error);
            return [];
          })
        : Promise.resolve([]),
      text.trim()
        ? searchBotMemory({
            query: text,
            purpose: "reply_history",
            sources: ["bsky_affirmed_post", "nagi_affirmed_post"],
            excludeAuthorId: job.authorDid,
            limit: 10,
          }).catch((error) => {
            console.warn(`[WARN][${job.authorDid}] Failed to retrieve friend bot memory:`, error);
            return [];
          })
        : Promise.resolve([]),
      // botMemoryResearchWorker が先に調べておいた事実。思い出の枠を食わないよう
      // selectReplyMemoryContext には通さず、独立した根拠として渡す。
      text.trim()
        ? searchBotMemory({
            query: text,
            purpose: "reply_history",
            sources: ["web_research"],
            limit: 3,
          }).catch((error) => {
            console.warn(`[WARN][${job.authorDid}] Failed to retrieve research memory:`, error);
            return [];
          })
        : Promise.resolve([]),
      db
        .select({
          emoji: nagiReactions.emoji,
          emojiUri: nagiReactions.emojiUri,
          emojiName: nagiEmojis.name,
        })
        .from(nagiReactions)
        .innerJoin(nagiPosts, eq(nagiPosts.uri, nagiReactions.subjectUri))
        .leftJoin(nagiEmojis, eq(nagiEmojis.uri, nagiReactions.emojiUri))
        .where(
          and(
            eq(nagiReactions.did, job.authorDid),
            eq(nagiPosts.did, botDid),
            isNull(nagiPosts.deletedAt),
          ),
        )
        .orderBy(desc(nagiReactions.indexedAt))
        .limit(1),
      record.embed?.record?.uri
        ? db
            .select({
              post: nagiPosts,
              actor: nagiActors,
              profile: nagiProfiles,
            })
            .from(nagiPosts)
            .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
            .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
            .where(
              and(
                eq(nagiPosts.uri, record.embed.record.uri),
                isNull(nagiPosts.deletedAt),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

  // 1件あたりを切り詰める。会話モードは posts[0] しか見ないが、肯定リプライは
  // generateAffirmativeWord が posts.slice(1) を丸ごとプロンプトへ入れるので、
  // Nagi の投稿上限（3000書記素）× 10件がそのままコンテキストを食う。
  // ここで抑えないと、下流の予算トリムでは「今回の入力を切る」しか手が無くなる。
  const relatedPosts = ownMemoryRows.map((row) =>
    clipMemoryExcerpt(row.content),
  );

  let followersFriend:
    | { profile: ReturnType<typeof profileView>; post: string; uri: string }
    | undefined;
  if (text.trim()) {
    const { friendMemory: friendPost } = selectReplyMemoryContext(
      ownMemoryRows,
      friendMemoryRows,
      [botDid, process.env.BSKY_DID],
    );
    if (friendPost) {
      const [actors, profiles] = await Promise.all([
        db
          .select()
          .from(nagiActors)
          .where(eq(nagiActors.did, friendPost.authorId!))
          .limit(1),
        db
          .select()
          .from(nagiProfiles)
          .where(eq(nagiProfiles.did, friendPost.authorId!))
          .limit(1),
      ]);
      followersFriend = {
        profile: profileView(friendPost.authorId!, actors[0], profiles[0]),
        post: friendPost.content,
        uri: friendPost.sourceUri!,
      };
    }
  }

  const authorPds =
    author.pdsUrl ?? (await resolvePdsUrl(job.authorDid).catch(() => ""));
  const image: ImageRef[] = blobImagesToImageRefs(
    job.authorDid,
    authorPds,
    record.embed?.images,
  ).map((item) => ({ ...item, origin: "direct" as const }));
  const linkThumbnails = blobImagesToImageRefs(
    job.authorDid,
    authorPds,
    Array.isArray(record.linkCards)
      ? record.linkCards.map((card: any) => ({ image: card?.thumb }))
      : undefined,
  ).map((item) => ({ ...item, origin: "link-preview" as const }));
  image.push(...linkThumbnails);
  const embed: any = {};
  const quote = quoteRows[0];
  if (quote) {
    embed.profile_embed = profileView(
      quote.post.did,
      quote.actor,
      quote.profile,
    );
    embed.text_embed = quote.post.text;
    const quotePds =
      quote.actor?.pdsUrl ??
      (await resolvePdsUrl(quote.post.did).catch(() => ""));
    const quoteImages = blobImagesToImageRefs(
      quote.post.did,
      quotePds,
      quote.post.embedImages as any,
    ).map((item) => ({ ...item, origin: "quote" as const }));
    embed.image_embed = quoteImages;
    image.push(...quoteImages);
  }
  const { links, cardLinkCount, facetLinkCount } = extractContextLinks(record);
  if (links.length) {
    embed.links_embed = links;
    embed.uri_embed = links[0].uri;
    embed.title_embed = links[0].title;
    embed.description_embed = links[0].description;
  }

  return {
    follower: author.view,
    preferredName,
    posts: [text, ...relatedPosts],
    image: image.length ? image : undefined,
    embed: Object.keys(embed).length ? embed : undefined,
    receivedNagiReaction: receivedNagiReaction(reactionRows[0]),
    followersFriend: followersFriend ? [followersFriend] : undefined,
    isSubscriber: false,
    urlContextEnabled: links.length > 0,
    // 事前に調べてある分だけが鮮度の要る話題の根拠になる。無ければ
    // prepareOllamaGrounding が「知らないなら知らないと言う」ノートを渡す。
    researchMemory: researchRows.map((row) => row.content).join("\n\n") || null,
    diagnostics: {
      imageCount: image.length,
      directImageCount: image.filter((item) => item.origin === "direct").length,
      quoteImageCount: image.filter((item) => item.origin === "quote").length,
      linkThumbnailCount: linkThumbnails.length,
      relatedPostCount: relatedPosts.length,
      // プロンプト膨張の予兆。投稿前に見えるので、事故が起きてから journal を漁らずに済む。
      promptChars: [text, ...relatedPosts].reduce(
        (total, post) => total + post.length,
        0,
      ),
      hasQuote: Boolean(quote),
      hasLink: links.length > 0,
      cardLinkCount,
      facetLinkCount,
      linkCount: links.length,
      urlContextEnabled: links.length > 0,
      hasReaction: Boolean(reactionRows[0]),
      hasFollowersFriend: Boolean(followersFriend),
    },
  };
}
