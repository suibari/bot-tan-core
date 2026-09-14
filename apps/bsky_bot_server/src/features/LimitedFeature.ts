import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode } from "./utils.js";
import { getLangStr } from "../bsky/util.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";

export class LimitedFeature implements BotFeature {
    name = "Limited";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        const { intents } = await context.featureIntents();

        return (
            intents.has("predefined_mode_on") ||
            intents.has("predefined_mode_off") ||
            intents.has("ai_only_mode_off") ||
            intents.has("ai_only_mode_on")
        );
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const { intents } = await context.featureIntents();

        if (intents.has("predefined_mode_off")) {
            await this.handleU18Release(event);
            return;
        }
        if (intents.has("predefined_mode_on")) {
            await this.handleU18Register(event);
            return;
        }
        if (intents.has("ai_only_mode_off")) {
            await this.handleAIonlyRelease(event);
            return;
        }
        if (intents.has("ai_only_mode_on")) {
            await this.handleAIonlyRegister(event);
            return;
        }
    }

    private async handleU18Register(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        const TEXT_REGISTER_U18 = (langStr === "日本語") ?
            "定型文モードを設定しました! これからはAIを使わずに全肯定しますね。" :
            "Predefined reply mode enabled! I will give affirmative replies without using AI from now on.";

        return await handleMode(event, {
            dbColumn: "is_u18",
            dbValue: 1,
            generateText: TEXT_REGISTER_U18,
        });
    }

    private async handleU18Release(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        const TEXT_RELEASE_U18 = (langStr === "日本語") ?
            "定型文モードを解除しました! これからはたまにAIを使って全肯定しますね。" :
            "Predefined reply mode disabled! I will sometimes use AI to give affirmative replies from now on.";

        return await handleMode(event, {
            dbColumn: "is_u18",
            dbValue: 0,
            generateText: TEXT_RELEASE_U18,
        });
    }

    private async handleAIonlyRegister(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        const TEXT_REGISTER_AIONLY = (langStr === "日本語") ?
            "AI限定モードを設定しました! これからは定型文を使わずに全肯定しますね。" :
            "AI only mode enabled! I will give affirmative replies using only AI from now on.";

        return await handleMode(event, {
            dbColumn: "is_ai_only",
            dbValue: 1,
            generateText: TEXT_REGISTER_AIONLY,
        });
    }

    private async handleAIonlyRelease(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        const TEXT_RELEASE_AIONLY = (langStr === "日本語") ?
            "AI限定モードを解除しました! これからは定型文も使って全肯定しますね。" :
            "AI only mode disabled! I will use predefined replies to give affirmative replies from now on.";

        return await handleMode(event, {
            dbColumn: "is_ai_only",
            dbValue: 0,
            generateText: TEXT_RELEASE_AIONLY,
        });
    }
}
