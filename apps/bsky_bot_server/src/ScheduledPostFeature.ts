import type { AppBskyEmbedExternal, BlobRef } from "@atproto/api";
import type {
  ScheduledPostExternal,
  ScheduledPostImage,
  ScheduledPostNightVideo,
  ScheduledPostRequest,
  ScheduledPostResult,
} from "@bsky-affirmative-bot/clients";
import { LeafletDiaryService, MemoryService } from "@bsky-affirmative-bot/clients";
import { shrinkImageToBytes } from "@bsky-affirmative-bot/bot-brain";
import { safeFetch } from "@bsky-affirmative-bot/shared-configs";
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

/** 夜の動画をリポストする。失敗してもおやすみ本文は投稿する。 */
async function introduceNightVideo(
  video: ScheduledPostNightVideo,
): Promise<{ uri: string; cid: string } | undefined> {
  try {
    return await repost(video.uri, video.cid);
  } catch (error) {
    console.error("[ERROR][GOOD_NIGHT] Failed to repost night video:", error);
    return undefined;
  }
}

/** app.bsky.embed.external の thumb は 1,000,000 バイトまで。符号化の誤差ぶん少し下げる。 */
const EXTERNAL_THUMB_MAX_BYTES = 950_000;
/** 縮める前に受け取る上限。記事の OGP 画像は数 MB のこともあるが、それ以上は読まない。 */
const EXTERNAL_THUMB_FETCH_LIMIT = 8_000_000;

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("thumbnail body is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error("thumbnail exceeds fetch limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * リンクカード（気まぐれポストで紹介する Nagi のニュース）を組み立てる。
 * サムネは記事の画像を取って blob にする。取れなければサムネ無しのカードで出す。
 */
export async function buildScheduledExternal(
  external: ScheduledPostExternal,
  dependencies: {
    fetchImage?: typeof safeFetch;
    upload?: (data: Buffer, mimeType: string) => Promise<BlobRef>;
  } = {},
): Promise<AppBskyEmbedExternal.External> {
  const card: AppBskyEmbedExternal.External = {
    uri: external.uri,
    title: external.title,
    description: external.description,
  };
  if (!external.thumbUrl) return card;
  try {
    const response = await (dependencies.fetchImage ?? safeFetch)(external.thumbUrl);
    if (!response.ok) throw new Error(`thumbnail HTTP ${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const raw = await readLimited(response, EXTERNAL_THUMB_FETCH_LIMIT);
    const image = await shrinkImageToBytes(raw, mimeType, EXTERNAL_THUMB_MAX_BYTES);
    if (!image) throw new Error("thumbnail could not fit the blob limit");
    const upload = dependencies.upload ??
      (async (data: Buffer, encoding: string) => (await agent.uploadBlob(data, { encoding })).data.blob);
    return { ...card, thumb: await upload(image.data, image.mimeType) };
  } catch (error) {
    console.warn(`[WARN][SCHEDULED_POST] Link card thumbnail unavailable: ${external.thumbUrl}`, error);
    return card;
  }
}

export async function publishScheduledPost(request: ScheduledPostRequest): Promise<ScheduledPostResult> {
  let nightVideoRepost: { uri: string; cid: string } | undefined;
  if (request.kind === "good-night") {
    if (request.nightVideo) {
      nightVideoRepost = await introduceNightVideo(request.nightVideo);
    }
    await publishLeafletDiaries(request.image);
  }

  // ★ request.image を postContinuous へ渡してはいけない。
  //
  // botたんが1日1枚描く絵は、**Nagi と Leaflet には出すが Bluesky には出さない**という
  // 決めになっている。この経路が image を受け取るのは、Leaflet の日記が Bluesky 側の
  // おやすみポストの副作用として発行されているからで、Bluesky の投稿に付けるためではない。
  // 「image を持っているのに使っていない」ように見えるが、使わないことが仕様。
  // カードはリトライの外で一度だけ作る（失敗のたびに孤児 blob を増やさない）。
  const external = request.external ? await buildScheduledExternal(request.external) : undefined;
  const result = await retry(
    () => postContinuous(request.text, undefined, undefined, undefined, external),
    {
      retries: 2,
      onRetry: (error, attempt) => {
        console.warn(`[WARN][SCHEDULED_POST] Bluesky retry ${attempt}:`, error);
      },
    },
  );
  return nightVideoRepost ? { ...result, nightVideoRepost } : result;
}
