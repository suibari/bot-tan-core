import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService, botLabelerManager } from "@bsky-affirmative-bot/clients";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { BADGE_DEF } from "@bsky-affirmative-bot/shared-configs";
import retry from 'async-retry';
import { AppBskyFeedPost, ComAtprotoRepoListRecords } from '@atproto/api';
type RecordPost = AppBskyFeedPost.Record;
type RecordList = ComAtprotoRepoListRecords.Record;
import { agent } from '../bsky/agent.js';
import { getLangStr } from "../bsky/util.js";
import { handleMode, isPast } from "./utils.js";
import { GeminiResponseResult, UserInfoGemini } from '@bsky-affirmative-bot/shared-configs';
import { generateAnalyzeResult, AnalyzeResult } from "@bsky-affirmative-bot/bot-brain";
import { textToImageBufferWithBackground } from '../util/canvas.js';
import { getConcatPosts } from '../bsky/getConcatPosts.js';
import { AtpAgent } from "@atproto/api";
import { getPds } from '../bsky/getPds.js';
import { getConcatAuthorFeed } from '../bsky/getConcatAuthorFeed.js';

export class AnalyzeFeature implements BotFeature {
    name = "Analyze";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        if (!(await context.featureIntents()).intents.has("analyze")) return false;

        if (process.env.NODE_ENV !== "development") {
            if (!(await isPast(event, "last_analyze_at", 6 * 24 * 60))) return false;
        }

        return true;
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        if (!(await MemoryService.checkRPD())) {
            console.log(`[INFO][${follower.did}] Ignored Analyze, REASON: rpd over`);
            return;
        }

        const record = event.commit.record as RecordPost;

        const result = await handleMode(event, {
            dbColumn: "last_analyze_at",
            dbValue: new Date(),
            generateText: this.getBlobWithAnalyze.bind(this),
        },
            {
                follower,
                langStr: getLangStr(record.langs),
            });

        if (result) {
            await MemoryService.logUsage('analysis', follower.did);
            await botBiothythmManager.addAnalysis();
        }
    }

    private async getBlobWithAnalyze(userinfo: UserInfoGemini): Promise<GeminiResponseResult> {
        const TEXT_INTRO_ANALYZE = (userinfo.langStr === "日本語") ?
            `${userinfo.follower.displayName}さんのポストから、あなたの性格を分析したよ！ 画像を貼るので見てみてね。性格分析は1週間に1回までしかできないので、時間がたったらまたやってみてね！` :
            `${userinfo.follower.displayName}, I analyzed your personality from your posts! Check the image. You can only do personality analysis once a week, so try again after some time!`;

        // ポスト収集
        const feeds = await getConcatAuthorFeed(userinfo.follower.did, 100);
        userinfo.posts = feeds.map(feed => (feed.post.record as RecordPost).text);

        // いいね収集
        const agentPDS = new AtpAgent({ service: await getPds(userinfo.follower.did) });
        const responseLike = await agentPDS.com.atproto.repo.listRecords({
            repo: userinfo.follower.did,
            collection: "app.bsky.feed.like",
            limit: 100,
        });
        const uris = (responseLike.data.records as RecordList[])
            .map(record => (record.value as any).subject.uri);
        const likes = (await getConcatPosts(uris))
            .map(like => (like.record as RecordPost).text);
        userinfo.likedByFollower = likes;

        const analyzeResult = await retry(async () => {
            const res = await generateAnalyzeResult(userinfo);
            if (!res) {
                throw new Error("API result is empty, retrying...");
            }
            return res;
        }, {
            retries: 3,
            onRetry: (e: unknown, attempt) => {
                if (e instanceof Error) {
                    console.log(`[${new Date().toISOString()}] Attempt ${attempt} failed: ${e.message}`);
                } else {
                    console.log(`[${new Date().toISOString()}] Attempt ${attempt} failed with an unknown error.`);
                }
            }
        });

        // if (process.env.NODE_ENV === "development") {
        //     console.log("[DEBUG] bot>>> " + analyzeResult.analysis);
        // }

        // 画像生成
        const buffer = await textToImageBufferWithBackground(analyzeResult.analysis, "./img/bot-tan-analyze.png");

        // uploadBlod
        const { blob } = (await agent.uploadBlob(buffer, { encoding: "image/png" })).data;

        let replyText = TEXT_INTRO_ANALYZE;

        // 称号バッジ (分析) 適用処理 (日記称号を上書きするため同じIDを使用)
        try {
            const userDid = userinfo.follower.did;
            await MemoryService.ensureFollower(userDid);
            const def = BADGE_DEF.analyzeTitle(userDid, analyzeResult.title_ja, analyzeResult.title_en);
            console.log(`[INFO][BADGE][ANALYZE] Upserting title badge definition for ${userDid}: ${analyzeResult.title_ja} / ${analyzeResult.title_en}`);

            // 1. レーベラーに定義を upsert
            await botLabelerManager.upsertLabelDefinition(def.id, def.locales);

            // 2. 1週間の有効期限を計算
            const expDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

            // 3. ユーザーに1週間限定バッジを適用
            await botLabelerManager.applyLabel(userDid, def.id, false, expDate);

            // 4. DB 更新
            await MemoryService.updateFollower(userDid, "current_title_ja", analyzeResult.title_ja);
            await MemoryService.updateFollower(userDid, "current_title_en", analyzeResult.title_en);
            console.log(`[INFO][BADGE][ANALYZE] Successfully applied title badge ${def.id} to ${userDid} with exp=${expDate}`);

            // 成功メッセージの追加
            if (userinfo.langStr === "日本語") {
                replyText += `\n\n🎉「${analyzeResult.title_ja}」の称号バッジをプレゼントしたよ！\n※バッジを表示するにはラベラー（ https://bsky.app/profile/labeler.bot-tan.com ）を登録してね`;
            } else {
                replyText += `\n\n🎉 I've gifted you the title badge "${analyzeResult.title_en}"!\n*To show the badge, please subscribe to the labeler ( https://bsky.app/profile/labeler.bot-tan.com ).`;
            }
        } catch (badgeErr: any) {
            console.error(`[ERROR][BADGE][ANALYZE] Failed to apply title badge for ${userinfo.follower.did}:`, badgeErr.message);
        }

        return {
            text: replyText,
            imageBlob: blob,
        };
    }
}
