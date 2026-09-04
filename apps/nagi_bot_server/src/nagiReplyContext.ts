import {
  db,
  nagiActors,
  nagiEmojis,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
  buildMemoryContext,
  type MemoryContext,
} from "@bsky-affirmative-bot/database";
import {
  blobImagesToImageRefs,
  resolvePdsUrl,
} from "@bsky-affirmative-bot/bot-runtime";
import type { ImageRef } from "@bsky-affirmative-bot/shared-configs";
import { loadPreferredName } from "@bsky-affirmative-bot/clients";
import { isAppviewOwnedUri } from "@bsky-affirmative-bot/nagi-lexicon";
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

/**
 * この返信がこっそりの文脈か。
 *
 * こっそりの記憶は**本人がこっそりで話しているときだけ**引ける。通常投稿への返信では
 * 1件も混ざらない（buildMemoryContext の既定が public のみ）。
 *
 * 可視性の正は nagi.posts.kossori 列。URI が AppView DID 配下かどうか
 * （＝保管場所）とは別物なので、URI だけでは判定しない。URI で先に絞るのは、
 * 公開投稿のたびに1クエリ増やさないため。
 *
 * 行がまだ無いときは true に倒す。取り込みが追いつく前でも、こっそりを
 * 通常文脈と誤認して公開記憶と混ぜるより安全側だから。ここで true にしても
 * 増えるのは「本人自身のこっそり記憶」だけで、他人の記憶は出ない。
 */
async function isKossoriSource(sourceUri: string): Promise<boolean> {
  const [post] = await db
    .select({ kossori: nagiPosts.kossori })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, sourceUri))
    .limit(1);
  return post?.kossori ?? true;
}

export async function buildNagiReplyContext(job: any) {
  const record: any = job.recordJson;
  const botDid = process.env.NAGI_BOT_DID!;
  const text = typeof record.text === "string" ? record.text : "";

  const emptyMemory: MemoryContext = { recent: [], own: [], related: [], research: [] };
  const kossori = isAppviewOwnedUri(job.sourceUri)
    ? await isKossoriSource(job.sourceUri)
    : false;
  const [
    author,
    preferredName,
    memory,
    reactionRows,
    quoteRows,
  ] = await Promise.all([
      loadNagiReplyAuthor(job.authorDid),
      // 本人が「こう呼んで」と申告していればそれを使う（無ければ displayName）。
      loadPreferredName(job.authorDid),
      // 本人の記憶は「フィルタ」ではなく「係数」で効かせる。その人との記憶が無くても
      // 全体の記憶は残るので、初対面でも思い出の引き出しが空にならない。
      // web_research は思い出の枠を食わないよう buildMemoryContext が別枠で返す。
      text.trim()
        ? buildMemoryContext({
            query: text,
            purpose: "reply_history",
            subjectKey: job.authorDid,
            // こっそりの文脈のときだけ、その人自身のこっそり記憶を候補へ足す。
            // 通常投稿では未指定なので public しか引かれない。
            kossoriSubjectKey: kossori ? job.authorDid : undefined,
            limit: 10,
            researchLimit: 3,
            // 短期記憶は botContext 側（formatBotContext）が常時載せる。ここでは引かない。
            digestDays: 0,
            excludeAuthorIds: [botDid, process.env.BSKY_DID],
          }).catch((error) => {
            console.warn(`[WARN][${job.authorDid}] Failed to build memory context:`, error);
            return emptyMemory;
          })
        : Promise.resolve(emptyMemory),
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
  // 本人の記憶だけを使う。ここは「その人自身の過去の投稿」として
  // generateAffirmativeWord へ渡るスロットなので、他人の記憶を混ぜると
  // 本人が言っていないことを言ったことにしてしまう。
  const relatedPosts = memory.own.map((row) =>
    clipMemoryExcerpt(row.content),
  );

  let followersFriend:
    | { profile: ReturnType<typeof profileView>; post: string; uri: string }
    | undefined;
  const friendPost = memory.friend;
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
    researchMemory: memory.research.map((row) => row.content).join("\n\n") || null,
    // 触れてよいかは検索側（selectNotableMemory）が既に判断済み。無ければ
    // プロンプトに節ごと出ないので、生成側に条件分岐は増えない。
    notableMemory: memory.notable
      ? {
          content: clipMemoryExcerpt(memory.notable.content),
          occurredAt: memory.notable.occurredAt,
        }
      : null,
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
      hasNotableMemory: Boolean(memory.notable),
      notableSalience: memory.notable?.salience ?? null,
    },
  };
}
