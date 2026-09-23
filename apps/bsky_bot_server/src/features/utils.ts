import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyFeedPost } from "@atproto/api";
type Record = AppBskyFeedPost.Record;
import { getImageUrl, uniteDidNsidRkey } from "../bsky/util.js";
import { postContinuous } from "../bsky/postContinuous.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import { GeminiResponseResult, UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { getBotContext } from "../util/botContext.js";

export type TriggeredReplyHandlerOptions = {
    dbColumn?: string;   // 更新対象DBのカラム名（例: "is_u18"）
    dbValue?: number | string | Date; // 登録時にセットする値（例: 1）
    generateText: GeminiResponseResult | ((userinfo: UserInfoGemini, event: CommitCreateEvent<"app.bsky.feed.post">) => Promise<GeminiResponseResult | undefined>); // 返信するテキスト(コールバック対応)
    disableReply?: boolean; // リプライの無効化
    /** 投稿API成功直後、後続の利用者DB更新より前に確定する処理。 */
    onPublished?: () => Promise<void>;
};

export const handleMode = async (
    event: CommitCreateEvent<"app.bsky.feed.post">,
    options: TriggeredReplyHandlerOptions,
    userinfo?: UserInfoGemini
): Promise<boolean> => {
    const did = String(event.did);
    const cid = String(event.commit.cid);
    const uri = uniteDidNsidRkey(did, event.commit.collection, event.commit.rkey);
    const record = event.commit.record as Record;

    // -----ここからmain処理-----
    // 非フォロワーはここで登録する(フォロワーならIGNOREされるはず)
    await MemoryService.ensureFollower(did);

    // 画像読み出し
    const image = await getImageUrl(did, record.embed);
    if (userinfo) {
        userinfo.image = image;
        userinfo.botContext = await getBotContext();
    }

    // ポスト&DB更新
    let result: GeminiResponseResult | undefined;
    if (typeof options.generateText === "function") {
        if (!userinfo) throw new Error("userinfo is required for responseText function.");
        result = await options.generateText(userinfo, event);
    } else {
        result = options.generateText;
    }

    if (result !== undefined) { // generateTextがundefinedを返すのはSPAM判定時のみ
        if (typeof result === "string") {
            if (options.disableReply) {
                await postContinuous(result);
            } else {
                await postContinuous(result, { uri, cid, record });
            }
        } else if (result.imageBlob) {
            // generateTextで画像を作ったときは、画像付きリプライ
            await postContinuous(result.text, { uri, cid, record }, { blob: result.imageBlob, alt: `Dear ${userinfo?.follower.displayName}, From 全肯定botたん` });
        } else if (result.embedTo) {
            // generateTextで引用ポストを拾ったときは、引用付きリプライ
            await postContinuous(result.text, { uri, cid, record }, undefined, result.embedTo);
        } else {
            await postContinuous(result.text, { uri, cid, record });
        }
        await options.onPublished?.();
    }

    // DB更新: 列、値が指定ある時だけ
    if (options.dbColumn && (options.dbValue !== undefined && options.dbValue !== null)) {
        await MemoryService.updateFollower(did, options.dbColumn, options.dbValue);
        console.log(`[INFO][${did}] exec mode: ${options.dbColumn}`);
    }

    return true;
};

/**
 * Checks if a certain amount of time has passed since the last action.
 * Supports both (event, col, mins) and legacy (event, db, col, mins) signatures.
 */
export async function isPast(
    event: CommitCreateEvent<"app.bsky.feed.post">,
    column: string,
    mins: number
) {
    const did = String(event.did);
    const msec_thrd = mins * 60 * 1000;
    const postedAt = new Date((event.commit.record as Record).createdAt);

    const follower = await MemoryService.getFollower(did);
    const lastAt = new Date(follower?.[column] || 0);

    return (postedAt.getTime() - lastAt.getTime() > msec_thrd);
}
