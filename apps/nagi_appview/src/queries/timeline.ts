import {
  db,
  nagiActors,
  nagiBotReplyJobs,
  nagiChannels,
  nagiPostScores,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  NAGI,
  type ConversationView,
  type FeedItem,
  type PostView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { config } from "../config.js";
import { getCurrentTitles, getSuperPositiveLevels } from "./badges.js";
import {
  EMPTY_MUTES,
  loadMutes,
  muteVisibility,
  sibNotMuted,
  type MuteSet,
} from "./mutes.js";
import { getNewsQuoteViews } from "./positiveNews.js";
import { getReactionViews } from "./reactions.js";
import { parseContentWarning } from "../util/contentWarning.js";
import { ADULT_LABELS } from "../services/moderation/index.js";
import { viewerIsAdult } from "../services/ageAssurance.js";
import { loadPrivateListMemberDids } from "./privateList.js";
export const encodeCursor = (date: Date, uri: string) =>
  Buffer.from(JSON.stringify([date.toISOString(), uri])).toString("base64url");
export const decodeCursor = (cursor?: string): [Date, string] | undefined => {
  try {
    const [d, u] = JSON.parse(Buffer.from(cursor!, "base64url").toString());
    return [new Date(d), u];
  } catch {
    return undefined;
  }
};
export const postSelection = {
  post: nagiPosts,
  actor: nagiActors,
  profile: nagiProfiles,
  score: nagiPostScores.score,
  botReplyUri: nagiPostScores.botReplyUri,
};
/**
 * ホーム候補の DID 集合を text[] として1回だけ束縛する。
 * 素の配列を埋めるとレコード構成子に展開されて壊れる（mutedActorsParam と同じ理由）。
 */
const homeActorsParam = (actorDids: string[]) =>
  sql`${sql.param(actorDids)}::text[]`;

/**
 * ホーム候補の可視性条件。スレッド単位の最新活動順に並べるため、リストメンバーの返信も
 * 候補に含める。公開範囲(kossori)はスレッドルートが所有するので、ルート行を
 * 引いて判定する（ルート行では coalesce が自分自身を指すので、ルート・返信を1本で扱える）。
 * 本人の kossori だけを許す。
 */
export function homeTimelineVisibility(
  homeDid: string,
  actorDids: string[],
): SQL[] {
  return [
    inArray(nagiPosts.did, actorDids),
    sql`exists (
      select 1 from nagi.posts as thread_root
      where thread_root.uri = coalesce(${nagiPosts.replyRootUri}, ${nagiPosts.uri})
        and thread_root.deleted_at is null
        and thread_root.did = any(${homeActorsParam(actorDids)})
        and (not thread_root.kossori or thread_root.did = ${homeDid})
    )`,
  ];
}

/**
 * 会話グループ化の代表選出 `not exists (... sib ...)` に足す、ホーム専用の条件。
 * ホームの代表は「そのスレッドでリストメンバーが最後に書いた投稿」。兄弟をメンバーに
 * 限らないと、リスト外の人の返信が代表になり、その代表が候補条件（homeTimelineVisibility）
 * で落ちてスレッドごとホームから消える。リスト外の返信は会話バブルとしては表示される。
 */
export const homeSiblingFilter = (actorDids: string[] | undefined) =>
  actorDids ? sql` and sib.did = any(${homeActorsParam(actorDids)})` : sql``;

/**
 * プロフィールフィードと CH タイムライン用のこっそり除外。
 *
 * こっそりは「共有TLに出さない」だけの設定ではなく、本人以外には一切見せないものなので、
 * 共有TL・検索だけでなくこれらの経路でも落とす（ホームは homeTimelineVisibility が
 * 同じ判定を持っているため対象外）。公開範囲はスレッドルートが所有する。
 *
 * 共有TL版の `coalesce(..., false)` と違い「ルートが他人のこっそりだと確認できたときだけ
 * 隠す」形にしてある。fail closed にすると、ルートがまだ取り込まれていない返信まで
 * プロフィールの返信タブから消えてしまうため。削除済みのルートは tombstone として行が残り
 * kossori も保たれるので、この形でもこっそりスレッドは隠れ続ける。
 */
export function kossoriVisibility(viewerDid?: string): SQL {
	const viewerMatch = viewerDid
		? sql`${nagiPosts.did} = ${viewerDid}`
		: sql`false`;
	const threadRootViewerMatch = viewerDid
		? sql`thread_root.did = ${viewerDid}`
		: sql`false`;
	return sql`
    case
      when ${nagiPosts.replyRootUri} is null
        then not ${nagiPosts.kossori} or ${viewerMatch}
      else not exists (
        select 1
        from nagi.posts as thread_root
        where thread_root.uri = ${nagiPosts.replyRootUri}
          and thread_root.kossori
          and not (${threadRootViewerMatch})
      )
    end
  `;
}

/**
 * 未成年ビューアに成人向けコンテンツを渡さないためのフィルタ。
 *
 * クライアント設定（warn/hide/ignore）とは別物で、これはサーバ側の強制。未成年は
 * 設定で解除できない。判定待ち（moderation_version IS NULL）も落とすのは、判定が
 * 非同期になったことで生じる数秒の露出窓を、守るべき相手にだけ閉じるため。
 * 18歳の誕生日を過ぎれば getAgeAssurance が成人を返すので自動的に外れる。
 */
export function adultContentVisibility(isAdult: boolean): SQL[] {
  if (isAdult) return [];
  return [
    sql`${nagiPosts.moderationVersion} is not null`,
    sql`not (${nagiPosts.moderationLabels} && ${ADULT_LABELS_ARRAY})`,
    sql`not (${nagiPosts.selfLabels} && ${ADULT_LABELS_ARRAY})`,
  ];
}

/** 上の式で使う text[] リテラル。 */
const ADULT_LABELS_ARRAY = sql`${sql.raw(
  `array[${ADULT_LABELS.map((label) => `'${label}'`).join(",")}]::text[]`,
)}`;

/** 未成年ビューアが見てはいけない行か。SQL を通らない経路の最後の砦。 */
export function isAdultOnlyRow(post: typeof nagiPosts.$inferSelect): boolean {
  if (post.moderationVersion === null) return true;
  return [...post.moderationLabels, ...post.selfLabels].some((label) =>
    (ADULT_LABELS as readonly string[]).includes(label),
  );
}

/**
 * my Nagi の「リストの動き」用。1人1件の最新ルート投稿を選ぶ経路なので、返信は候補に
 * 入れない（スレッド単位の最新活動順で見せるホームTLとは意味が違う）。
 */
export function homeRootVisibility(
  homeDid: string,
  actorDids: string[],
): SQL[] {
  return [
    isNull(nagiPosts.replyParentUri),
    inArray(nagiPosts.did, actorDids),
    or(eq(nagiPosts.did, homeDid), eq(nagiPosts.kossori, false))!,
  ];
}
export type PostRow = {
  post: typeof nagiPosts.$inferSelect;
  actor: typeof nagiActors.$inferSelect | null;
  profile: typeof nagiProfiles.$inferSelect | null;
  score: number | null;
  botReplyUri: string | null;
};
export async function fetchPostRows(uris: string[]): Promise<PostRow[]> {
  if (!uris.length) return [];
  return db
    .select(postSelection)
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(inArray(nagiPosts.uri, uris));
}
/**
 * ミュート著者の投稿を落とす。mutes は呼び出し側が明示的に渡したときだけ効く（既定は空）＝
 * スレッド詳細・プロフィールはミュート非適用という仕様どおり、渡さなければ素通しになる。
 */
const dropMutedRows = (rows: PostRow[], mutes: MuteSet) =>
  mutes.actors.length
    ? rows.filter((r) => !mutes.actors.includes(r.post.did))
    : rows;
export async function hydratePostViews(
  rows: PostRow[],
  viewerDid?: string,
  quoteDepth = 0,
  mutes: MuteSet = EMPTY_MUTES,
): Promise<PostView[]> {
  // SQL 側でも落としているが、スレッド・ブックマーク・通知など経路が多いので
  // hydrate でも必ず落とす。未成年に成人向けを渡さないことをここ1箇所で担保する。
  if (!(await viewerIsAdult(viewerDid)))
    rows = rows.filter((r) => !isAdultOnlyRow(r.post));
  const uris = rows.map((r) => r.post.uri);
  const reactions = await getReactionViews(uris, viewerDid);
  const dids = rows.map((r) => r.post.did);
  const [levels, titles] = await Promise.all([
    getSuperPositiveLevels(dids),
    getCurrentTitles(dids),
  ]);
  const rootUris = [
    ...new Set(
      rows.flatMap(({ post }) =>
        post.replyRootUri ? [post.replyRootUri] : [],
      ),
    ),
  ];
  const threadRoots = rootUris.length
    ? new Map(
        (
          await db
            .select({
              uri: nagiPosts.uri,
              cid: nagiPosts.cid,
              kossori: nagiPosts.kossori,
            })
            .from(nagiPosts)
            .where(
              and(
                inArray(nagiPosts.uri, rootUris),
                isNull(nagiPosts.deletedAt),
              ),
            )
        ).map((root) => [root.uri, root]),
      )
    : new Map<string, { uri: string; cid: string; kossori: boolean }>();
  // バッジ表示用にチャンネルを引く（uri→{name,cid}）。所属 CH のある投稿だけ。
  // 返信はレコードに channel を持たない（ルート所有）ので、cid もここから解決する。
  const channelUris = [
    ...new Set(
      rows.flatMap((r) => (r.post.channelUri ? [r.post.channelUri] : [])),
    ),
  ];
  const channelRefs = channelUris.length
    ? new Map(
        (
          await db
            .select({
              uri: nagiChannels.uri,
              cid: nagiChannels.cid,
              name: nagiChannels.name,
            })
            .from(nagiChannels)
            .where(inArray(nagiChannels.uri, channelUris))
        ).map((c) => [c.uri, { cid: c.cid, name: c.name }]),
      )
    : new Map<string, { cid: string; name: string }>();
  const views = rows.map(({ post, actor, profile, score }) => {
    const deleted = Boolean(post.deletedAt);
    const recordReply = (post.recordJson as any)?.reply;
    const record = post.recordJson as any;
    const contentWarning = !deleted
      ? parseContentWarning(post.text)
      : { status: "none" as const };
    const threadRoot = post.replyRootUri
      ? threadRoots.get(post.replyRootUri)
      : undefined;
    // こっそりは返信レコードの値ではなくルートが所有する。
    // 参照先を解決できない返信は、意図しない共有TL露出を避けるため非共有側に倒す。
    const threadKossori = post.replyRootUri
      ? threadRoot
        ? threadRoot.kossori
        : true
      : post.kossori;
    const images =
      !deleted && Array.isArray(post.embedImages)
        ? post.embedImages.flatMap((item: any) => {
            const cid = item?.image?.ref?.$link;
            if (typeof cid !== "string" || typeof item?.alt !== "string")
              return [];
            return [
              {
                url: `/api/blob/${encodeURIComponent(post.did)}/${encodeURIComponent(cid)}`,
                alt: item.alt,
                ...(item.contentWarning === true
                  ? { contentWarning: true }
                  : {}),
                ...(item.aspectRatio ? { aspectRatio: item.aspectRatio } : {}),
              },
            ];
          })
        : undefined;
    const linkCards =
      !deleted && Array.isArray((post.recordJson as any)?.linkCards)
        ? (post.recordJson as any).linkCards.flatMap((card: any) => {
            if (
              typeof card?.uri !== "string" ||
              typeof card?.title !== "string"
            )
              return [];
            const cid = card.thumb?.ref?.$link;
            return [
              {
                uri: card.uri,
                title: card.title,
                ...(typeof card.description === "string"
                  ? { description: card.description }
                  : {}),
                ...(typeof cid === "string"
                  ? {
                      thumb: `/api/blob/${encodeURIComponent(post.did)}/${encodeURIComponent(cid)}`,
                    }
                  : {}),
              },
            ];
          })
        : undefined;
    return {
      uri: post.uri,
      cid: post.cid,
      author: {
        did: post.did,
        handle: actor?.handle ?? post.did,
        displayName: profile?.displayName ?? undefined,
        description: profile?.description ?? undefined,
        avatar: profile?.avatarCid
          ? `/api/blob/${encodeURIComponent(post.did)}/${profile.avatarCid}`
          : undefined,
        isBot: post.did === config.botDid,
        superPositiveLevel: levels.get(post.did),
        currentTitle: titles.get(post.did),
      },
      text: deleted ? "" : post.text,
      facets: (post.facets as PostView["facets"]) ?? undefined,
      ...(contentWarning.status === "valid"
        ? { contentWarning: contentWarning.range }
        : {}),
      langs: (post.langs as string[] | null) ?? undefined,
      selfLabels: post.selfLabels.length ? post.selfLabels : undefined,
      moderationLabels: post.moderationLabels.length
        ? post.moderationLabels
        : undefined,
      createdAt: post.recordCreatedAt.toISOString(),
      indexedAt: post.indexedAt.toISOString(),
      edited: post.edited || undefined,
      reply: post.replyParentUri
        ? {
            root: {
              uri: post.replyRootUri ?? post.replyParentUri,
              cid:
                recordReply?.root?.cid ??
                threadRoot?.cid ??
                recordReply?.parent?.cid ??
                "",
            },
            parent: {
              uri: post.replyParentUri,
              cid: recordReply?.parent?.cid ?? "",
            },
          }
        : undefined,
      images: images?.length ? images : undefined,
      linkCards: linkCards?.length ? linkCards : undefined,
      reactions: reactions.get(post.uri) ?? [],
      isBot: post.did === config.botDid,
      isAffirmation: (score ?? -1) >= config.affirmationThreshold,
      ...(record?.cwRestricted === true ? { cwRestricted: true } : {}),
      kossori: post.kossori || undefined,
      threadKossori: threadKossori || undefined,
      channel: post.channelUri
        ? {
            uri: post.channelUri,
            cid:
              (post.recordJson as any)?.channel?.cid ??
              channelRefs.get(post.channelUri)?.cid ??
              "",
            ...(channelRefs.has(post.channelUri)
              ? { name: channelRefs.get(post.channelUri)!.name }
              : {}),
          }
        : undefined,
      deleted: deleted || undefined,
    };
  });
  if (quoteDepth >= 3) return views;
  const quoteUris = [
    ...new Set(
      rows.flatMap(({ post }) =>
        !post.deletedAt && post.quoteUri?.split("/")[3] === NAGI.post
          ? [post.quoteUri]
          : [],
      ),
    ),
  ];
  const newsRefs = rows.flatMap(({ post }) =>
    post.quoteUri?.split("/")[3] === NAGI.news && post.quoteCid
      ? [{ uri: post.quoteUri, cid: post.quoteCid }]
      : [],
  );
  const newsViews = await getNewsQuoteViews(newsRefs, mutes.actors);
  if (!quoteUris.length && !newsRefs.length) return views;
  // 引用元がミュート著者なら引用カードだけを落とす（引用している投稿自体は残す）。
  const quoteRows = quoteUris.length
    ? dropMutedRows(await fetchPostRows(quoteUris), mutes)
    : [];
  const quoteViews = quoteRows.length
    ? await hydratePostViews(quoteRows, viewerDid, quoteDepth + 1, mutes)
    : [];
  const quoteByUri = new Map(quoteViews.map((view) => [view.uri, view]));
  return views.map((view, index) => {
    const quoteUri = rows[index].post.quoteUri;
    const quote = quoteUri ? quoteByUri.get(quoteUri) : undefined;
    const post = rows[index].post;
    const quotedNews =
      post.quoteUri && post.quoteCid
        ? newsViews.get(`${post.quoteUri}|${post.quoteCid}`)
        : undefined;
    return {
      ...view,
      ...(quote ? { quote: { kind: "post" as const, post: quote } } : {}),
      ...(quotedNews
        ? { quote: { kind: "news" as const, news: quotedNews } }
        : {}),
    };
  });
}
type BotReplyJob = { state: string; replyUri: string | null };
/** 元投稿 uri → botたん返信ジョブ（state/replyUri）。返信の indexed 済み判定・待機表示に使う。 */
export async function fetchBotReplyJobs(
  sourceUris: string[],
): Promise<Map<string, BotReplyJob>> {
  if (!sourceUris.length) return new Map();
  const jobs = await db
    .select({
      sourceUri: nagiBotReplyJobs.sourceUri,
      state: nagiBotReplyJobs.state,
      replyUri: nagiBotReplyJobs.replyUri,
    })
    .from(nagiBotReplyJobs)
    .where(inArray(nagiBotReplyJobs.sourceUri, sourceUris));
  return new Map(
    jobs.map((j) => [j.sourceUri, { state: j.state, replyUri: j.replyUri }]),
  );
}
export async function buildFeedItems(
  rows: PostRow[],
  viewerDid?: string,
  groupBotReplies = true,
  includeReplyParents = false,
  mutes: MuteSet = EMPTY_MUTES,
): Promise<FeedItem[]> {
  const jobByUri =
    groupBotReplies && rows.length
      ? await fetchBotReplyJobs(rows.map((r) => r.post.uri))
      : new Map<string, BotReplyJob>();
  const replyUris = new Set<string>();
  const parentUris = new Set<string>();
  for (const row of rows) {
    const replyUri = jobByUri.get(row.post.uri)?.replyUri ?? row.botReplyUri;
    if (groupBotReplies && replyUri) replyUris.add(replyUri);
    if (includeReplyParents && row.post.replyParentUri)
      parentUris.add(row.post.replyParentUri);
  }
  // 返信先がミュート著者なら replyParent を付けない（bot返信は bot 宛なので影響しない）。
  const relatedRows = dropMutedRows(
    await fetchPostRows([...new Set([...replyUris, ...parentUris])]),
    mutes,
  );
  const views = await hydratePostViews(
    [...rows, ...relatedRows],
    viewerDid,
    0,
    mutes,
  );
  const viewByUri = new Map(views.map((v) => [v.uri, v]));
  return rows.map((row) => {
    let view = viewByUri.get(row.post.uri)! as FeedItem;
    const replyParent = row.post.replyParentUri
      ? viewByUri.get(row.post.replyParentUri)
      : undefined;
    if (replyParent) view = { ...view, replyParent };
    if (!groupBotReplies) return view;
    const job = jobByUri.get(row.post.uri);
    const replyUri = job?.replyUri ?? row.botReplyUri ?? undefined;
    const reply = replyUri ? viewByUri.get(replyUri) : undefined;
    if (reply && !reply.deleted)
      return { ...view, botReply: reply, botReplyState: "posted" };
    // A freshly posted reply can still be in Jetstream flight, so it remains
    // pending until the reply record is available to hydrate.
    // Absence of a job row never yields "pending" so old posts don't spin forever.
    if (job?.state === "failed") return { ...view, botReplyState: "failed" };
    if (job)
      return {
        ...view,
        botReplyState: job.state === "processing" ? "processing" : "pending",
      };
    return view;
  });
}
/** スレッドキー = coalesce(replyRootUri, uri)。代表述語と揃える。 */
const threadKeyOf = (post: {
  uri: string;
  replyRootUri: string | null;
}): string => post.replyRootUri ?? post.uri;

type TimelineOrderPost = {
  uri: string;
  did: string;
  replyRootUri: string | null;
  replyParentUri: string | null;
  indexedAt: Date;
};

/**
 * DBが返す代表行にも同じ順序規則を適用する安全網。botのトップレベル投稿は活動だが、
 * 自動返信はスレッドを押し上げない。同時刻はURI降順でカーソルと同じ順序へ固定する。
 */
export function orderThreadRepresentatives<
  T extends { post: TimelineOrderPost },
>(rows: T[], botDid = config.botDid): T[] {
  const latest = new Map<string, T>();
  const compare = (a: T, b: T) => {
    const time = a.post.indexedAt.getTime() - b.post.indexedAt.getTime();
    return time !== 0
      ? time
      : a.post.uri === b.post.uri
        ? 0
        : a.post.uri > b.post.uri
          ? 1
          : -1;
  };
  for (const row of rows) {
    if (row.post.did === botDid && row.post.replyParentUri) continue;
    const key = threadKeyOf(row.post);
    const current = latest.get(key);
    if (!current || compare(row, current) > 0) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => compare(b, a));
}

/**
 * プロフィールの filter は、group モードでは「表示候補の投稿」ではなく
 * 「どのスレッドをプロフィールに含めるか」を決める。代表はその後の最新活動から選ぶ。
 */
export function profileThreadMatch(
  actorDid: string,
  filter: "posts" | "replies" | "media" | undefined,
): SQL {
  const match =
    filter === "replies"
      ? sql`candidate.reply_parent_uri is not null`
      : filter === "media"
        ? sql`jsonb_array_length(coalesce(candidate.embed_images, '[]'::jsonb)) > 0`
        : sql`candidate.reply_parent_uri is null`;
  return sql`exists (
    select 1 from nagi.posts as candidate
    where coalesce(candidate.reply_root_uri, candidate.uri)
        = coalesce(${nagiPosts.replyRootUri}, ${nagiPosts.uri})
      and candidate.deleted_at is null
      and candidate.did = ${actorDid}
      and ${match}
  )`;
}
/**
 * 指定スレッド(ルートURI)群に属する非削除投稿を全部引く。bot返信も含む（バブルにするため）。
 * ミュート著者の投稿はここで落とすので、バブルからその発言だけが抜け、totalCount/hiddenCount も
 * 自動的に整合する。ルートがミュートならルート行自体が引けず、呼び出し側でスレッドごと落ちる。
 */
async function fetchThreadRows(
  threadKeys: string[],
  mutes: MuteSet,
): Promise<PostRow[]> {
  if (!threadKeys.length) return [];
  return db
    .select(postSelection)
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(
      and(
        isNull(nagiPosts.deletedAt),
        ...(mutes.actors.length
          ? [notInArray(nagiPosts.did, mutes.actors)]
          : []),
        or(
          inArray(nagiPosts.replyRootUri, threadKeys),
          inArray(nagiPosts.uri, threadKeys),
        ),
      ),
    );
}
/**
 * 代表投稿(各スレッドの最新の共有可視投稿)群を、会話グループ FeedItem に組み立てる。
 * ルート + 最新3バブル(bot返信含む・createdAt昇順)に畳み、hiddenCount/totalCount を付ける。
 * botたん返信がまだ indexed されていない代表には awaitingBotReply を載せる。
 */
export async function buildConversationItems(
  reps: PostRow[],
  viewerDid?: string,
  mutes: MuteSet = EMPTY_MUTES,
): Promise<FeedItem[]> {
  if (!reps.length) return [];
  const threadKeys = [...new Set(reps.map((r) => threadKeyOf(r.post)))];
  const threadRows = await fetchThreadRows(threadKeys, mutes);
  // スレッドキーごとに投稿を集める（createdAt昇順・uriタイブレークで安定ソート）。
  const byThread = new Map<string, PostRow[]>();
  for (const row of threadRows) {
    const key = threadKeyOf(row.post);
    const list = byThread.get(key) ?? [];
    if (!byThread.has(key)) byThread.set(key, list);
    list.push(row);
  }
  const cmp = (a: PostRow, b: PostRow) => {
    const t =
      a.post.recordCreatedAt.getTime() - b.post.recordCreatedAt.getTime();
    return t !== 0 ? t : a.post.uri < b.post.uri ? -1 : 1;
  };
  // ルートからの返信ホップ数(=depth)。中間が畳まれても正しい深さを出すため、スレッド全体で計算。
  const parentByUri = new Map(
    threadRows.map((r) => [r.post.uri, r.post.replyParentUri]),
  );
  const depthFrom = (rootUri: string, uri: string): number => {
    let d = 0;
    let cur: string | null | undefined = uri;
    const seen = new Set<string>();
    while (cur && cur !== rootUri && !seen.has(cur)) {
      seen.add(cur);
      cur = parentByUri.get(cur);
      d++;
      if (d > 64) break; // 壊れた/循環参照の保険
    }
    return d;
  };
  // 表示対象(root + 最新3バブル + 代表)だけをまとめて1回でハイドレート。
  const displayRows = new Map<string, PostRow>();
  const plan = new Map<
    string,
    { rootUri: string; bubbleUris: string[]; bubbleDepths: number[]; total: number }
  >();
  for (const key of threadKeys) {
    const list = (byThread.get(key) ?? []).slice().sort(cmp);
    const root = list.find((r) => r.post.uri === key);
    // ルート削除済み/ルート著者ミュートのスレッドはここで落ちる（＝会話ごと非表示）。
    // どちらも getTimeline の filters で SQL 段階から除外済みなので、ここは安全網。
    if (!root) continue;
    const nonRoot = list.filter((r) => r.post.uri !== key);
    const bubbles = nonRoot.slice(-3);
    plan.set(key, {
      rootUri: key,
      bubbleUris: bubbles.map((r) => r.post.uri),
      bubbleDepths: bubbles.map((r) => depthFrom(key, r.post.uri)),
      total: list.length,
    });
    for (const r of [root, ...bubbles]) displayRows.set(r.post.uri, r);
  }
  for (const rep of reps) displayRows.set(rep.post.uri, rep);
  const views = await hydratePostViews(
    [...displayRows.values()],
    viewerDid,
    0,
    mutes,
  );
  const viewByUri = new Map(views.map((v) => [v.uri, v]));
  const jobByUri = await fetchBotReplyJobs(reps.map((r) => r.post.uri));
  return reps.flatMap((rep) => {
    const key = threadKeyOf(rep.post);
    const p = plan.get(key);
    const root = viewByUri.get(key);
    if (!p || !root) return []; // ルート未解決なら共有TLに出さない（安全側）。
    const bubbles = p.bubbleUris.flatMap((uri, i) => {
      const post = viewByUri.get(uri);
      return post ? [{ post, depth: p.bubbleDepths[i] }] : [];
    });
    const hiddenCount = Math.max(0, p.total - 1 - bubbles.length);
    // botたん返信が既にスレッド投稿として存在するなら待機表示は出さない。
    const threadUris = new Set(
      (byThread.get(key) ?? []).map((r) => r.post.uri),
    );
    const job = jobByUri.get(rep.post.uri);
    const replyUri = job?.replyUri ?? rep.botReplyUri ?? undefined;
    const awaitingBotReply =
      replyUri && threadUris.has(replyUri)
        ? undefined
        : job?.state === "failed"
          ? ("failed" as const)
          : job
            ? job.state === "processing"
              ? ("processing" as const)
              : ("pending" as const)
            : undefined;
    const conversation: ConversationView = {
      threadRootUri: key,
      root,
      bubbles,
      hiddenCount,
      totalCount: p.total,
      ...(awaitingBotReply ? { awaitingBotReply } : {}),
    };
    const repView = (viewByUri.get(rep.post.uri) ?? root) as FeedItem;
    return [{ ...repView, conversation }];
  });
}

/**
 * 検索順位を変えず、ルート一致だけを会話表示へ広げる。途中返信の一致は返信タブと同じく
 * 返信元付きの単独カードにする。同じスレッドの複数投稿が一致した場合も検索結果として残す。
 */
export async function buildSearchFeedItems(
  rows: PostRow[],
  viewerDid?: string,
  mutes: MuteSet = EMPTY_MUTES,
): Promise<FeedItem[]> {
  if (!rows.length) return [];
  const roots = rows.filter((row) => !row.post.replyParentUri);
  const replies = rows.filter((row) => row.post.replyParentUri);
  const [rootItems, replyItems] = await Promise.all([
    buildConversationItems(roots, viewerDid, mutes),
    buildFeedItems(replies, viewerDid, true, true, mutes),
  ]);
  const byUri = new Map(
    [...rootItems, ...replyItems].map((item) => [item.uri, item]),
  );
  return restoreSearchResultOrder(rows, byUri);
}

/** 検索用の並びは会話のハイドレート順に影響されず、元のSQL順位をそのまま維持する。 */
export function restoreSearchResultOrder<T extends { uri: string }>(
  rows: Array<{ post: { uri: string } }>,
  byUri: ReadonlyMap<string, T>,
): T[] {
  return rows.flatMap((row) => {
    const item = byUri.get(row.post.uri);
    return item ? [item] : [];
  });
}
/**
 * getTimeline の可視性・絞り込み条件。**カーソル条件と並び順は含まない。**
 *
 * 全肯定フィードの「動的枠」（personalizedFeed.ts）が、時系列側とまったく同じ条件で
 * 候補を引くために切り出してある。こっそり・ミュート・成人向け・bot返信除外のどれか1つでも
 * ズレると、隠れているべき投稿が動的枠から漏れる。**条件をコピーして2箇所に持たないこと。**
 */
export function timelineVisibilityFilters(
  opts: TimelineFilterOptions,
  ctx: {
    mutes: MuteSet;
    muteActors: boolean;
    muteChannels: boolean;
    isAdult: boolean;
    homeActors?: string[];
  },
): any[] {
  const filters: any[] = [isNull(nagiPosts.deletedAt)];
  if (opts.actorDid) {
    if (opts.group)
      filters.push(profileThreadMatch(opts.actorDid, opts.filter));
    else filters.push(eq(nagiPosts.did, opts.actorDid));
  }
  if (opts.homeDid) {
    filters.push(...homeTimelineVisibility(opts.homeDid, ctx.homeActors!));
  }
  if (opts.channelUri) filters.push(eq(nagiPosts.channelUri, opts.channelUri));
  if (opts.tag)
    filters.push(sql`${nagiPosts.tags} @> ARRAY[${opts.tag}]::text[]`);
  if (opts.affirmation) {
    // スコアの閾値では絞らない。「その日いちばんスコアの高い1件」を選ぶ方式にしたので、
    // 閾値で母数を削ると、閾値に届かない日はその人の投稿が丸ごと消えるだけになる。
    // 候補は「botたんがスコアを付けた投稿」＝肯定された投稿。
    filters.push(isNotNull(nagiPostScores.score));
    // 1人1日1投稿。多投稿の人がTLを占有せず、その日の代表作だけが並ぶ。
    filters.push(dailyBestPerAuthor(opts.viewerDid, ctx.isAdult));
  }
  if (!opts.group || !opts.actorDid) {
    if (opts.filter === "posts") filters.push(isNull(nagiPosts.replyParentUri));
    if (opts.filter === "replies")
      filters.push(isNotNull(nagiPosts.replyParentUri));
    if (opts.filter === "media")
      filters.push(
        sql`jsonb_array_length(coalesce(${nagiPosts.embedImages}, '[]'::jsonb)) > 0`,
      );
  }
  // ミュート（投稿者・スレッドルート著者・所属CH）。条件の組み立ては検索と共通。
  filters.push(
    ...muteVisibility(ctx.mutes, {
      actors: ctx.muteActors,
      channels: ctx.muteChannels,
    }),
  );
  // group/共有TLでは bot返信を代表候補から外し、会話バブルとして元投稿にまとめる。
  // group でないプロフィール返信タブでは bot本人の返信も検索対象なので残す。
  if (opts.group || !opts.actorDid)
    filters.push(
      or(ne(nagiPosts.did, config.botDid), isNull(nagiPosts.replyParentUri)),
    );
  // こっそりは返信ごとではなくスレッドルートが所有する。
  // ルート未解決時に非共有へ倒すのは、壊れた参照によって
  // 本来こっそりだった返信を共有TLへ露出させないため。
  if (!opts.actorDid && !opts.channelUri && !opts.homeDid) {
    const viewerMatch = opts.viewerDid
      ? sql`${nagiPosts.did} = ${opts.viewerDid}`
      : sql`false`;
    const threadRootViewerMatch = opts.viewerDid
      ? sql`thread_root.did = ${opts.viewerDid}`
      : sql`false`;
    filters.push(sql`
      case
        when ${nagiPosts.replyRootUri} is null
          then (not ${nagiPosts.kossori} or ${viewerMatch})
        else coalesce((
          select (not thread_root.kossori or ${threadRootViewerMatch})
          from nagi.posts as thread_root
          where thread_root.uri = ${nagiPosts.replyRootUri}
            and thread_root.deleted_at is null
        ), false)
      end
    `);
    // 将来チャンネル投稿をグローバル/全肯定TLへ流さない方針に変える場合は、
    // ここに filters.push(isNull(nagiPosts.channelUri)); を1行足すだけでよい。
  } else if (!opts.homeDid) {
    filters.push(kossoriVisibility(opts.viewerDid));
  }
  // 会話グループ化: 同スレッドに自分より後の共有可視投稿(=非削除・非bot返信)が無い投稿=代表
  // だけを残す。これで1スレッド1回・最新活動順になる。cursor/orderBy はそのまま代表に効く。
  // kossori判定は上の case 式が担うので、ここでは重複して書かない。
  // ミュート著者の投稿は代表になれないので sib からも除く（1つ前へフォールバックさせる）。
  if (opts.group)
    filters.push(
      latestThreadActivity(ctx.mutes, ctx.muteActors, ctx.homeActors),
    );
  // 未成年には成人向け・判定待ちを SQL 段階で落とす。hydrate 側でも落とすが、
  // ページングの件数がずれないようにここで先に外す。
  filters.push(...adultContentVisibility(ctx.isAdult));
  return filters;
}

/** timelineVisibilityFilters が見る範囲だけを切り出した getTimeline の引数。 */
export type TimelineFilterOptions = {
  viewerDid?: string;
  affirmation?: boolean;
  actorDid?: string;
  channelUri?: string;
  tag?: string;
  filter?: "posts" | "replies" | "media";
  group?: boolean;
  homeDid?: string;
};

export async function getTimeline(opts: {
  limit: number;
  cursor?: string;
  viewerDid?: string;
  affirmation?: boolean;
  actorDid?: string;
  /** CH タイムライン: この URI の channel を持つ投稿だけを、kossori に関係なく出す。 */
  channelUri?: string;
  /** タグ検索(/search): この小文字タグを含む投稿だけを出す。呼び出し側で小文字化済みであること。 */
  tag?: string;
  filter?: "posts" | "replies" | "media";
  /**
   * 会話グループ化。各スレッドの最新の可視な人間投稿だけを代表として1回だけ返し、
   * buildConversationItems で会話ブロックに畳む。プロフィールの filter は対象スレッド判定に使う。
   */
  group?: boolean;
  /** 検索結果: 順位は維持し、ルート一致だけを会話表示へ広げる。 */
  searchResults?: boolean;
  /**
   * 本人向けホーム。指定時は本人・botたん・本人の非公開リストの投稿（返信を含む）を候補にし、
   * スレッド単位の最新活動順に並べる。公開範囲はスレッドルートで判定するので、本人の kossori
   * だけは表示する。
   */
  homeDid?: string;
  /** 呼び出し側が既に引いている場合に渡す。省略時は viewerDid から自分で引く。 */
  mutes?: MuteSet;
}) {
  const mutes = opts.mutes ?? (await loadMutes(opts.viewerDid));
  const homeActors = opts.homeDid
    ? [
        opts.homeDid,
        config.botDid,
        ...(await loadPrivateListMemberDids(opts.homeDid)),
      ]
    : undefined;
  // ミュートの適用範囲: プロフィールフィード(actorDid)は「自分で開いた」ので一切適用しない。
  // CH TL(channelUri)も同じ理由で CH ミュートは適用しないが、ユーザーミュートは効かせる。
  const muteActors = !opts.actorDid && mutes.actors.length > 0;
  const muteChannels =
    !opts.actorDid && !opts.channelUri && mutes.channels.length > 0;
  // ハイドレート側(バブル・引用・返信元)へ渡す実効ミュート。適用外の経路では空になるので、
  // プロフィールフィードでは SQL だけでなく後段の絞り込みも一切効かない。
  const appliedMutes: MuteSet = {
    actors: muteActors ? mutes.actors : [],
    channels: muteChannels ? mutes.channels : [],
  };
  const point = decodeCursor(opts.cursor);
  const filters = timelineVisibilityFilters(opts, {
    mutes,
    muteActors,
    muteChannels,
    isAdult: await viewerIsAdult(opts.viewerDid),
    homeActors,
  });
  if (point)
    filters.push(
      or(
        lt(nagiPosts.indexedAt, point[0]),
        and(eq(nagiPosts.indexedAt, point[0]), lt(nagiPosts.uri, point[1])),
      ),
    );
  const rows = await db
    .select(postSelection)
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(and(...filters))
    .orderBy(desc(nagiPosts.indexedAt), desc(nagiPosts.uri))
    .limit(opts.limit + 1);
  const selectedPage = rows.slice(0, opts.limit);
  const page = opts.group
    ? orderThreadRepresentatives(selectedPage)
    : selectedPage;
  const [items, botActor] = await Promise.all([
    opts.group
      ? buildConversationItems(page, opts.viewerDid, appliedMutes)
      : opts.searchResults
        ? buildSearchFeedItems(page, opts.viewerDid, appliedMutes)
        : buildFeedItems(
            page,
            opts.viewerDid,
            true,
            opts.filter === "replies" || Boolean(opts.channelUri),
            appliedMutes,
          ),
    getBotActor(),
  ]);
  const last = page.at(-1)?.post;
  return {
    items,
    botActor,
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(last.indexedAt, last.uri)
        : undefined,
    hasMore: rows.length > opts.limit,
  };
}

/**
 * 全肯定TLの代表選出。**1人1日1投稿**にし、その日いちばんスコアの高いものを残す。
 *
 * 並び順は時系列のままなので、`latestThreadActivity` と同じ「自分より良い兄弟が居なければ
 * 代表」という NOT EXISTS で書く。ページをまたいでも代表が変わらないため、
 * keyset ページング（indexed_at, uri）をそのまま使える。
 *
 * 「日」は **indexed_at の JST 日付**で切る。record_created_at はレコード側の申告値なので、
 * 日付を散らせば1日1投稿の制限をすり抜けられてしまう。
 *
 * 兄弟の条件は本体のフィルタと揃える必要がある。**見えない投稿に代表を取らせると、
 * その日のその人の投稿が丸ごと消える**（穴があく）ため:
 * - こっそりはスレッドルートが所有するので、本体と同じ case 式で判定する
 * - 未成年ビューアに隠す投稿も代表になれない
 * - 削除済み・botの返信はそもそも全肯定TLに出ないので争わせない
 *
 * スコアの閾値は見ない（本体でも見ていない）。post_scores との join があるので、
 * 候補は自動的に「botたんがスコアを付けた投稿」に限られる。
 *
 * ミュートは考慮しない。著者ごと消えるので、その人の投稿は1件も出ず穴にならない。
 */
export function dailyBestPerAuthor(viewerDid: string | undefined, isAdult: boolean): SQL {
  const viewerMatch = viewerDid ? sql`best.did = ${viewerDid}` : sql`false`;
  const rootViewerMatch = viewerDid
    ? sql`best_root.did = ${viewerDid}`
    : sql`false`;
  const adultFilter = isAdult
    ? sql``
    : sql`
          and best.moderation_version is not null
          and not (best.moderation_labels && ${ADULT_LABELS_ARRAY})
          and not (best.self_labels && ${ADULT_LABELS_ARRAY})`;
  return sql`
      not exists (
        select 1
          from nagi.posts as best
          join nagi.post_scores as best_score on best_score.post_uri = best.uri
         where best.did = ${nagiPosts.did}
           and best.deleted_at is null
           and (best.did <> ${config.botDid} or best.reply_parent_uri is null)
           and (best.indexed_at at time zone 'Asia/Tokyo')::date
             = (${nagiPosts.indexedAt} at time zone 'Asia/Tokyo')::date
           and case
                 when best.reply_root_uri is null
                   then (not best.kossori or ${viewerMatch})
                 else coalesce((
                   select (not best_root.kossori or ${rootViewerMatch})
                     from nagi.posts as best_root
                    where best_root.uri = best.reply_root_uri
                      and best_root.deleted_at is null
                 ), false)
               end${adultFilter}
           and (
             best_score.score > ${nagiPostScores.score}
             or (best_score.score = ${nagiPostScores.score}
                 and best.indexed_at > ${nagiPosts.indexedAt})
             or (best_score.score = ${nagiPostScores.score}
                 and best.indexed_at = ${nagiPosts.indexedAt}
                 and best.uri > ${nagiPosts.uri})
           )
      )
    `;
}

/** getTimeline の代表選出SQL。純粋なSQL断片として順序仕様の回帰テストにも使う。 */
export function latestThreadActivity(
  mutes: MuteSet,
  muteActors: boolean,
  homeActors?: string[],
): SQL {
  const sibMuteFilter = sibNotMuted(mutes, muteActors);
  const homeSibling = homeSiblingFilter(homeActors);
  return sql`
      not exists (
        select 1 from nagi.posts as sib
        where coalesce(sib.reply_root_uri, sib.uri)
            = coalesce(${nagiPosts.replyRootUri}, ${nagiPosts.uri})
          and sib.deleted_at is null
          and (sib.did <> ${config.botDid} or sib.reply_parent_uri is null)${sibMuteFilter}
          ${homeSibling}
          and (
            sib.indexed_at > ${nagiPosts.indexedAt}
            or (sib.indexed_at = ${nagiPosts.indexedAt} and sib.uri > ${nagiPosts.uri})
          )
      )
    `;
}

export async function getBotActor(): Promise<FeedItem["author"]> {
  const [actor, profile] = await Promise.all([
    db
      .select()
      .from(nagiActors)
      .where(eq(nagiActors.did, config.botDid))
      .limit(1),
    db
      .select()
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, config.botDid))
      .limit(1),
  ]);
  return {
    did: config.botDid,
    handle: actor[0]?.handle ?? config.botDid,
    displayName: profile[0]?.displayName ?? "Botたん",
    avatar: profile[0]?.avatarCid
      ? `/api/blob/${encodeURIComponent(config.botDid)}/${profile[0].avatarCid}`
      : undefined,
    isBot: true,
  };
}
