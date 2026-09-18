import {
  db,
  nagiActors,
  nagiCardGets,
  nagiEmojis,
  nagiNotifications,
  nagiProfiles,
  nagiReactions,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  getThemeDef,
  resolveCardDef,
} from "@bsky-affirmative-bot/shared-configs";
import {
  NAGI,
  type CardView,
  type NotificationCardSubject,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { emojiView } from "../services/emoji.js";
import { fetchPostRows, hydratePostViews } from "./timeline.js";
import { diaryView, fetchDiaryRows } from "./diaries.js";
import { loadMutes } from "./mutes.js";

/**
 * ミュート相手からの通知を除く条件。行は残すので、ミュートを解除すれば過去分も復活する。
 * 未読数(getUnreadCount)と必ず同じ条件を使うこと。片方だけだとバッジと一覧が食い違う。
 */
const muteFilter = (mutedActors: string[]) =>
  mutedActors.length
    ? [notInArray(nagiNotifications.actorDid, mutedActors)]
    : [];

/** 規格外・削除済み Bluemoji の既存リアクション通知は存在しないものとして扱う。 */
const validReactionNotification = sql`
  (${nagiNotifications.type} <> 'reaction' or exists (
    select 1
    from nagi.reactions reaction
    left join nagi.emojis emoji on emoji.uri = reaction.emoji_uri
    where reaction.uri = ${nagiNotifications.reasonUri}
      and (reaction.emoji_uri is null or emoji.uri is not null)
  ))
`;

/**
 * その通知がポストを指しているか。日記(diary)と名刺更新(analysis)の subjectUri は
 * ポストの URI ではないので、引き当ての対象からも返り値からも外す。
 */
const hasPost = (type: (typeof nagiNotifications.$inferSelect)["type"]) =>
  type !== "diary" && type !== "analysis";

export async function getNotifications(did: string, limit: number) {
  const mutes = await loadMutes(did);
  const rows = await db
    .select({
      notification: nagiNotifications,
      actor: nagiActors,
      profile: nagiProfiles,
    })
    .from(nagiNotifications)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNotifications.actorDid))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNotifications.actorDid))
    // JS 側で後から filter すると1ページの件数が減るので、必ず SQL で落とす。
    .where(
      and(
        eq(nagiNotifications.recipientDid, did),
        validReactionNotification,
        ...muteFilter(mutes.actors),
      ),
    )
    .orderBy(desc(nagiNotifications.createdAt))
    .limit(limit);
  const postRows = await fetchPostRows([
    ...new Set(
      rows.flatMap(({ notification }) =>
        // 日記と分析はポストではないので post の引き直し対象から外す。
        hasPost(notification.type)
          ? [
              notification.type === "reply"
                ? notification.reasonUri
                : notification.subjectUri,
            ]
          : [],
      ),
    ),
  ]);
  const diaryRows = await fetchDiaryRows([
    ...new Set(
      rows.flatMap(({ notification }) =>
        notification.type === "diary" ? [notification.subjectUri] : [],
      ),
    ),
  ]);
  // 日記の通知先は日記の subject 本人なので実質いつも読めるが、経路を分けずに同じ判定を通す。
  const diaryByUri = new Map(
    diaryRows.flatMap((row) => {
      const view = diaryView(row, did);
      return view ? [[row.uri, view] as const] : [];
    }),
  );
  // ゼンカツの提出とドローの控えは投稿ではないので、post には入らない。
  // ここを足さないと「リアクションされた」とだけ出て、何にされたのか分からなくなる。
  const cardSubjectByUri = await fetchCardSubjects([
    ...new Set(
      rows.flatMap(({ notification }) => {
        const collection = notification.subjectUri.split("/")[3];
        return collection === NAGI.zenkatsu || collection === NAGI.cardGet
          ? [notification.subjectUri]
          : [];
      }),
    ),
  ]);
  const posts = await hydratePostViews(postRows, did);
  const postByUri = new Map(posts.map((post) => [post.uri, post]));
  // リアクション通知の reasonUri はリアクションレコードの URI。押された絵文字は
  // そこにしか無いので引き直す。
  const reactionUris = [
    ...new Set(
      rows.flatMap(({ notification }) =>
        notification.type === "reaction" ? [notification.reasonUri] : [],
      ),
    ),
  ];
  const reactionRows = reactionUris.length
    ? await db
        .select({
          uri: nagiReactions.uri,
          emoji: nagiReactions.emoji,
          emojiUri: nagiReactions.emojiUri,
          emojiItem: nagiEmojis,
        })
        .from(nagiReactions)
        .leftJoin(nagiEmojis, eq(nagiEmojis.uri, nagiReactions.emojiUri))
        .where(inArray(nagiReactions.uri, reactionUris))
    : [];
  const reactionByUri = new Map(
    reactionRows.flatMap((r) => {
      const bluemoji = r.emojiItem ? emojiView(r.emojiItem) : null;
      if (r.emojiUri && !bluemoji) return [];
      return [
        [r.uri, { emoji: r.emoji, ...(bluemoji ? { bluemoji } : {}) }] as const,
      ];
    }),
  );
  return {
    items: rows.map(({ notification: n, actor, profile }) => ({
      ...n,
      actor: {
        did: n.actorDid,
        handle: actor?.handle ?? n.actorDid,
        displayName: profile?.displayName ?? undefined,
        avatar: profile?.avatarCid
          ? `/api/blob/${encodeURIComponent(n.actorDid)}/${profile.avatarCid}`
          : undefined,
      },
      post: hasPost(n.type)
        ? postByUri.get(n.type === "reply" ? n.reasonUri : n.subjectUri)
        : undefined,
      diary: n.type === "diary" ? diaryByUri.get(n.subjectUri) : undefined,
      reaction:
        n.type === "reaction" ? reactionByUri.get(n.reasonUri) : undefined,
      cardSubject: cardSubjectByUri.get(n.subjectUri),
    })),
    hasMore: rows.length === limit,
  };
}
export async function getUnreadCount(did: string) {
  const mutes = await loadMutes(did);
  const [row] = await db
    .select({ value: count() })
    .from(nagiNotifications)
    .where(
      and(
        eq(nagiNotifications.recipientDid, did),
        isNull(nagiNotifications.readAt),
        validReactionNotification,
        ...muteFilter(mutes.actors),
      ),
    );
  return { count: row?.value ?? 0 };
}
export async function updateSeen(did: string, seenAt: Date) {
  const result = await db
    .update(nagiNotifications)
    .set({ readAt: seenAt })
    // created_at はマイクロ秒精度で入るが、API 経由の seenAt は JS Date でミリ秒に
    // 切り捨てられる。同精度で比較しないと最新の1件が取りこぼされ未読のまま残るため、
    // 比較時に created_at をミリ秒へ丸める。
    .where(
      and(
        eq(nagiNotifications.recipientDid, did),
        sql`date_trunc('milliseconds', ${nagiNotifications.createdAt}) <= ${seenAt.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: nagiNotifications.id });
  return { updated: result.length };
}

/**
 * 通知が指しているゼンカツ／カードの対象を引く。
 *
 * どちらもユーザー自身の repo にあるレコードなので、宛先の特殊扱いは要らない
 * （botたん の repo に置いていたら、持ち主＝botたん になってしまうところだった）。
 */
async function fetchCardSubjects(
  uris: string[],
): Promise<Map<string, NotificationCardSubject>> {
  if (!uris.length) return new Map();
  const zenkatsuUris = uris.filter((u) => u.split("/")[3] === NAGI.zenkatsu);
  const cardGetUris = uris.filter((u) => u.split("/")[3] === NAGI.cardGet);

  const [submissions, submissionCards, gets] = await Promise.all([
    zenkatsuUris.length
      ? db
          .select()
          .from(nagiZenkatsuSubmissions)
          .where(inArray(nagiZenkatsuSubmissions.uri, zenkatsuUris))
      : Promise.resolve([]),
    zenkatsuUris.length
      ? db
          .select()
          .from(nagiZenkatsuCards)
          .where(inArray(nagiZenkatsuCards.submissionUri, zenkatsuUris))
          .orderBy(asc(nagiZenkatsuCards.position))
      : Promise.resolve([]),
    cardGetUris.length
      ? db.select().from(nagiCardGets).where(inArray(nagiCardGets.uri, cardGetUris))
      : Promise.resolve([]),
  ]);

  const byUri = new Map<string, NotificationCardSubject>();
  const cardsBySubmission = new Map<string, CardView[]>();
  for (const row of submissionCards) {
    const def = resolveCardDef(row.cardVolume, row.cardNumber);
    if (!def) continue;
    const list = cardsBySubmission.get(row.submissionUri) ?? [];
    list.push({ ...def, owned: true });
    cardsBySubmission.set(row.submissionUri, list);
  }
  for (const row of submissions) {
    if (row.deletedAt) continue;
    const theme = getThemeDef(row.themeVolume, row.themeNumber);
    byUri.set(row.uri, {
      uri: row.uri,
      type: "zenkatsu",
      ...(theme ? { themeJa: theme.textJa, themeEn: theme.textEn } : {}),
      cards: cardsBySubmission.get(row.uri) ?? [],
    });
  }
  for (const row of gets) {
    if (row.deletedAt) continue;
    const def = resolveCardDef(row.cardVolume, row.cardNumber);
    if (!def) continue;
    byUri.set(row.uri, {
      uri: row.uri,
      type: "cardGet",
      cards: [{ ...def, owned: true }],
    });
  }
  return byUri;
}
