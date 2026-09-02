import {
  db,
  botAffirmations,
  botInteraction,
  botLikes,
  botPosts,
  botReplies,
  followers,
  nagiActors,
  nagiBookmarkFolders,
  nagiBookmarkPreferences,
  nagiBookmarks,
  nagiActorAnalyses,
  nagiAnalysisJobs,
  nagiCardCommentJobs,
  nagiCardDraws,
  nagiGuestCardDraws,
  nagiCardInstances,
  nagiChannels,
  nagiChannelSubscriptions,
  nagiCommunityAffirmations,
  nagiCommunityAffirmationDismissals,
  nagiDiaries,
  nagiBotReplyJobs,
  nagiEmojis,
  nagiEmojiFavorites,
  nagiFeedTabs,
  nagiDrafts,
  nagiLanguagePreferences,
  nagiModerationPreferences,
  nagiPreferredNames,
  nagiMutes,
  nagiNotifications,
  nagiNews,
  nagiNewsApprovals,
  nagiNewsReviewJobs,
  nagiPosts,
  nagiPostScores,
  nagiProcessedEvents,
  nagiProfiles,
  nagiPrivateListMembers,
  nagiPushSubscriptions,
  nagiReadPositions,
  nagiReactions,
  nagiTranslations,
} from "@bsky-affirmative-bot/database";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { eq, inArray, like, or } from "drizzle-orm";

const NAGI_BOT_SERVER_URL =
  process.env.NAGI_BOT_SERVER_URL || "http://localhost:3003";

/**
 * 日記は botたんのリポジトリにあるので、AppView からは消せない。
 * bot サーバーに依頼する。DB の行を消す前に呼ぶこと（rkey を行から引くため）。
 */
async function purgeDiaryRecords(did: string) {
  try {
    const response = await fetch(`${NAGI_BOT_SERVER_URL}/diaries/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // 失敗しても AppView 側の削除は続ける（表示上は消える）。取り残したレコードは
    // /diaries/purge を手で叩けば回収できる。
    console.error(
      `[ERROR][NAGI][DIARY] Failed to purge diary records for ${did}:`,
      error,
    );
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * botたん側（affirmative_bot スキーマ）に残る本人のデータ。Nagi の投稿は nagi スキーマ
 * だけで完結していないので、ここを消さないとプライバシーポリシーの「Nagi のサーバ上の
 * データはすべて消える」が嘘になる。
 *
 * followers / posts / likes / replies は did が主キー = 1人1行なので行ごと消す。
 * Bluesky の botたんとも共有している行だが、Bluesky 側は撤退方針であり、なにより本人が
 * 「全データを削除」を選んでいる以上、会話履歴や記念日を残す理由がない。
 *
 * interaction だけは did を NULL にするに留める。botたんの日次日記が件数の集計に使って
 * いて（clients/diaryUtils.ts）、did は参照していないため、行を消すと本人と無関係な
 * 統計まで壊れる。DID を外せば個人との紐付きは消える。
 *
 * ここで消さないもの（affirmative_bot スキーマに DID 付きで残る）:
 *
 * - subscribers … did ↔ discord_id の Discord 連携。status に discord_only があることが
 *   示すとおり、Nagi を使っていない人も持つ行で、Nagi の機能ではない。消すと「Nagi は
 *   やめるが Discord には残る」人の連携が黙って切れ、本人が頼んでいない副作用になる。
 * - room_events / gifts … 書き込み元は ChatVRM_bot-tan（botたんのお部屋）で、こちらも
 *   Nagi ではない。Nagi をやめてもお部屋には来る人がいる。
 *
 * この線引きはプライバシーポリシーの「削除されないもの」と、設定の削除画面
 * （deleteDataKeptNote）に明記してある。変えるときは3か所を揃えること。
 */
async function deleteBotSchemaData(tx: Tx, did: string) {
  await tx
    .update(botInteraction)
    .set({ did: null })
    .where(eq(botInteraction.did, did));
  await tx.delete(botAffirmations).where(eq(botAffirmations.did, did));
  await tx.delete(botReplies).where(eq(botReplies.did, did));
  await tx.delete(botPosts).where(eq(botPosts.did, did));
  await tx.delete(botLikes).where(eq(botLikes.did, did));
  await tx.delete(followers).where(eq(followers.did, did));
}

export async function deleteAccountData(did: string) {
  await purgeDiaryRecords(did);
  await db.transaction(async (tx) => {
    const postUri = `at://${did}/${NAGI.post}/%`;
    const reactionUri = `at://${did}/${NAGI.reaction}/%`;
    const channelUri = `at://${did}/${NAGI.channel}/%`;
    const newsUri = `at://${did}/${NAGI.news}/%`;
    const quotingSourceUris = (
      await tx
        .select({ uri: nagiPosts.uri })
        .from(nagiPosts)
        .where(like(nagiPosts.quoteUri, postUri))
    ).map((row) => row.uri);
    const diaryUris = (
      await tx
        .select({ uri: nagiDiaries.uri })
        .from(nagiDiaries)
        .where(eq(nagiDiaries.subjectDid, did))
    ).map((row) => row.uri);

    // ミュートは2方向消す。自分がしたミュートだけでなく、他人が自分/自分の CH に対して
    // 設定したミュート行も残さない（退会後に他人の DB 行として残り続けないようにする）。
    await tx
      .delete(nagiMutes)
      .where(
        or(
          eq(nagiMutes.muterDid, did),
          eq(nagiMutes.subject, did),
          like(nagiMutes.subject, channelUri),
        ),
      );
    // 非公開ホームリストも両方向を消し、退会した人との関係を他人側の行にも残さない。
    await tx
      .delete(nagiPrivateListMembers)
      .where(
        or(
          eq(nagiPrivateListMembers.ownerDid, did),
          eq(nagiPrivateListMembers.memberDid, did),
        ),
      );
    // 所有分はフォルダ削除の cascade で消す。対象URI側にも退会者のDIDを残さない。
    // 日記URIはbotたん所有なので、subjectDidから先に特定したURIも明示的に消す。
    await tx
      .delete(nagiBookmarks)
      .where(like(nagiBookmarks.subjectUri, `at://${did}/%`));
    if (diaryUris.length)
      await tx
        .delete(nagiBookmarks)
        .where(inArray(nagiBookmarks.subjectUri, diaryUris));
    await tx
      .delete(nagiBookmarkFolders)
      .where(eq(nagiBookmarkFolders.ownerDid, did));

    await tx
      .delete(nagiTranslations)
      .where(like(nagiTranslations.postUri, postUri));
    await tx
      .delete(nagiPostScores)
      .where(like(nagiPostScores.postUri, postUri));
    await tx
      .delete(nagiBotReplyJobs)
      .where(like(nagiBotReplyJobs.sourceUri, postUri));
    await tx
      .delete(nagiReactions)
      .where(like(nagiReactions.subjectUri, postUri));
    await tx
      .delete(nagiReactions)
      .where(like(nagiReactions.subjectUri, newsUri));
    await tx
      .delete(nagiBotReplyJobs)
      .where(eq(nagiBotReplyJobs.authorDid, did));
    await tx
      .delete(nagiNotifications)
      .where(
        or(
          eq(nagiNotifications.recipientDid, did),
          eq(nagiNotifications.actorDid, did),
          like(nagiNotifications.subjectUri, postUri),
          like(nagiNotifications.reasonUri, postUri),
          like(nagiNotifications.reasonUri, reactionUri),
        ),
      );
    await tx.delete(nagiReactions).where(eq(nagiReactions.did, did));
    await tx
      .delete(nagiCommunityAffirmations)
      .where(eq(nagiCommunityAffirmations.authorDid, did));
    if (quotingSourceUris.length)
      await tx
        .delete(nagiCommunityAffirmations)
        .where(inArray(nagiCommunityAffirmations.sourceUri, quotingSourceUris));
    // 本人所有 Bluemoji の複製は消すが、それを使った他ユーザーのリアクションは
    // そのユーザーのデータなので残す。表示時は emoji のフォールバック文字列を使う。
    await tx.delete(nagiEmojis).where(eq(nagiEmojis.did, did));
    await tx.delete(nagiDiaries).where(eq(nagiDiaries.subjectDid, did));
    await tx.delete(nagiNewsReviewJobs).where(eq(nagiNewsReviewJobs.did, did));
    await tx
      .delete(nagiNewsApprovals)
      .where(like(nagiNewsApprovals.newsUri, newsUri));
    await tx.delete(nagiNews).where(eq(nagiNews.did, did));
    await tx.delete(nagiPosts).where(eq(nagiPosts.did, did));
    await tx.delete(nagiAnalysisJobs).where(eq(nagiAnalysisJobs.did, did));
    await tx.delete(nagiActorAnalyses).where(eq(nagiActorAnalyses.did, did));
    // CH の購読はミュートと同じく2方向消す。自分の購読（どの CH を見ていたか＝興味の記録）
    // だけでなく、他人が自分の CH を購読している行も残さない。channel_uri に退会者の DID が
    // 入ったまま他人の行として残り続けるのを避ける。
    await tx
      .delete(nagiChannelSubscriptions)
      .where(
        or(
          eq(nagiChannelSubscriptions.ownerDid, did),
          like(nagiChannelSubscriptions.channelUri, channelUri),
        ),
      );
    // CH の行を消しても、他人の channelOnly 投稿が漏れることはない。可視性は投稿行の
    // channel_only が持っていて CH 行を参照しないため（queries/timeline.ts）。
    await tx.delete(nagiChannels).where(eq(nagiChannels.did, did));

    // カード。comment_jobs → draws → instances の順で、instance_id を引ける間に消す。
    // 交換機能は未実装なので owner_did = first_owner_did であり、owner で消せば
    // first_owner_did 側に DID が残ることもない。交換を入れるときはここを見直すこと。
    const cardInstanceIds = (
      await tx
        .select({ id: nagiCardInstances.id })
        .from(nagiCardInstances)
        .where(eq(nagiCardInstances.ownerDid, did))
    ).map((row) => row.id);
    if (cardInstanceIds.length > 0) {
      await tx
        .delete(nagiCardCommentJobs)
        .where(inArray(nagiCardCommentJobs.instanceId, cardInstanceIds));
    }
    await tx.delete(nagiCardDraws).where(eq(nagiCardDraws.did, did));
    await tx
      .delete(nagiGuestCardDraws)
      .where(eq(nagiGuestCardDraws.claimedByDid, did));
    await tx
      .delete(nagiCardInstances)
      .where(eq(nagiCardInstances.ownerDid, did));

    // プッシュ購読。端末を特定しうる唯一の行なので必ず消す。
    await tx
      .delete(nagiPushSubscriptions)
      .where(eq(nagiPushSubscriptions.recipientDid, did));

    // 端末間で同期していた設定。既読位置は閲覧履歴そのものなので必ず消す。
    await tx.delete(nagiReadPositions).where(eq(nagiReadPositions.did, did));
    await tx.delete(nagiEmojiFavorites).where(eq(nagiEmojiFavorites.did, did));
    await tx.delete(nagiFeedTabs).where(eq(nagiFeedTabs.did, did));
    await tx.delete(nagiDrafts).where(eq(nagiDrafts.ownerDid, did));
    await tx
      .delete(nagiCommunityAffirmationDismissals)
      .where(eq(nagiCommunityAffirmationDismissals.viewerDid, did));
    await tx
      .delete(nagiLanguagePreferences)
      .where(eq(nagiLanguagePreferences.did, did));
    await tx
      .delete(nagiModerationPreferences)
      .where(eq(nagiModerationPreferences.did, did));
    await tx
      .delete(nagiBookmarkPreferences)
      .where(eq(nagiBookmarkPreferences.did, did));
    // 呼んでほしい名前。本人が申告した情報なので必ず消す。
    await tx.delete(nagiPreferredNames).where(eq(nagiPreferredNames.did, did));

    // 重複排除ログ。id は `${did}:${time_us}:...` なので前方一致で引ける。
    await tx
      .delete(nagiProcessedEvents)
      .where(like(nagiProcessedEvents.id, `${did}:%`));

    await tx.delete(nagiProfiles).where(eq(nagiProfiles.did, did));
    await tx.delete(nagiActors).where(eq(nagiActors.did, did));

    await deleteBotSchemaData(tx, did);
  });

  return { success: true as const };
}
