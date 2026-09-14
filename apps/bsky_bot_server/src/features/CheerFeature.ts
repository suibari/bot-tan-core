import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode, isPast } from "./utils.js";
import { getLangStr, uniteDidNsidRkey } from "../bsky/util.js";
import { UserInfoGemini, GeminiResponseResult } from "@bsky-affirmative-bot/shared-configs";
import { judgeCheerSubject } from "@bsky-affirmative-bot/bot-brain";
import { generateCheerResult } from "@bsky-affirmative-bot/bot-brain";
import { repost } from "../bsky/repost.js";

export class CheerFeature implements BotFeature {
    name = "Cheer";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        // Check if subscriber
        if (!context.isCommunityMember) return false;

        // Check trigger (ハッシュタグは必須。LLMモードでも、複数機能に該当したときの選択だけをLLMに任せる)
        if (!(await context.featureIntents()).intents.has("cheer")) return false;

        // Check condition (isPast)
        if (process.env.NODE_ENV !== "development") {
            if (!(await isPast(event, "last_cheer_at", 8 * 60))) return false;
        }

        return true;
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        if (!(await MemoryService.checkRPD())) {
            console.log(`[INFO][${follower.did}] Ignored Cheer, REASON: rpd over`);
            return;
        }

        const record = event.commit.record as Record;

        const result = await handleMode(event, {
            dbColumn: "last_cheer_at",
            dbValue: new Date(),
            generateText: this.repostAndGenerate.bind(this),
            disableReply: true,
        },
            {
                follower,
                posts: [record.text],
                langStr: getLangStr(record.langs),
            });

        if (result) {
            await MemoryService.logUsage('cheer', follower.did);
            await botBiothythmManager.addCheer();
        }
    }

    private async repostAndGenerate(userinfo: UserInfoGemini, event: CommitCreateEvent<"app.bsky.feed.post">): Promise<GeminiResponseResult | undefined> {
        const uri = uniteDidNsidRkey(event.did, event.commit.collection, event.commit.rkey);
        const cid = String(event.commit.cid);

        const judge = await judgeCheerSubject(userinfo);
        if (!judge.result) {
            console.log(`[INFO][${userinfo.follower.did}] judged as inappropriate post!`);
            console.log(`[INFO] judge>>> ${judge.comment}`);
            return undefined;
        }

        let text: string;
        try {
            text = await generateCheerResult(userinfo);
        } catch (err) {
            console.error(`[ERROR][${userinfo.follower.did}] Failed to generate cheer result:`, err);
            return undefined;
        }

        await repost(uri, cid);

        return text;
    }
}
