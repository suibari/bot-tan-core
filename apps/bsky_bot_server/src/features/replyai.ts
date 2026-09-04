import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { getImageUrl, getLangStr, uniteDidNsidRkey } from "../bsky/util.js";
import { getBotContext } from "../util/botContext.js";
import { generateAffirmativeWord } from "@bsky-affirmative-bot/bot-brain";
import {
    Embed,
    GeminiScore,
    SUPER_POSITIVE_SCORE_THRESHOLD,
    botDayRange,
    isInBotDayRange,
} from "@bsky-affirmative-bot/shared-configs";
import { MemoryService, awardSuperPositiveLevel, loadPreferredName } from "@bsky-affirmative-bot/clients";
import { postContinuous } from "../bsky/postContinuous.js";
import { checkAndSendRoomInvitation } from "../bsky/roomInvitation.js";
import { getConcatProfiles } from "../bsky/getConcatProfiles.js";
import { parseEmbedPost } from "../bsky/parseEmbedPost.js";
import { followerMap } from "../bsky/followerManagement.js";
import { replyRandom } from "./replyrandom.js";
import {
    buildMemoryContext,
    type BotMemorySearchResult,
} from "@bsky-affirmative-bot/database";


export async function replyAI(
    follower: ProfileView,
    event: CommitCreateEvent<"app.bsky.feed.post">,
    isSubscriber?: boolean,
) {
    const record = event.commit.record as Record;
    const uri = uniteDidNsidRkey(follower.did, event.commit.collection, event.commit.rkey);
    const cid = event.commit.cid;
    const langStr = getLangStr(record.langs);

    let result: GeminiScore | undefined;
    const text_user = record.text;

    const { relatedPosts, friendMemory, researchMemory, notableMemory } =
        await loadReplyMemories(text_user, follower.did);
    const image = await getImageUrl(follower.did, record.embed);

    // 引用ポスト・リンク解析
    let embed: Embed | undefined = undefined;
    const embed_tmp = await parseEmbedPost(record);
    if (embed_tmp) {
        if (embed_tmp.profile_embed) {
            // 引用ポストの場合、フォロワーに含まれるかbot自身の投稿ならセット
            if (
                (embed_tmp.profile_embed?.did && followerMap.has(embed_tmp.profile_embed.did)) ||
                process.env.BSKY_DID === embed_tmp.profile_embed?.did // botの投稿を引用でも反応する
            ) {
                embed = embed_tmp;
                if (embed.image_embed) {
                    image.push(...embed.image_embed);
                }
            }
        } else if (embed_tmp.uri_embed) {
            // 外部リンクカードの場合、そのままセット
            embed = embed_tmp;
        }
    }

    // ポストテキストからURLを抽出（リンクカードがない場合）
    if (!embed?.uri_embed) {
        let textLinkUri: string | undefined;

        // facetsからリンクを抽出
        if (record.facets) {
            for (const facet of record.facets) {
                if (facet.features) {
                    for (const feature of facet.features) {
                        if (feature.$type === 'app.bsky.richtext.facet#link' && typeof (feature as any).uri === 'string') {
                            textLinkUri = (feature as any).uri;
                            break;
                        }
                    }
                }
                if (textLinkUri) break;
            }
        }

        if (textLinkUri) {
            if (!embed) embed = {};
            embed.uri_embed = textLinkUri;
        }
    }

    if (process.env.NODE_ENV === "development") {
        console.log("[DEBUG] user>>> " + text_user);
        console.log("[DEBUG] image: " + image?.map(img => img.image_url).join(", "));
        console.log("[DEBUG] lang: " + langStr);
        console.log(`[DEBUG] embed: ${embed?.text_embed}`)
    }

    try {
        // いいねへの言及は購読者向けのAI返信だけに限定する。
        const likeData = isSubscriber
            ? await MemoryService.getLike(follower.did)
            : undefined;
        const likedPost = likeData?.liked_post;

        if (likedPost) {
            MemoryService.deleteLike(follower.did);
        }

        // 共通の趣味を持つフォロワーのポストを取得
        let followersFriend: { profile: ProfileView; post: string; uri: string } | undefined = undefined;
        followersFriend = await getFollowersFriend(friendMemory);

        // Nagi で本人が申告した呼び名があれば、Bluesky 側の返信でも同じ呼び方をする。
        // 参照だけで、Bluesky から呼び方を変える経路は用意していない（Bsky bot は撤退方針）。
        const preferredName = await loadPreferredName(follower.did);

        // Gemini生成
        result = await generateAffirmativeWord({
            follower,
            preferredName,
            langStr,
            posts: [text_user, ...relatedPosts],
            likedByFollower: likedPost,
            image,
            followersFriend: followersFriend ? [followersFriend] : undefined,
            embed,
            isSubscriber,
            botContext: await getBotContext(),
            researchMemory,
            notableMemory,
        });

        // お気に入りポスト登録
        // dbPosts.insertDb(follower.did);
        // const prevScore = await dbPosts.selectDb(follower.did, "score") as number || 0;

        const candidateRecordedAt = new Date();
        const candidateDay = botDayRange(candidateRecordedAt);
        const prevPost = await MemoryService.getPost(follower.did);
        const prevRecordedAt = prevPost?.created_at instanceof Date
            ? prevPost.created_at
            : new Date(prevPost?.created_at);
        const prevScore = Number.isFinite(prevRecordedAt.getTime())
            && isInBotDayRange(prevRecordedAt, candidateDay)
            ? prevPost?.score || 0
            : 0;

        if (result && result.score && prevScore < result.score && text_user.length > 0) { // 空ポスト除外
            await MemoryService.upsertPost({
                did: follower.did,
                post: record.text,
                comment: result.comment,
                score: result.score,
                uri: uri,
                created_at: candidateRecordedAt,
            });
        }

        // 超ポジティブバッジ適用判定（Nagi側と共通のカウンタを加算する）
        let isNewMaxPositivityLevel = false;
        if (result && result.score && result.score >= SUPER_POSITIVE_SCORE_THRESHOLD) {
            try {
                console.log(`[INFO][BADGE] User ${follower.did} achieved score ${result.score}!`);
                const { reachedMax } = await awardSuperPositiveLevel(follower.did);
                isNewMaxPositivityLevel = reachedMax;
            } catch (badgeErr: any) {
                console.error(`[ERROR][BADGE] Failed to apply positivity level badge for ${follower.did}:`, badgeErr.message);
            }
        }

        // ポスト
        const text_bot = result?.comment || "";
        await postContinuous(text_bot, { uri, cid, record }, undefined);

        // Lv. MAX 到達時の祝福リプライ
        if (isNewMaxPositivityLevel) {
            const displayName = follower.displayName || follower.handle;
            const maxText = langStr === "日本語"
                ? `${displayName}ちゃん、超ポジティブ Lv. MAXに到達したよ！🎉\n心からおめでとう！これからもよろしくね💖`
                : `Dear ${displayName}, you've reached Super-Positive Lv. MAX! 🎉\nCongratulations from the bottom of my heart! Let's keep going together💖`;
            await postContinuous(maxText, { uri, cid, record }, undefined);
        }

        // AIリプライ送信完了後、お部屋お誘い条件の判定と処理を非同期（バックグラウンド）で実行
        checkAndSendRoomInvitation(uri, cid, record).catch(err => {
            console.error(`[ERROR][ROOM_INVITE] checkAndSendRoomInvitation failed:`, err);
        });

        return result;
    } catch (e: any) {
        if (e.message === "HighMatchNum") {
            console.log(`[INFO][${follower.did}] Switched to replyRandom due to HighMatchNum (>= 10)`);
            await replyRandom(follower, event);
            return null;
        } else {
            console.warn(`[WARN][${follower.did}] replyAI failed, throwing to upper handler. Error:`, e.message);
            throw e;
        }
    }
}
export async function loadReplyMemories(text: string, authorDid: string) {
    if (!text.trim())
        return {
            relatedPosts: [], friendMemory: undefined, researchMemory: null,
            notableMemory: null,
        };
    // 本人の記憶は「フィルタ」ではなく「係数」で効かせる。その人との記憶が無くても
    // 全体の記憶は残るので、初対面でも思い出の引き出しが空にならない。
    // web_research は related の枠を食わないよう buildMemoryContext が別枠で返す。
    // bot_memory_documents は Nagi と共通なので、Nagi 側で覚えた語もここで使える。
    const context = await buildMemoryContext({
        query: text,
        purpose: "reply_history",
        subjectKey: authorDid,
        limit: 10,
        researchLimit: 3,
        // 短期記憶は botContext 側（formatBotContext）が常時載せるので、ここでは引かない。
        digestDays: 0,
        excludeAuthorIds: [process.env.BSKY_DID, process.env.NAGI_BOT_DID],
    }).catch((error) => {
        console.warn(`[WARN][${authorDid}] Failed to build memory context:`, error);
        return undefined;
    });
    if (!context)
        return {
            relatedPosts: [], friendMemory: undefined, researchMemory: null,
            notableMemory: null,
        };
    return {
        // 本人の記憶だけ。ここは「その人自身の過去の投稿」として扱われるスロットなので、
        // 係数で畳んだ related を入れると他人の発言を本人のものにしてしまう。
        relatedPosts: context.own.map((row) => row.content),
        friendMemory: context.friend,
        researchMemory: context.research.map((row) => row.content).join("\n\n") || null,
        // 触れてよいかは検索側（selectNotableMemory）が既に判断済み。
        notableMemory: context.notable
            ? { content: context.notable.content, occurredAt: context.notable.occurredAt }
            : null,
    };
}

async function getFollowersFriend(memory: BotMemorySearchResult | undefined) {
    if (!memory?.authorId || !memory.sourceUri) return undefined;
    const friendsProfiles = await getConcatProfiles({
        actors: [memory.authorId],
    });
    if (!friendsProfiles || friendsProfiles.length === 0) return undefined;

    const firstProfile = friendsProfiles[0] as ProfileView;
    return firstProfile && memory.content
        ? { profile: firstProfile, post: memory.content, uri: memory.sourceUri }
        : undefined;
}
