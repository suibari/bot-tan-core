import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode } from "./utils.js";

export class FrequencyFeature implements BotFeature {
    name = "Frequency";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        // 0~100の整数が取れたときだけ reply_frequency になる（featureIntent.ts）
        return (await context.featureIntents()).intents.has("reply_frequency");
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const { replyFrequency } = await context.featureIntents();
        if (replyFrequency === undefined) return;

        await handleMode(event, {
            dbColumn: "reply_freq",
            dbValue: replyFrequency,
            generateText: `了解! ${follower.displayName}さんへのリプライする頻度を${replyFrequency}%にするね! ちなみに占いはいつでもできるよ～`,
        },
            {
                follower,
            });
    }
}
