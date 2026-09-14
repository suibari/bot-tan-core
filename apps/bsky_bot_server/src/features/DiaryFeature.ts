import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";

import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode } from "./utils.js";
import { getLangStr, getTimezoneFromLang } from "../bsky/util.js";
import { MemoryService, applyDiaryTitle, buildUserDiaryContext, calculateDelayUntilLocal22, isPastLocal22, localDateStr, selectUserDiaryMediaReference, withPreferredName } from "@bsky-affirmative-bot/clients";
import { LanguageName } from "@bsky-affirmative-bot/shared-configs";
import { getConcatProfiles } from "../bsky/getConcatProfiles.js";
import { getDaysAuthorFeed } from "../bsky/getDaysAuthorFeed.js";
import { DIARY_MAX_ATTEMPTS, generateUserDiaryResilient, DiaryResult } from "@bsky-affirmative-bot/bot-brain";
import { textToImageBufferWithBackground } from "../util/canvas.js";
import { agent } from "../bsky/agent.js";
import { postContinuous } from "../bsky/postContinuous.js";

const TEXT_REGISTER_DIARY = (langStr: LanguageName) => (langStr === "日本語") ?
    "日記モードを設定しました! これから毎日、PM10時にあなたの今日のできごとを日記にしてまとめるね!" :
    "Diary mode has been enabled! From now on, every day at 10 PM, I'll write a diary of your day's events!";

const TEXT_RELEASE_DIARY = (langStr: LanguageName) => (langStr === "日本語") ?
    "日記モードを解除しました! また使ってね!" :
    "Diary mode has been disabled! Please use it again!"

// 多重スケジュール抑止用。値が null なのは「タイマー待ちではなく今まさに実行中」。
const scheduledTimers = new Map<string, NodeJS.Timeout | null>();

export class DiaryFeature implements BotFeature {
    name = "Diary";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        if (!context.isCommunityMember) return false;

        const { intents } = await context.featureIntents();
        return intents.has("diary_on") || intents.has("diary_off");
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const { intents } = await context.featureIntents();
        // 「日記をやめて」は解除を優先する。regex モードでは両方のトリガーを含む投稿がありうる。
        if (intents.has("diary_off")) {
            await this.handleDiaryRelease(event);
            return;
        }
        if (intents.has("diary_on")) {
            await this.handleDiaryRegister(event);
        }
    }

    private async handleDiaryRegister(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        return await handleMode(event, {
            dbColumn: "is_diary",
            dbValue: 1,
            generateText: TEXT_REGISTER_DIARY(langStr),
        });
    }

    private async handleDiaryRelease(event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);

        return await handleMode(event, {
            dbColumn: "is_diary",
            dbValue: 0,
            generateText: TEXT_RELEASE_DIARY(langStr),
        });
    }
}

/** ローカル22時までの遅延。Nagi 側の日記スケジューラと共用するため実体は clients にある。 */
export { calculateDelayUntilLocal22 };

/**
 * Processes the diary for a single user.
 * @param userDid The user's DID.
 * @param timezone The user's timezone. その日ぶんを書き終えたかの判定に使う。
 */
async function processUserDiary(userDid: string, timezone: string) {
    try {
        console.log(`[INFO][${userDid}] Processing diary...`);

        const until = new Date();
        const diaryDate = localDateStr(timezone, until);

        // 取りこぼし回収で毎時呼ばれるので、書き終えた日はここで抜ける。
        const follower = await MemoryService.getFollower(userDid);
        if (follower?.last_diary_date === diaryDate) {
            console.log(`[INFO][${userDid}] diary for ${diaryDate} already posted`);
            return;
        }

        // Nagi にその日のポストがあれば、日記は Nagi 側が書く。
        // クロスポスト（isNagiCrosspost）と同じく、片方が担当したらもう片方は黙る。
        // ここでは last_diary_date を書かない。書くと Nagi 側が失敗したときに
        // 両方欠測で確定してしまう。
        const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
        if (await MemoryService.hasNagiPostsSince(userDid, since)) {
            console.log(`[INFO][${userDid}] Nagi diary takes precedence, skipping Bluesky diary`);
            return;
        }

        // ユーザープロフィールを取得
        const profiles = await getConcatProfiles({ actors: [userDid] });
        if (!profiles || profiles.length === 0) {
            console.log(`[INFO][${userDid}] not found profile`);
            return;
        }
        const profile = profiles[0];

        // 本関数実行時から24h前までのポストを収集
        const allRecentPosts = await getDaysAuthorFeed(userDid);

        if (allRecentPosts.length === 0) {
            console.log(`[INFO][${userDid}] today's post not found`);
            // Removed self-scheduling from here. The higher-level scheduler will handle re-scheduling.
            return;
        }

        const posts = allRecentPosts.map(item => (item.post.record as Record).text);
        const latestPost = allRecentPosts.find(item => !item.reply)?.post;

        if (!latestPost) {
            console.log(`[INFO][${userDid}] all posts are reply`);
            // Removed self-scheduling from here.
            return;
        }
        const langStr = getLangStr((latestPost.record as Record).langs);
        const dayContext = await buildUserDiaryContext({
            did: userDid,
            date: diaryDate,
            since,
            until,
            timezone,
            japanese: langStr === "日本語",
        });
        const mediaReference = await selectUserDiaryMediaReference(userDid, diaryDate);

        console.log(`[INFO][${userDid}] generating diary...`);

        let diaryResult: DiaryResult;
        try {
            // 失敗するたびにモデル/tier を上げながら最大3時間粘る。
            // 使い切っても、22時を過ぎている人は毎時の再スキャンが拾い直す。
            const userinfo = await withPreferredName({
                follower: profile as ProfileView,
                posts: posts.reverse(),
                langStr,
            });
            diaryResult = await generateUserDiaryResilient(
                userinfo,
                { dayContext, mediaReference, label: `[${userDid}][DIARY]` },
            );
        } catch (e: any) {
            console.error(`[ERROR][${userDid}][DIARY] Failed to generate diary after up to ${DIARY_MAX_ATTEMPTS} attempts:`, e.message);
            return;
        }

        const text_bot = diaryResult.diary;

        console.log(`[INFO][${userDid}] generating image...`);
        const imageGenerationDate = new Date(); // Use a new Date object for image generation context
        const formattedDate = `${imageGenerationDate.getFullYear()}/${imageGenerationDate.getMonth() + 1}/${imageGenerationDate.getDate()}`;
        const buffer = await textToImageBufferWithBackground(text_bot + `\n\n${formattedDate}`);
        const { blob } = (await agent.uploadBlob(buffer, { encoding: "image/png" })).data;

        let replyText = (langStr === "日本語") ?
            `${profile.displayName}さんへ、今日の日記をまとめたよ! 画像を貼るので見てみてね。おやすみ～!` :
            `${profile.displayName}, I summarized your diary for today! Check the image. Good night!`;

        // 称号バッジ (日記) 適用処理。Nagi 側の日記からも同じ関数を呼ぶ。
        try {
            await applyDiaryTitle(userDid, diaryResult);

            // 成功メッセージの追加
            if (langStr === "日本語") {
                replyText += `\n\n🎉「${diaryResult.title_ja}」の称号バッジをプレゼントしたよ！\n※バッジを表示するにはラベラー（ https://bsky.app/profile/labeler.bot-tan.com ）を登録してね`;
            } else {
                replyText += `\n\n🎉 I've gifted you the title badge "${diaryResult.title_en}"!\n*To show the badge, please subscribe to the labeler ( https://bsky.app/profile/labeler.bot-tan.com ).`;
            }
        } catch (badgeErr: any) {
            console.error(`[ERROR][BADGE][DIARY] Failed to apply title badge for ${userDid}:`, badgeErr.message);
        }

        // ポスト
        await postContinuous(replyText, {
            uri: latestPost.uri,
            cid: latestPost.cid,
            record: latestPost.record as Record
        }, { blob, alt: `Dear ${profile.displayName}, From 全肯定botたん` });

        // 投稿できたときだけ記録する。ここより手前で落ちた日は取りこぼし扱いで再試行される。
        await MemoryService.updateFollower(userDid, 'last_diary_date', diaryDate);

        console.log(`[INFO][${userDid}] finish to process diary (${diaryDate})`);

    } catch (e: any) {
        console.error(`[ERROR][${userDid}] an error occured in diary process:`, e);
    }
}

/** 実行中も scheduledTimers に居座らせて、毎時の再スキャンによる二重起動を防ぐ。 */
function runUserDiary(userDid: string, timezone: string) {
    processUserDiary(userDid, timezone)
        .catch(err => console.error(`[ERROR][${userDid}]`, err))
        .finally(() => {
            scheduledTimers.delete(userDid); // 終了後に削除
        });
}

/**
 * Schedules the diary processing for a single user for their local 22:00.
 * すでに22時を回っているなら即実行する。setTimeout に任せると次は約24時間後になり、
 * 生成失敗やプロセス再起動でその日の日記が丸ごと欠測してしまうため。
 * 二重投稿は processUserDiary 冒頭の last_diary_date チェックが防ぐ。
 * @param userDid The user's DID.
 * @param timezone The user's timezone.
 */
function scheduleUserDiary(userDid: string, timezone: string) {
    if (scheduledTimers.has(userDid)) return; // すでにスケジュール済み

    if (isPastLocal22(timezone)) {
        console.log(`[INFO][${userDid}] past local 22:00, running diary now (tz: ${timezone})`);
        // タイマーは無いが、実行中の印として同じ Map を使う。
        scheduledTimers.set(userDid, null);
        runUserDiary(userDid, timezone);
        return;
    }

    const delay = calculateDelayUntilLocal22(timezone);
    console.log(`[INFO][${userDid}] scheduling diary, tz: ${timezone}, next: ${delay}ms`);
    const timer = setTimeout(() => runUserDiary(userDid, timezone), delay);

    scheduledTimers.set(userDid, timer);
}

/**
 * Manages all user diary schedules. Fetches users, determines their timezone,
 * calculates delays, and schedules their diary processing.
 * This function is intended to be called periodically to ensure all users are scheduled.
 */
async function manageUserDiarySchedules() {
    const usersWithDiaryMode = await MemoryService.getFollowersByColumn("is_diary", 1);

    if (!usersWithDiaryMode || usersWithDiaryMode.length === 0) {
        console.log("[INFO][DIARY] no user for diary mode");
        return;
    }
    console.log(`[INFO][DIARY] is_diary: ${usersWithDiaryMode.length}`);

    // Fetch community members (active + discord_only) from the database
    const communityMembers = await MemoryService.getCommunityMembersOrDeveloper();
    const communityMemberSet = new Set(communityMembers);

    // Filter users to include only those who are community members
    const eligibleUsers = usersWithDiaryMode.filter(user => communityMemberSet.has(user.did));
    console.log(`[INFO][DIARY] subbed-follower && is_diary: ${eligibleUsers.length}`);

    for (const user of eligibleUsers) { // Iterate over eligibleUsers instead of usersWithDiaryMode
        const userDid = user.did; // Extract did from the user object
        try {
            // 削除されたユーザなどがいるので、まずgetProfileして確認
            await agent.getProfile({ actor: userDid });

            // Fetch latest post to get language
            // Note: getTodaysAuthorFeed is called here just to get the latest post for language detection.
            // The actual "today's posts" fetching happens in processUserDiary with a specific date.
            const feedForLang = await getDaysAuthorFeed(userDid);
            const latestPost = feedForLang.find(item => !item.reply)?.post;
            if (!latestPost) {
                console.log(`[INFO][${userDid}] latest post not found`);
                continue;
            }
            const lang = (latestPost.record as Record).langs?.[0];
            // console.log(`[DEBUG][${userDid}] lang: ${lang}`);
            const timezone = getTimezoneFromLang(lang);

            // Schedule the user's diary processing if not already scheduled.
            // For simplicity, we'll just schedule it. A more robust system would track scheduled timers.
            scheduleUserDiary(userDid, timezone);

        } catch (e: any) {
            if (e.error === 'AccountDeactivated') {
                console.log(`[INFO][${userDid}] account deactivated, skipping...`);
                continue;
            }
            if (e.error === 'AccountTakedown') {
                console.log(`[INFO][${userDid}] account was takedown, skipping...`);
                continue;
            }
            if (e.error === 'BlockedByActor') {
                console.log(`[INFO][${userDid}] account blocked bot, skipping...`);
                continue;
            }
            console.error(`[ERROR][${userDid}] error occur in diary scheduling:`, e);
        }
    }
}

/**
 * Main scheduler function. Called on application startup.
 * Sets up periodic checks for user schedules and initial scheduling.
 */
export async function scheduleAllUserDiaries() {
    console.log("[INFO][DIARY] scheduling all user diary");

    // await createOrRefreshSession();

    // Periodically check and update user schedules (e.g., every hour)
    setInterval(async () => {
        console.log("[INFO][DIARY] priodically sheduling set");
        await manageUserDiarySchedules();
    }, 60 * 60 * 1000); // Check every hour

    // Initial scheduling
    await manageUserDiarySchedules();
}
