import type {
  ScheduledPostImage,
  ScheduledPostNightVideo,
  ScheduledPostRequest,
  ScheduledPostResult,
} from "@bsky-affirmative-bot/clients";
import { LeafletDiaryService, MemoryService } from "@bsky-affirmative-bot/clients";
import retry from "async-retry";
import { agent } from "./bsky/agent.js";
import { postContinuous } from "./bsky/postContinuous.js";
import { repost } from "./bsky/repost.js";

async function publishLeafletDiaries(coverImage?: ScheduledPostImage) {
  if (!process.env.LEAFLET_USERNAME) {
    console.log("[INFO][DIARY] LEAFLET_USERNAME is not set. Skipping diary posting.");
    return;
  }

  let diaryCount = 1;
  try {
    diaryCount = (await MemoryService.getBotState("diary_count") || 0) + 1;
    await MemoryService.setBotState("diary_count", diaryCount);
  } catch (error) {
    console.error("[ERROR][DIARY] Failed to manage diary_count:", error);
  }

  for (const language of ["ja", "en"] as const) {
    try {
      await LeafletDiaryService.generateAndPostDiary(agent, diaryCount, language, coverImage);
    } catch (error) {
      console.error(`[ERROR][DIARY] Failed to publish ${language} diary:`, error);
    }
  }
}

/**
 * 夜の動画（bot-tan-youtuber が 18:00 に投稿した動画ポスト）を紹介する。
 * コメントを動画ポストへのリプライにして「動画→コメント」の1スレッドにし、
 * 動画ポストを RP してフォロワーのタイムラインへもう一度出す。
 *
 * ここが失敗しても出来事スレッドは出す（動画の紹介はおやすみポストの一部でしかない）。
 */
async function introduceNightVideo(
  video: ScheduledPostNightVideo,
): Promise<{ uri: string; cid: string } | undefined> {
  let comment: { uri: string; cid: string } | undefined;
  try {
    // postContinuous は record.reply の有無だけを見て root を決める。動画ポストは
    // スレッドの root なので reply を持たない record を渡せば足り、取得し直す必要はない。
    comment = await retry(
      () => postContinuous(video.commentText, {
        uri: video.uri,
        cid: video.cid,
        record: { $type: "app.bsky.feed.post", text: "", createdAt: new Date().toISOString() },
      }),
      { retries: 2 },
    );
  } catch (error) {
    console.error("[ERROR][GOOD_NIGHT] Failed to reply to night video:", error);
  }
  try {
    await repost(video.uri, video.cid);
  } catch (error) {
    console.error("[ERROR][GOOD_NIGHT] Failed to repost night video:", error);
  }
  return comment;
}

export async function publishScheduledPost(request: ScheduledPostRequest): Promise<ScheduledPostResult> {
  let nightVideoComment: { uri: string; cid: string } | undefined;
  if (request.kind === "good-night") {
    if (request.nightVideo) {
      nightVideoComment = await introduceNightVideo(request.nightVideo);
    }
    await publishLeafletDiaries(request.image);
  }

  // ★ request.image を postContinuous へ渡してはいけない。
  //
  // botたんが1日1枚描く絵は、**Nagi と Leaflet には出すが Bluesky には出さない**という
  // 決めになっている。この経路が image を受け取るのは、Leaflet の日記が Bluesky 側の
  // おやすみポストの副作用として発行されているからで、Bluesky の投稿に付けるためではない。
  // 「image を持っているのに使っていない」ように見えるが、使わないことが仕様。
  const result = await retry(
    () => postContinuous(request.text),
    {
      retries: 2,
      onRetry: (error, attempt) => {
        console.warn(`[WARN][SCHEDULED_POST] Bluesky retry ${attempt}:`, error);
      },
    },
  );
  return nightVideoComment ? { ...result, nightVideoComment } : result;
}
