import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import type { FeatureIntentResult } from "./featureIntent.js";
export interface FeatureContext {
    isSubscriber: boolean;      // active のみ（課金支援者）
    isCommunityMember: boolean; // active + discord_only（Discordコミュニティメンバー）
    /** 投稿が呼んでいる機能。1投稿につき1回だけ判定する（LLM呼び出しを機能ごとに重ねないため）。 */
    featureIntents: () => Promise<FeatureIntentResult>;
}

export interface BotFeature {
    name: string;
    handlesOwnLogging?: boolean;
    shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean>;
    handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void>;
}
