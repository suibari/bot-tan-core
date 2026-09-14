import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode, isPast } from "./utils.js";
import { generateRecommendedSong } from "@bsky-affirmative-bot/bot-brain";
import { getLangStr } from "../bsky/util.js";
import { UserInfoGemini, GeminiResponseResult } from "@bsky-affirmative-bot/shared-configs";
import { agent } from "../bsky/agent.js";
import { searchYoutubeLink } from "@bsky-affirmative-bot/bot-brain";

export class DJFeature implements BotFeature {
    name = "DJ";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        if (!(await context.featureIntents()).intents.has("dj")) return false;

        if (process.env.NODE_ENV !== "development") {
            if (!(await isPast(event, "last_dj_at", 5))) return false;
        }

        return true;
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const record = event.commit.record as Record;

        // ポスト収集
        const response = await agent.getAuthorFeed({
            actor: follower.did,
            limit: 100,
            filter: "posts_with_replies",
        });
        const posts = response.data.feed
            .filter(post => !post.reason) // リポスト除外
            .map(post => (post.post.record as Record).text);

        // 0要素目にDJリクエストポスト、1要素目以降に過去ポストをセット
        posts.unshift(record.text);

        if (!(await MemoryService.checkRPD())) {
            console.log(`[INFO][${follower.did}] Ignored DJ, REASON: rpd over`);
            return;
        }

        const result = await handleMode(event, {
            dbColumn: "last_dj_at",
            dbValue: new Date(),
            generateText: this.getSongLink.bind(this),
        },
            {
                follower,
                posts,
                langStr: getLangStr(record.langs),
            });

        if (result) {
            await MemoryService.logUsage('dj', follower.did);
            await botBiothythmManager.addDJ();
        }
    }

    private async getSongLink(userinfo: UserInfoGemini): Promise<GeminiResponseResult> {
        const resultGemini = await generateRecommendedSong(userinfo);
        const resultYoutube = await searchYoutubeLink(`${resultGemini.artist} ${resultGemini.title}`);

        const result =
            `${resultGemini.comment}
title: ${resultGemini.title}
artist: ${resultGemini.artist}

${resultYoutube ?? "[Sorry, I couldn't find the song on Youtube...]"}`;

        return result;
    }
}
