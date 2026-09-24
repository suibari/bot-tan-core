import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode, isPast } from "./utils.js";
import {
    MoodSongResolver,
    resolveLinkedMoodSong,
    type LinkedMoodSong,
    type ReservedMoodSong,
} from "@bsky-affirmative-bot/bot-brain";
import {
    djSongSelectionScope,
    finalizeBotSongSelection,
    protectBotSongSelectionForPublish,
    releaseBotSongSelection,
} from "@bsky-affirmative-bot/database";
import retry from "async-retry";
import { getLangStr } from "../bsky/util.js";
import { UserInfoGemini, GeminiResponseResult } from "@bsky-affirmative-bot/shared-configs";
import { agent } from "../bsky/agent.js";
import { buildDjSongReply } from "./djSongReply.js";

const moodSongResolver = new MoodSongResolver<LinkedMoodSong>(30, { resolve: resolveLinkedMoodSong });

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
            limit: 21,
            filter: "posts_with_replies",
        });
        const requestUri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
        const posts = response.data.feed
            .filter(post => !post.reason && post.post.uri !== requestUri) // リポストと今回の依頼の重複を除外
            .map(post => (post.post.record as Record).text);

        // 0要素目にDJリクエストポスト、1要素目以降に過去ポストをセット
        posts.unshift(record.text);

        if (!(await MemoryService.checkRPD())) {
            console.log(`[INFO][${follower.did}] Ignored DJ, REASON: rpd over`);
            return;
        }

        let selectedSong: ReservedMoodSong<LinkedMoodSong> | undefined;
        let songProtected = false;
        let songPostCompleted = false;
        const songSelectionScope = djSongSelectionScope(follower.did);
        let result: boolean;
        try {
            result = await handleMode(event, {
                dbColumn: "last_dj_at",
                dbValue: new Date(),
                generateText: async (userinfo) => {
                    const generated = await this.getSongLink(userinfo, songSelectionScope);
                    selectedSong = generated.song;
                    return generated.text;
                },
                beforePublish: async () => {
                    if (!selectedSong) return;
                    await protectBotSongSelectionForPublish(selectedSong.reservation);
                    songProtected = true;
                },
                onPublished: async () => {
                    if (!selectedSong) return;
                    songPostCompleted = true;
                    const requestUri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
                    try {
                        await retry(() => finalizeBotSongSelection(selectedSong!.reservation, requestUri), { retries: 2 });
                    } catch (error) {
                        console.error("[ERROR][MOOD_SONG] Failed to finalize DJ reservation", error);
                    } finally {
                        moodSongResolver.remember(
                            songSelectionScope,
                            selectedSong.song,
                            selectedSong.reservation.selectedAt,
                        );
                    }
                },
            },
                {
                    follower,
                    posts,
                    langStr: getLangStr(record.langs),
                });
        } catch (error) {
            if (selectedSong && !songProtected && !songPostCompleted) {
                await releaseBotSongSelection(selectedSong.reservation).catch((releaseError) =>
                    console.error("[ERROR][MOOD_SONG] Failed to release DJ reservation", releaseError));
            }
            // publishing へ進んだ後は投稿結果を断定できないため、30日保護を残す。
            throw error;
        }

        if (result) {
            await MemoryService.logUsage('dj', follower.did);
            await botBiothythmManager.addDJ();
        } else if (selectedSong && !songProtected) {
            await releaseBotSongSelection(selectedSong.reservation).catch((error) =>
                console.error("[ERROR][MOOD_SONG] Failed to release unpublished DJ reservation", error));
        }
    }

    private async getSongLink(
        userinfo: UserInfoGemini,
        songSelectionScope: ReturnType<typeof djSongSelectionScope>,
    ): Promise<{
        text: GeminiResponseResult;
        song?: ReservedMoodSong<LinkedMoodSong>;
    }> {
        const query = (userinfo.posts?.[0] ?? "").slice(0, 1_000);
        const recentPosts = (userinfo.posts?.slice(1, 21) ?? []).reduce<string[]>((selected, post) => {
            const used = selected.reduce((sum, value) => sum + value.length, 0);
            const remaining = 4_000 - used;
            if (remaining <= 0) return selected;
            selected.push(post.slice(0, remaining));
            return selected;
        }, []);
        const langStr = userinfo.langStr ?? "日本語";
        const reservedSong = await moodSongResolver.resolveAndReserve(
            { postText: query, recentPosts },
            langStr,
            songSelectionScope,
        );
        if (!reservedSong) {
            return {
                text: langStr === "日本語"
                    ? "ごめんね、曲のリンクとジャケットを確認できる一曲を見つけられなかったよ。"
                    : "Sorry, I couldn't find a song with a verified link and album cover.",
            };
        }
        try {
            const text = await buildDjSongReply(reservedSong.song, async (data, encoding) =>
                (await agent.uploadBlob(data, { encoding })).data.blob);
            return { text, song: reservedSong };
        } catch (error) {
            await releaseBotSongSelection(reservedSong.reservation);
            throw error;
        }
    }
}
