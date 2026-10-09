import type {
  ScheduledPostImage,
  ScheduledPostNightVideo,
  ScheduledPostRequest,
  ScheduledPostResult,
} from "@bsky-affirmative-bot/clients";
import { NAGI, type NagiImage, type NagiPost, type NagiVideo } from "@bsky-affirmative-bot/nagi-lexicon";
import retry from "async-retry";
import { agent } from "./agent.js";
import { publishNagiPost } from "./nagiPost.js";
import { clipNagiPostText } from "./nagiPostText.js";
import { seedNagiTranslations } from "./appviewInternal.js";

/**
 * 添付画像を blob として上げ、レコードに載る JSON 形へ直す。
 *
 * uploadBlob が返すのは BlobRef クラスで、ref は CID、$type は toJSON でしか付かない。
 * nagiLinkCards の thumb と同じ変換をここでもやる。
 *
 * 失敗しても投稿自体は通す。**絵はおやすみポストの飾りで、本文のほうが本体**なので、
 * 画像の都合で投稿を落とさない。
 */
export async function uploadScheduledImage(image: ScheduledPostImage): Promise<NagiImage | null> {
  try {
    const data = Buffer.from(image.dataBase64, "base64");
    const { blob } = (await agent.uploadBlob(data, { encoding: image.mimeType })).data;
    return {
      image: {
        $type: "blob",
        ref: { $link: blob.ref.toString() },
        mimeType: blob.mimeType,
        size: blob.size,
      },
      alt: image.alt,
      ...(image.width && image.height
        ? { aspectRatio: { width: image.width, height: image.height } }
        : {}),
    };
  } catch (error) {
    console.warn("[WARN][SCHEDULED_POST] Nagi への画像アップロードに失敗した:", error);
    return null;
  }
}

const BSKY_POST_URI = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;

/**
 * 夜の動画（botたんが Bluesky に投稿した動画ポスト）の blob を、Nagi の #video の形で返す。
 *
 * **動画は上げ直さない。** Bluesky と Nagi の botたんは同じアカウントなので、mp4 はすでに
 * 同じ PDS にあり、video.bsky.app での変換も済んでいる。Nagi のレコードから同じ blob を
 * 参照すれば、再生も同じ HLS になる。別アカウントの投稿だと blob が自分の PDS に無いので
 * 使わない。
 *
 * 失敗しても投稿自体は通す（絵と同じく飾りの扱い）。
 */
export async function resolveNightVideo(
  nightVideo: ScheduledPostNightVideo,
): Promise<NagiVideo | null> {
  try {
    const match = BSKY_POST_URI.exec(nightVideo.uri);
    if (!match) throw new Error(`Not a Bluesky post URI: ${nightVideo.uri}`);
    const [, repo, rkey] = match;
    const botDid = agent.session?.did ?? process.env.NAGI_BOT_DID;
    if (repo !== botDid) throw new Error(`Night video is not in the bot's repo: ${repo}`);

    const { data } = await agent.com.atproto.repo.getRecord({
      repo,
      collection: "app.bsky.feed.post",
      rkey,
    });
    const embed = (data.value as any)?.embed;
    const source =
      embed?.$type === "app.bsky.embed.video"
        ? embed
        : embed?.$type === "app.bsky.embed.recordWithMedia" &&
            embed.media?.$type === "app.bsky.embed.video"
          ? embed.media
          : undefined;
    // getRecord は blob を BlobRef（ref は CID）に復元して返す。生の JSON なら $link。
    const ref = source?.video?.ref;
    const cid = typeof ref?.$link === "string" ? ref.$link : ref?.toString();
    if (!cid || source.video.mimeType !== "video/mp4") {
      throw new Error("The night video post has no mp4 video embed");
    }
    return {
      video: {
        $type: "blob",
        ref: { $link: cid },
        mimeType: source.video.mimeType,
        size: source.video.size,
      },
      ...(typeof source.alt === "string" && source.alt ? { alt: source.alt } : {}),
      ...(source.aspectRatio?.width && source.aspectRatio?.height
        ? { aspectRatio: { width: source.aspectRatio.width, height: source.aspectRatio.height } }
        : {}),
    };
  } catch (error) {
    console.warn("[WARN][SCHEDULED_POST] 夜の動画を Nagi に載せられなかった:", error);
    return null;
  }
}

/**
 * 絵と動画は1投稿に両方載せる。両方あるときだけ #gallery（画像と動画を混ぜられる唯一の形）。
 * 並びは「絵 → 動画」。
 */
export function scheduledPostEmbed(
  image: NagiImage | null,
  video: NagiVideo | null,
): NagiPost["embed"] {
  if (image && video) {
    return {
      $type: `${NAGI.post}#gallery`,
      items: [
        { $type: `${NAGI.post}#image`, ...image },
        { $type: `${NAGI.post}#video`, ...video },
      ],
    };
  }
  if (video) return { $type: `${NAGI.post}#video`, ...video };
  if (image) return { $type: `${NAGI.post}#images`, images: [image] };
  return undefined;
}

export async function publishScheduledPost(request: ScheduledPostRequest): Promise<ScheduledPostResult> {
  // 画像は先に上げておく。リトライの中で毎回上げ直すと、失敗するたびに孤児 blob が増える。
  const nagiImage = request.image ? await uploadScheduledImage(request.image) : null;
  const nagiVideo = request.nightVideo ? await resolveNightVideo(request.nightVideo) : null;
  // 本文中のURLは共通処理でリンクカードになる。linkCards は embed と別枠なので併用できる。
  const embed = scheduledPostEmbed(nagiImage, nagiVideo);

  return retry(async () => {

    const post = await publishNagiPost({
      text: request.text,
      label: "SCHEDULED_POST",
      ...(request.langs?.length ? { langs: request.langs } : {}),
      ...(embed ? { embed } : {}),
    });
    // Gemini が本文と一緒に作った対訳を翻訳キャッシュへ入れておく。これを入れないと
    // 英語圏のユーザーには機械翻訳が表示されてしまう。日本語本文と同じ規則でクリップして
    // おかないと、訳文だけ日本語に無い内容を含むことになる。
    if (request.translations?.length) {
      void seedNagiTranslations(
        post.uri,
        request.translations.map((translation) => ({
          lang: translation.lang,
          text: clipNagiPostText(translation.text, "SCHEDULED_POST"),
        })),
      );
    }
    return post;
  }, {
    retries: 2,
    onRetry: (error, attempt) => {
      console.warn(`[WARN][SCHEDULED_POST] Nagi retry ${attempt}:`, error);
    },
  });
}
