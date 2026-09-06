import type { ScheduledPostImage, ScheduledPostRequest, ScheduledPostResult } from "@bsky-affirmative-bot/clients";
import { NAGI, type NagiImage } from "@bsky-affirmative-bot/nagi-lexicon";
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
async function uploadScheduledImage(image: ScheduledPostImage): Promise<NagiImage | null> {
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

export async function publishScheduledPost(request: ScheduledPostRequest): Promise<ScheduledPostResult> {
  // 画像は先に上げておく。リトライの中で毎回上げ直すと、失敗するたびに孤児 blob が増える。
  const nagiImage = request.image ? await uploadScheduledImage(request.image) : null;

  return retry(async () => {
    // おやすみポストは Nagi の投稿を引用することがある。引用の embed は images も持てるので、
    // 引用と絵は両立する。引用が無いときは #images をそのまま使う。
    const quote =
      request.kind === "good-night" && request.sourcePost?.network === "nagi"
        ? { uri: request.sourcePost.uri, cid: request.sourcePost.cid }
        : null;
    const embed = quote
      ? {
          $type: `${NAGI.post}#quote` as const,
          record: quote,
          ...(nagiImage ? { images: [nagiImage] } : {}),
        }
      : nagiImage
        ? { $type: `${NAGI.post}#images` as const, images: [nagiImage] }
        : undefined;

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
