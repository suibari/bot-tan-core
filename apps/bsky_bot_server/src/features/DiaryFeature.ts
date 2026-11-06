import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";

import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { handleMode } from "./utils.js";
import { getLangStr } from "../bsky/util.js";
import { isInDiaryDayWindow } from "@bsky-affirmative-bot/shared-configs";
import { claimDiaryJobs, decideDiaryJobs, finishDiaryJob, type DiaryJob, type DiaryJobOutcome } from "@bsky-affirmative-bot/database";
import { startWorkerLoop } from "@bsky-affirmative-bot/bot-runtime";
import { MemoryService, applyDiaryTitle, buildUserDiaryContext, selectUserDiaryMediaReference, withPreferredName } from "@bsky-affirmative-bot/clients";
import { LanguageName } from "@bsky-affirmative-bot/shared-configs";
import { getConcatProfiles } from "../bsky/getConcatProfiles.js";
import { getDaysAuthorFeed } from "../bsky/getDaysAuthorFeed.js";
import { DIARY_MAX_ATTEMPTS, generateUserDiaryResilient, DiaryResult } from "@bsky-affirmative-bot/bot-brain";
import { textToImageBufferWithBackground } from "../util/canvas.js";
import { agent } from "../bsky/agent.js";
import { postContinuous } from "../bsky/postContinuous.js";

const TEXT_REGISTER_DIARY = (langStr: LanguageName) => (langStr === "日本語") ?
    "日記モードを設定しました! これから毎日、1日の終わり（ふだんは夜10時）に、あなたのその日のできごとを日記にしてまとめるね!" :
    "Diary mode has been enabled! From now on, at the end of each day (usually 10 PM), I'll write a diary of your day's events!";

const TEXT_RELEASE_DIARY = (langStr: LanguageName) => (langStr === "日本語") ?
    "日記モードを解除しました! また使ってね!" :
    "Diary mode has been disabled! Please use it again!"

const DAY_MS = 24 * 60 * 60 * 1000;
/** 日記の見回りの間隔。どの面が書くかの決定と、Bluesky に決まった日の実行。 */
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
/** Bluesky の最新の投稿の言語を記録し直す間隔。 */
const LANG_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * 1人・1日ぶんの Bluesky の日記を書く。どの日に誰が書くか（Nagi か Bluesky か）は
 * database の decideDiaryJobs が決め、ここへは Bluesky に決まった日だけが来る。
 * 窓（区切り）は Nagi と同じ関数で決まったもので、Nagi で本人が教えた設定も効く。
 */
async function processUserDiary(job: DiaryJob): Promise<DiaryJobOutcome> {
    const userDid = job.did;
    const { date: diaryDate, timezone } = job.window;
    const since = job.window.start;
    const until = job.window.end;
    try {
        console.log(`[INFO][${userDid}] Processing diary for ${diaryDate}...`);

        // ユーザープロフィールを取得
        const profiles = await getConcatProfiles({ actors: [userDid] });
        if (!profiles || profiles.length === 0) {
            console.log(`[INFO][${userDid}] not found profile`);
            return "skipped";
        }
        const profile = profiles[0];

        // 窓の始まりまでさかのぼって取り、窓の中の投稿だけを材料にする。
        const daysAgo = Math.max(1, (Date.now() - since.getTime()) / DAY_MS);
        const allRecentPosts = (await getDaysAuthorFeed(userDid, daysAgo)).filter((item) =>
            isInDiaryDayWindow(new Date(item.post.indexedAt), job.window),
        );

        if (allRecentPosts.length === 0) {
            console.log(`[INFO][${userDid}] today's post not found`);
            return "skipped";
        }

        const posts = allRecentPosts.map(item => (item.post.record as Record).text);
        const latestPost = allRecentPosts.find(item => !item.reply)?.post;

        if (!latestPost) {
            console.log(`[INFO][${userDid}] all posts are reply`);
            return "skipped";
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
            // 使い切っても、次の日の窓が閉じるまでは diary_jobs を1時間おきに拾い直す。
            const userinfo = await withPreferredName({
                follower: profile as ProfileView,
                posts: posts.reverse(),
                langStr,
            });
            diaryResult = await generateUserDiaryResilient(
                userinfo,
                { dayContext, mediaReference, surface: "bsky", label: `[${userDid}][DIARY]` },
            );
        } catch (e: any) {
            console.error(`[ERROR][${userDid}][DIARY] Failed to generate diary after up to ${DIARY_MAX_ATTEMPTS} attempts:`, e.message);
            return "failed";
        }

        const text_bot = diaryResult.diary;

        console.log(`[INFO][${userDid}] generating image...`);
        // 画像の日付は日記の日付（サーバーの時計ではなく、その人の区切りで決まった日）。
        const [year, month, day] = diaryDate.split("-").map(Number);
        const formattedDate = `${year}/${month}/${day}`;
        const buffer = await textToImageBufferWithBackground(text_bot + `\n\n${formattedDate}`);
        const { blob } = (await agent.uploadBlob(buffer, { encoding: "image/png" })).data;

        // 区切りの時刻は人ごとに違う（18時〜翌6時）ので、「今日」「おやすみ」のような
        // 時刻に縛られる言葉は使わず、日付で言う。
        const englishDate = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            timeZone: "UTC",
        });
        let replyText = (langStr === "日本語") ?
            `${profile.displayName}さんへ、${month}月${day}日の日記をまとめたよ! 画像を貼るので見てみてね。` :
            `${profile.displayName}, I wrote your diary for ${englishDate}! Check the image.`;

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

        console.info(`[INFO][DIARY] diary_published surface=bsky subject=${userDid} date=${diaryDate}`);
        console.log(`[INFO][${userDid}] finish to process diary (${diaryDate})`);
        return "done";
    } catch (e: any) {
        if (e?.error === "BlockedByActor" || e?.error === "AccountDeactivated" || e?.error === "AccountTakedown") {
            console.log(`[INFO][${userDid}] ${e.error}, skipping diary`);
            return "skipped";
        }
        console.error(`[ERROR][${userDid}] an error occured in diary process:`, e);
        return "failed";
    }
}

function runUserDiary(job: DiaryJob) {
    processUserDiary(job)
        .catch((e) => {
            console.error(`[ERROR][${job.did}]`, e);
            return "failed" as const;
        })
        .then((outcome) => finishDiaryJob(job, outcome))
        .catch((e) => console.error(`[ERROR][${job.did}] failed to finish diary job`, e));
}

/**
 * 日記モードの人の、Bluesky の最新の投稿（返信以外）の言語を記録する。Nagi を使っていない人の
 * 日記のタイムゾーンは、これから推定する（database の guessDiaryTimezones）。
 * Bluesky の API を1人ずつ呼ぶので、日記の見回りより間隔を空ける。
 */
async function refreshBlueskyDiaryLangs() {
    const usersWithDiaryMode = await MemoryService.getFollowersByColumn("is_diary", 1);
    if (!usersWithDiaryMode?.length) return;
    const communityMemberSet = new Set(await MemoryService.getCommunityMembersOrDeveloper());
    const eligibleUsers = usersWithDiaryMode.filter((user) => communityMemberSet.has(user.did));
    console.log(`[INFO][DIARY] subbed-follower && is_diary: ${eligibleUsers.length}`);

    for (const user of eligibleUsers) {
        const userDid = user.did as string;
        try {
            const feed = await getDaysAuthorFeed(userDid);
            const latestPost = feed.find((item) => !item.reply)?.post;
            const lang = (latestPost?.record as Record | undefined)?.langs?.[0];
            if (lang && lang !== user.diary_bsky_lang)
                await MemoryService.updateFollower(userDid, "diary_bsky_lang", lang);
        } catch (e: any) {
            if (["AccountDeactivated", "AccountTakedown", "BlockedByActor"].includes(e?.error)) continue;
            console.error(`[ERROR][${userDid}] failed to refresh diary language:`, e);
        }
    }
}

/** 書く面を決め（Nagi 側と同じ関数）、Bluesky に決まった行を取って書く。 */
async function scanBlueskyDiaries() {
    await decideDiaryJobs();
    for (const job of await claimDiaryJobs("bsky")) {
        console.log(`[INFO][${job.did}] writing Bluesky diary for ${job.window.date} (attempt ${job.attempts})`);
        runUserDiary(job);
    }
}

/**
 * 起動時に呼ぶ。日記の見回りは5分ごと、言語の記録は1時間ごと。
 * 区切りの時刻は人ごとに違う（Nagi で本人が教えたもの。無ければ言語から推定した22時）。
 */
export async function scheduleAllUserDiaries() {
    console.log("[INFO][DIARY] start diary scan");

    startWorkerLoop({
        name: "BSKY_DIARY",
        intervalMs: SCAN_INTERVAL_MS,
        tick: scanBlueskyDiaries,
    });
    startWorkerLoop({
        name: "BSKY_DIARY_LANG",
        intervalMs: LANG_REFRESH_INTERVAL_MS,
        tick: refreshBlueskyDiaryLangs,
    });

    await refreshBlueskyDiaryLangs().catch((e) => console.error("[ERROR][DIARY] language refresh failed", e));
    await scanBlueskyDiaries();
}
