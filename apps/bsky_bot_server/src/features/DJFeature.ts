import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import { botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode, isPast } from "./utils.js";
import {
    MoodSongResolver,
    type GroundedMoodSong,
} from "@bsky-affirmative-bot/bot-brain";
import {
    djSongSelectionScope,
    recordBotSongSelection,
} from "@bsky-affirmative-bot/database";
import { getLangStr } from "../bsky/util.js";
import { UserInfoGemini, GeminiResponseResult } from "@bsky-affirmative-bot/shared-configs";
import { agent } from "../bsky/agent.js";

const moodSongResolver = new MoodSongResolver();

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

        let selectedSong: GroundedMoodSong | undefined;
        const songSelectionScope = djSongSelectionScope(follower.did);
        const result = await handleMode(event, {
            dbColumn: "last_dj_at",
            dbValue: new Date(),
            generateText: async (userinfo) => {
                const generated = await this.getSongLink(userinfo, songSelectionScope);
                selectedSong = generated.song;
                return generated.text;
            },
        },
            {
                follower,
                posts,
                langStr: getLangStr(record.langs),
            });

        if (result) {
            if (selectedSong) {
                const song = selectedSong;
                const requestUri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
                try {
                    await recordBotSongSelection({
                        videoId: song.videoId,
                        songKey: song.songKey,
                        title: song.title,
                        artist: song.artist,
                        scope: songSelectionScope,
                        outputRef: requestUri,
                    });
                } catch (error) {
                    console.error("[WARN][MOOD_SONG] Failed to record DJ song", error);
                } finally {
                    moodSongResolver.remember(songSelectionScope, song);
                }
            }
            await MemoryService.logUsage('dj', follower.did);
            await botBiothythmManager.addDJ();
        }
    }

    private async getSongLink(
        userinfo: UserInfoGemini,
        songSelectionScope: ReturnType<typeof djSongSelectionScope>,
    ): Promise<{
        text: GeminiResponseResult;
        song?: GroundedMoodSong;
    }> {
        const query = (userinfo.posts?.[0] ?? "").slice(0, 1_000);
        const langStr = userinfo.langStr ?? "日本語";
        const groundedSong = await moodSongResolver.resolve(query, langStr, songSelectionScope);
        if (!groundedSong) {
            return {
                text: langStr === "日本語"
                    ? "ごめんね、検索とYouTubeの両方で実在を確認できる曲を見つけられなかったよ。"
                    : "Sorry, I couldn't find a song I could verify through search and YouTube.",
            };
        }
        const text = `${groundedSong.comment}
title: ${groundedSong.title}
artist: ${groundedSong.artist}
${groundedSong.lastFmUrl ? `Source: Last.fm ${groundedSong.lastFmUrl}\n` : ""}
${groundedSong.url}`;
        return { text, song: groundedSong };
    }
}
