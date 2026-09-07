import {
  MemoryService,
  ScheduledPostService,
  type ScheduledPostImage,
  type ScheduledPostPublishRequest,
  type ScheduledPostResult,
} from "@bsky-affirmative-bot/clients";
import {
  generateGoodNight,
  generateImage,
  generateQuestion,
  MyMoodSongGenerator,
  searchYoutubeLink,
  WhimsicalPostGenerator,
} from "@bsky-affirmative-bot/bot-brain";
import retry from "async-retry";
import {
  botDayRange,
  isInBotDayRange,
  type BotContext,
} from "@bsky-affirmative-bot/shared-configs";
import { recordBotMemoryUsages } from "@bsky-affirmative-bot/database";
import {
  getDailyTopPostCandidate,
  parseDailyTopPostSource,
} from "./DailyTopPostProvider.js";
import { fetchDisplayName } from "./displayName.js";
import { jstDateString as jstDate } from "./jstDate.js";
import { getRecentNewsArticleIds, recordRecentNewsArticle } from "./whimsicalPostNewsHistory.js";
import { buildGoodNightPostTexts, buildWhimsicalPostTexts } from "./scheduledPostContent.js";
import {
  buildBotMemoryTopicQuery,
  retrieveBotMemoryTopics,
} from "./botMemoryTopics.js";

/**
 * 配信先の blob 上限に対する余裕を見た値。
 * pub.leaflet の coverImage は 1,000,000 バイト上限で、Nagi も同じ桁。
 * ぴったりを狙うと符号化の誤差で弾かれるので少し下げる。
 */
const IMAGE_MAX_BYTES = 950_000;

/**
 * 画像の材料に添える「今日あったこと」。
 *
 * **おやすみポストの本文だけでは絵が毎日「夜・寝室・目を閉じた botたん」になる。**
 * postGoodNight は Sleep ステータスへ遷移した瞬間に発火するので `currentMood` は必ず
 * 就寝中の描写になり、本文プロンプトの冒頭も「あなたはこれから就寝します」。本文が
 * 寝室に寄るのは構造上の必然で、その本文だけを渡せば絵もそこへ引っ張られる。
 *
 * ここで足すのは **記録済みの事実だけ**（`BotContext.recentActivities`）で、要約のための
 * LLM 呼び出しはしない。別の要約を作らせると本文と絵が食い違う、という元の判断は保つ。
 *
 * bot日（4時始まり）で絞るのは、深夜0〜3時のおやすみポストで「昨日の夜」を拾わないため。
 */
export function todayActivityLines(botContext: BotContext | undefined, now: Date): string {
  const range = botDayRange(now);
  const activities = (botContext?.recentActivities ?? [])
    .filter((item) => {
      const at = new Date(item.at);
      return !Number.isNaN(at.getTime()) && isInBotDayRange(at, range);
    })
    // 連続する同一行動は潰す。同じ行動が並ぶと、そこが「今日いちばんの場面」に見える。
    .filter((item, index, items) => index === 0 || items[index - 1].activity !== item.activity);
  if (activities.length === 0) return "";

  const lines = activities.map((item) => {
    const at = new Date(item.at);
    const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
    const time = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
    return `- ${time} ${item.activity}`;
  });
  return `\n\n### 今日あったこと（記録された事実・古い順）\n${lines.join("\n")}\n`;
}

/**
 * その日のおやすみポストに添える絵を1枚作る。
 *
 * 入力はおやすみポストの本文＋今日の行動履歴。本文は**その日の出来事とユーザーとの会話から
 * 印象に残ったことを botたん自身がまとめた文**なので絵の主題として妥当だが、本文だけだと
 * 就寝の枠に引っ張られる（`todayActivityLines` のコメント参照）。
 *
 * 失敗しても null が返るだけで、おやすみポストは絵なしで出る。
 */
async function buildGoodNightImage(
  sourceText: string,
  botContext?: BotContext,
): Promise<ScheduledPostImage | undefined> {
  const generated = await generateImage(
    `${sourceText}${todayActivityLines(botContext, new Date())}`,
    IMAGE_MAX_BYTES,
  );
  if (!generated) return undefined;
  return {
    dataBase64: generated.data.toString("base64"),
    mimeType: generated.mimeType,
    width: generated.width,
    height: generated.height,
    // 読み上げ環境向け。絵の出どころが本文なので、本文の冒頭を添えるのが一番正確。
    alt: `全肯定botたんが今日のできごとを描いた絵。${sourceText.slice(0, 100)}`,
  };
}

const whimsicalPostGenerator = new WhimsicalPostGenerator();
const moodSongGenerator = new MyMoodSongGenerator();
let isJapanesePost = true;

async function publish(request: ScheduledPostPublishRequest) {
  return ScheduledPostService.publish(request);
}

export async function recordScheduledPostMemoryUsage(
  results: Partial<Record<"bsky" | "nagi", ScheduledPostResult>>,
  documentIds: number[],
  record: typeof recordBotMemoryUsages = recordBotMemoryUsages,
) {
  if (Object.keys(results).length === 0 || documentIds.length === 0) return false;
  await record(
    documentIds,
    "scheduled_post",
    results.bsky?.uri ?? results.nagi?.uri,
  );
  return true;
}

export async function getYoutubeLiveForWhimsical(
  load: typeof MemoryService.getTodayYoutubeLiveBroadcast =
    () => MemoryService.getTodayYoutubeLiveBroadcast(),
) {
  try {
    return await load();
  } catch (error) {
    // DBパッケージ側もnullへフォールバックするが、差し替えや版ずれでも投稿を止めない。
    console.error("[WARN][YOUTUBE_LIVE] Failed to prepare whimsical candidate", error);
    return null;
  }
}

export async function postMorning(botContext?: BotContext) {
  const { textJa, textEn, theme } = await generateQuestion(botContext);
  const hashtags = "#全肯定質問コーナー #BottansQuestion";
  const results = await publish({
    kind: "morning",
    contentByTarget: {
      bsky: { text: `${textJa}\n\n${textEn}\n\n${hashtags}` },
      // Nagi は日本語で投稿し、英語版は Gemini が作ったこの textEn を翻訳キャッシュへ
      // 投入する（機械翻訳させない）。ハッシュタグは日本語側と揃える。
      nagi: {
        text: `${textJa}\n\n${hashtags}`,
        langs: ["ja"],
        translations: [{ lang: "en", text: `${textEn}\n\n${hashtags}` }],
      },
    },
  });
  if (results.bsky) {
    await MemoryService.setQuestionState(results.bsky.uri, theme);
  }
}

export async function postWhimsical(currentMood: string, botContext?: BotContext) {
  const langStr = isJapanesePost ? "日本語" : "English";
  const excludedNewsArticleIds = isJapanesePost
    ? await getRecentNewsArticleIds()
    : undefined;
  let userReplies: string[] | null = null;
  try {
    userReplies = await MemoryService.getUnreadReplies();
  } catch (error) {
    console.error("Failed to get unread replies", error);
  }

  let memoryCandidates: Awaited<ReturnType<typeof retrieveBotMemoryTopics>> | undefined;
  try {
    const query = buildBotMemoryTopicQuery({
      currentMood,
      botContext,
      unreadReplies: userReplies ?? undefined,
    });
    memoryCandidates = await retrieveBotMemoryTopics({ query });
  } catch (error) {
    // RAGは定期投稿の追加材料。障害時は従来の未読リプライ経路だけで生成する。
    console.error("[WARN][BOT_MEMORY] Failed to retrieve scheduled-post topics", error);
  }

  let giftContext: { content: string; displayName: string; type: "used" } | undefined;
  let giftIdToUpdate: number | undefined;
  if (Math.random() < 0.2) {
    const oldGift = await MemoryService.getRandomOldGift();
    if (oldGift) {
      giftContext = {
        content: oldGift.content,
        displayName: await fetchDisplayName(oldGift.did),
        type: "used",
      };
      giftIdToUpdate = oldGift.id;
    }
  }

  const newShort = await MemoryService.getNewYoutubeShort();
  const youtubeLive = await getYoutubeLiveForWhimsical();
  const generated = await retry(async () => {
    const result = await whimsicalPostGenerator.generate({
      langStr,
      currentMood,
      userReplies: userReplies ?? undefined,
      memoryCandidates,
      giftContext,
      youtubeShortUrl: newShort?.url,
      youtubeShortTitle: newShort?.title ?? undefined,
      youtubeLive: youtubeLive
        ? {
            url: youtubeLive.url,
            scheduledStartAt: youtubeLive.scheduledStartAt,
            scheduledEndAt: youtubeLive.scheduledEndAt,
          }
        : undefined,
      excludedNewsArticleIds,
      botContext,
    });
    if (!result.textJa || !result.textEn) throw new Error("Whimsical post generation returned incomplete text");
    return result;
  }, { retries: 3 });

  let song = { title: "Unknown", artist: "Unknown" };
  let songUrl: string | undefined;
  try {
    songUrl = await retry(async () => {
      song = await moodSongGenerator.generate(currentMood, langStr);
      const url = await searchYoutubeLink(`${song.artist} ${song.title}`);
      if (!url) throw new Error("Youtube URL not found");
      return url;
    }, { retries: 3 });
  } catch (error) {
    console.error("[ERROR] Failed to resolve mood song:", error);
  }

  const songSuffix = songUrl ? songUrl : "(Not found in Youtube...)";
  const moodSong = `MyMoodSong:\n${song.title} - ${song.artist}\n${songSuffix}`;
  const texts = buildWhimsicalPostTexts({
    textJa: generated.textJa,
    textEn: generated.textEn,
    moodSong,
    selectedNewsUrl: generated.selectedNewsUrl,
  });
  const results = await publish({
    kind: "whimsical",
    contentByTarget: {
      bsky: { text: isJapanesePost ? texts.bskyJa : texts.bskyEn },
      nagi: {
        text: texts.nagiJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: texts.nagiEn }],
      },
    },
  });
  const published = Object.keys(results).length > 0;

  if (published) {
    if (giftIdToUpdate !== undefined) await MemoryService.updateGiftStatus(giftIdToUpdate, "used");
    if (newShort && generated.usedYoutubeShort) await MemoryService.updateYoutubeShortStatus(newShort.id, "posted");
    if (generated.selectedNewsArticleId) {
      await recordRecentNewsArticle(generated.selectedNewsArticleId);
    }
    await recordScheduledPostMemoryUsage(
      results,
      generated.selectedMemoryDocumentIds,
    ).catch((error) =>
      console.error("[WARN][BOT_MEMORY] Failed to record scheduled-post usage", error),
    );
  }

  // 未読リプライの消費・言語カウント・言語トグルはいずれも Bluesky 投稿に紐づくため、
  // 他ターゲットだけが成功した場合に進めてはならない。
  if (results.bsky) {
    await MemoryService.setWhimsicalPostRoots([results.bsky.uri]);
    await MemoryService.clearReplies();
    await MemoryService.incrementLang(langStr as any);
    isJapanesePost = !isJapanesePost;
  }
}

export async function postGoodNight(currentMood: string, botContext?: BotContext) {
  let currentFollowers = 0;
  try {
    const actor = process.env.BSKY_DID;
    const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor || "")}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const profile = await response.json() as { followersCount?: number };
    currentFollowers = profile.followersCount ?? 0;
  } catch (error) {
    console.error("[ERROR] Failed to fetch Bot follower count:", error);
  }

  const lastFollowers = await MemoryService.getBotState("last_follower_count");
  let followerMilestone: number | undefined;
  if (typeof lastFollowers === "number" && currentFollowers > 0) {
    const previous = Math.floor(lastFollowers / 1000);
    const current = Math.floor(currentFollowers / 1000);
    if (current > previous) followerMilestone = current * 1000;
  }

  const candidate = await getDailyTopPostCandidate(
    parseDailyTopPostSource(process.env.GOOD_NIGHT_TOP_POST_SOURCE),
  );
  try {
    if (!candidate) {
      console.log("[INFO] No valid top post found for good-night post.");
      return;
    }

    const todayGifts = await MemoryService.getTodayNewGifts();
    const giftCandidates = todayGifts.length > 0
      ? await Promise.all(todayGifts.map(async (gift: any) => ({
          id: gift.id,
          content: gift.content,
          displayName: await fetchDisplayName(gift.did),
        })))
      : undefined;

    // 日英の片方でも欠けたら投稿しない。textEn が空のまま通すと Nagi 側へ英訳が
    // seed されず、日英が分かれないまま公開されてしまう（2026-09-05 の事故）。
    // postWhimsical と同じく、3回とも駄目ならその日のおやすみポストは出さない。
    const generated = await retry(async () => {
      const result = await generateGoodNight({
        topFollower: candidate.profile,
        topPost: candidate.text,
        topPostNetwork: candidate.network,
        currentMood,
        followerMilestone,
        giftCandidates,
        botContext,
      });
      if (!result.textJa || !result.textEn) {
        throw new Error("Good-night post generation returned incomplete text");
      }
      return result;
    }, { retries: 3 });

    const texts = buildGoodNightPostTexts({
      textJa: generated.textJa,
      textEn: generated.textEn,
      sourcePost: { network: candidate.network, uri: candidate.uri },
    });

    // 絵は1日1枚ここだけで作る。本文が確定してから作るので、絵と文がずれない。
    const image = await buildGoodNightImage(generated.textJa, botContext);

    const results = await publish({
      kind: "good-night",
      contentByTarget: {
        // **Bluesky の投稿には絵を出さない。** ここで image を渡しているのは、
        // Leaflet の日記が Bluesky 側のおやすみポストの副作用として発行されており、
        // その日記のヘッダー画像に使うため。bsky_bot_server は image を
        // postContinuous へ渡さない（ScheduledPostFeature.ts のコメント参照）。
        bsky: { text: texts.bsky, ...(image ? { image } : {}) },
        nagi: {
          text: texts.nagiJa,
          langs: ["ja"],
          translations: [{ lang: "en", text: texts.nagiEn }],
          ...(image ? { image } : {}),
        },
      },
      sourcePost: { network: candidate.network, uri: candidate.uri, cid: candidate.cid },
    });
    if (results.bsky) await MemoryService.setWhimsicalPostRoots([results.bsky.uri]);

    if (giftCandidates?.length && Object.keys(results).length > 0) {
      const selected = giftCandidates[generated.selectedGiftIndex ?? 0] ?? giftCandidates[0];
      await MemoryService.updateGiftStatus(selected.id, "introduced");
    }
  } finally {
    if (currentFollowers > 0) await MemoryService.setBotState("last_follower_count", currentFollowers);
    // リセットで日次カウンタが消える前に、その日の確定値を1行残す。
    // ここが bot-tan.com の推移グラフの唯一の供給源なので、失敗してもリセット自体は
    // 続けられるよう例外を飲む（1日欠けるだけで済ませる）。
    await snapshotDailyMetrics(currentFollowers).catch((error) =>
      console.error("[ERROR][BIO] Failed to snapshot daily metrics:", error),
    );
    await MemoryService.resetDailyStats();
    await MemoryService.clearPosts();
  }
}

/**
 * 日次リセットの直前に呼ぶ。Bluesky / Nagi / 共通をひとまとめの jsonb で残すので、
 * 指標が増えてもテーブル定義は変えなくてよい。
 */
async function snapshotDailyMetrics(currentFollowers: number) {
  const [daily, nagi] = await Promise.all([
    MemoryService.getDailyStats(),
    MemoryService.getNagiStats(),
  ]);

  // クラウド（Gemini）とローカル（Ollama）は別カウンタ。合算しない。
  const rpd = daily.rpd ?? 0;
  const rpdError = daily.rpdError ?? 0;
  const requests = rpd + rpdError;
  const localRpd = daily.localRpd ?? 0;
  const localRpdError = daily.localRpdError ?? 0;
  const localRequests = localRpd + localRpdError;

  await MemoryService.saveDailyMetrics(jstDate(), {
    bsky: {
      currentFollowers,
      followers: daily.followers ?? 0,
      likes: daily.likes ?? 0,
      affirmations: daily.affirmationCount ?? 0,
      affirmedUsers: daily.uniqueAffirmationUserCount ?? 0,
      fortune: daily.fortune ?? 0,
      cheer: daily.cheer ?? 0,
      analysis: daily.analysis ?? 0,
      dj: daily.dj ?? 0,
      anniversary: daily.anniversary ?? 0,
      answer: daily.answer ?? 0,
    },
    nagi: {
      totalUsers: nagi.totalUsers,
      totalReactions: nagi.totalReactions,
      totalPosts: nagi.totalPosts,
      totalChannels: nagi.totalChannels,
    },
    common: {
      // aiRequests は移行前からクラウド(Gemini)のみを数えている。推移の意味を変えない
      // ため、ローカル分は合算せず別キーで足す。
      aiRequests: rpd,
      aiErrors: rpdError,
      aiErrorRate: requests > 0 ? rpdError / requests : 0,
      localAiRequests: localRpd,
      localAiErrors: localRpdError,
      localAiErrorRate: localRequests > 0 ? localRpdError / localRequests : 0,
    },
  });
}
