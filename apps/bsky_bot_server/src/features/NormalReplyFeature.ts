import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { isMention, mentionsDid, getLangStr, hasNGWord } from "../bsky/util.js";
import { EXEC_PER_COUNTS } from "@bsky-affirmative-bot/shared-configs";
import { replyAI } from "./replyai.js";
import { replyRandom } from "./replyrandom.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import retry from 'async-retry';
import { shouldRememberAffirmedPost, tryUpsertBotMemoryDocument } from "@bsky-affirmative-bot/database";
import { uniteDidNsidRkey } from "../bsky/util.js";

const MINUTES_THRD_RESPONSE = 10 * 60 * 1000;

let globalNonSubPostCount = 0;

export class NormalReplyFeature implements BotFeature {
    name = "NormalReply";
    handlesOwnLogging = true;

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        const record = event.commit.record as any;
        // bot宛メンションを含むトップレベル投稿も通常の全肯定対象にする。
        // bot以外だけへのメンションには割り込まない。
        return !record.reply && (
            !isMention(record) ||
            (Boolean(process.env.BSKY_DID) && mentionsDid(record, process.env.BSKY_DID!))
        );
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const record = event.commit.record as any;
        const did = follower.did;
        const isSubscriber = context.isSubscriber;
        const row = await MemoryService.getFollower(did);

        let replyType: "ai" | "random" | null = null;

        // 1. 確率判定 (Frequency check) - 全ユーザー共通
        const user_freq = row?.reply_freq;
        const isValidFreq = this.isJudgeByFreq(user_freq !== null && user_freq !== undefined ? Number(user_freq) : 100);
        if (!isValidFreq) {
            console.log(`[INFO][${did}] Ignored post, REASON: freq (user_freq: ${user_freq})`);
            return;
        }

        // 2. botへの暴言によるブラックリスト状態の取得
        let isBlacklisted = false;
        const replyRecord = await MemoryService.getReply(did);
        if (replyRecord && replyRecord.reply && replyRecord.updated_at) {
            if (hasNGWord(replyRecord.reply)) {
                const now = new Date().getTime();
                const lastReplyTime = new Date(replyRecord.updated_at).getTime();
                if ((now - lastReplyTime) / (1000 * 60 * 60) < 24) {
                    isBlacklisted = true;
                }
            }
        }

        // 3. メインロジック
        if (isSubscriber) {
            // サブスクユーザー: ブラックリストに関わらず常にAIリプライ
            console.log(`[INFO][${did}] New post: single post by subbed-follower !!`);
            replyType = "ai";
        } else {
            // 非サブスクユーザー
            // 10分間のインターバルチェック
            const postedAt = new Date(record.createdAt);
            const updatedAt = new Date(row?.updated_at || 0);
            if (postedAt.getTime() - updatedAt.getTime() <= MINUTES_THRD_RESPONSE) {
                console.log(`[INFO][${did}] Ignored post, REASON: past 10min`);
                return;
            }

            if (isBlacklisted) {
                // ブラックリスト入り: 強制的に定型文（ランダム）
                console.log(`[INFO][${did}] New post: blacklisted non-subscriber, forcing random reply`);
                replyType = "random";
            } else {
                // 通常の非サブスク判定
                const isU18 = row?.is_u18 ?? 0;
                const isAIOnly = row?.is_ai_only ?? 0;

                if (isU18 === 1) {
                    // U18ユーザーは常に定型文
                    console.log(`[INFO][${did}] New post: U18 user, forcing random reply`);
                    replyType = "random";
                } else {
                    // 一般ユーザー：カウントアップしてAIか定型文かを判定
                    console.log(`[INFO][${did}] New post: single post by NOT subbed-follower !!`);
                    globalNonSubPostCount++;
                    if (globalNonSubPostCount % EXEC_PER_COUNTS === 0) {
                        console.log(`[INFO][${did}] AI reply triggered by count (${globalNonSubPostCount})`);
                        replyType = "ai";
                    } else if (isAIOnly === 0) {
                        replyType = "random";
                    } else {
                        console.log(`[INFO][${did}] Ignored post, REASON: AI-Only-mode`);
                        replyType = null;
                    }
                }
            }
        }

        const text = record.text || "";
        let score: number | undefined;
        let aiReplyPosted = false;

        if (replyType === "ai") {
            if (await MemoryService.checkRPD()) {
                try {
                    const result = await retry(
                        async () => {
                            return await replyAI(follower, event, isSubscriber);
                        },
                        {
                            retries: 2, // 計3回 (初回 + 2回リトライ)
                            factor: 1,
                            minTimeout: 1000,
                            onRetry: (err: any, attempt: number) => {
                                console.warn(`[WARN][${did}] replyAI attempt ${attempt} failed. Retrying... Error: ${err.message}`);
                            }
                        }
                    );
                    score = result?.score ?? undefined;
                    aiReplyPosted = true;
                } catch (err: any) {
                    console.error(`[ERROR][${did}] Gemini reply failed after all retries. Falling back to replyRandom. Error:`, err.message);
                    await replyRandom(follower, event);
                }
            } else {
                console.log(`[INFO][${did}] Ignored post, REASON: rpd over`);
                return;
            }
        } else if (replyType === "random") {
            await replyRandom(follower, event);
        } else {
            console.log(`[INFO][${did}] Ignored post, REASON: AI-Only-mode`);
            return;
        }

        await MemoryService.addAffirmation({ did });
        await botBiothythmManager.addAffirmation(did);
        await MemoryService.incrementLang(getLangStr(record.langs) as any);

        await MemoryService.upsertFollowerInteraction(did);
        await MemoryService.logUsage(this.name, did, score !== undefined ? { text, score } : { text });
        // 1万人規模の全投稿を記憶するとノイズになるため、実際にAI返信できた
        // 投稿だけを横断記憶へ入れる。定型文およびAI失敗後のfallbackは対象外。
        if (shouldRememberAffirmedPost({
            surface: "bsky",
            aiReplyPosted,
            isTopLevel: true,
            isPublic: true,
            isSubscriber,
        })) {
            const uri = uniteDidNsidRkey(did, event.commit.collection, event.commit.rkey);
            await tryUpsertBotMemoryDocument({
                sourceType: "bsky_affirmed_post",
                sourceId: uri,
                sourceUri: uri,
                authorId: did,
                content: text,
                occurredAt: new Date(record.createdAt),
                affirmationScore: score ?? null,
                metadata: { replyType: "ai" },
            });
        }
    }

    private isJudgeByFreq(probability: number) {
        if (probability < 0 || probability > 100) {
            throw new Error("Probability must be between 0 and 100.");
        }
        return Math.random() * 100 < probability;
    }
}
