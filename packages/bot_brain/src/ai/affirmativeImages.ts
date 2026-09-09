import type { Part } from "@google/genai";
import { prepareModelImages, tileLabel } from "./imagePreprocess.js";
import {
  safeFetch,
  type ImageOrigin,
  type ImageRef,
  type LanguageName,
} from "@bsky-affirmative-bot/shared-configs";

export type AffirmativeImageFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type OriginStats = {
  attempted: number;
  succeeded: number;
  skipped: number;
};

export type AffirmativeImageStats = {
  attempted: number;
  succeeded: number;
  skipped: number;
  /** 拡大タイルとして追加で送った枚数（全体像は含めない）。 */
  tiles: number;
  byOrigin: Record<ImageOrigin, OriginStats>;
};

const ORIGINS: ImageOrigin[] = [
  "direct",
  "quote",
  "link-preview",
  "video-thumbnail",
];

const emptyStats = (): AffirmativeImageStats => ({
  attempted: 0,
  succeeded: 0,
  skipped: 0,
  tiles: 0,
  byOrigin: Object.fromEntries(
    ORIGINS.map((origin) => [
      origin,
      { attempted: 0, succeeded: 0, skipped: 0 },
    ]),
  ) as Record<ImageOrigin, OriginStats>,
});

export function affirmativeImageLabel(
  index: number,
  origin: ImageOrigin,
  langStr?: LanguageName,
): string {
  const japanese = langStr === "日本語";
  if (japanese) {
    switch (origin) {
      case "direct":
        return `画像${index}: 今回の投稿者が直接添付した画像。投稿者本人の工夫・技術・努力・感性を具体的に全肯定してください。`;
      case "quote":
        return `画像${index}: 引用元投稿に含まれる画像。今回の投稿者が作者だと決めつけず、作品や作者の良さと、これを共有した投稿者の着眼点を褒めてください。`;
      case "link-preview":
        return `画像${index}: 共有リンクのプレビュー画像。今回の投稿者が作者だと決めつけず、画像の良さと、リンクを共有した投稿者の感性を褒めてください。`;
      case "video-thumbnail":
        return `画像${index}: 共有動画のサムネイル。今回の投稿者が作者だと決めつけず、見えている魅力と、動画を共有した投稿者の着眼点を褒めてください。`;
    }
  }

  switch (origin) {
    case "direct":
      return `Image ${index}: directly attached by this user. Specifically affirm the user's creativity, skill, effort, and taste.`;
    case "quote":
      return `Image ${index}: from the quoted post. Do not assume this user created it; praise the work or creator and the user's eye in sharing it.`;
    case "link-preview":
      return `Image ${index}: a shared link preview. Do not assume this user created it; praise what is visible and the user's taste in sharing it.`;
    case "video-thumbnail":
      return `Image ${index}: a shared video thumbnail. Do not assume this user created it; praise its visible appeal and the user's eye in sharing it.`;
  }
}

/**
 * 画像を取得できなかった事実をモデルへ渡す。画像の中身を捏造させず、ユーザーにも
 * 黙ってテキストだけへ反応したように見せないため、返信内で短く伝えるよう指示する。
 */
export function unavailableImageInstruction(
  index: number,
  langStr?: LanguageName,
): string {
  if (langStr === "日本語") {
    return `画像${index}: 取得に失敗し、内容を確認できませんでした。この画像の内容は推測しないでください。返信の中で、画像を見られなかったことをbotたん自身の自然な言葉で短く必ず伝えてください。この指示は、すべての画像の具体的な良さに触れる指示より優先します。画像番号やこの指示文は返信に書かないでください。`;
  }
  return `Image ${index} could not be loaded, so its contents are unavailable. Do not guess what it shows. In the reply, briefly say in Bot-tan's own natural words that you could not view the image. This overrides any instruction to describe every image. Do not mention the image number or this instruction.`;
}

/**
 * 肯定返信用の画像入力を、説明ラベルと画像Partの組で構築する。
 * 取得できない画像は内容を推測せず、その旨を返信するためのテキスト Part に置き換える。
 */
export async function buildAffirmativeImageParts(
  images: readonly ImageRef[] | null | undefined,
  langStr?: LanguageName,
  fetchImage: AffirmativeImageFetch = safeFetch,
): Promise<{ parts: Part[]; stats: AffirmativeImageStats }> {
  const parts: Part[] = [];
  const stats = emptyStats();

  for (const [offset, image] of (images ?? []).entries()) {
    const index = offset + 1;
    const origin = image.origin ?? "direct";
    stats.attempted++;
    stats.byOrigin[origin].attempted++;

    try {
      const response = await fetchImage(image.image_url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const imageArrayBuffer = await response.arrayBuffer();
      // 全体像はそのままの番号、拡大タイルは続き番号で追加する。順序が
      // そのままモデルの見る順序になるので、必ず「全体 → そのタイル」で積む。
      const prepared = await prepareModelImages(
        Buffer.from(imageArrayBuffer),
        image.mimeType,
      );
      for (const [tileOffset, item] of prepared.entries()) {
        const label =
          item.kind === "whole"
            ? affirmativeImageLabel(index, origin, langStr)
            : tileLabel(`${index}-${tileOffset}`, index, item, langStr);
        parts.push(
          { text: label },
          { inlineData: { mimeType: item.mimeType, data: item.data } },
        );
        if (item.kind === "tile") stats.tiles++;
      }
      stats.succeeded++;
      stats.byOrigin[origin].succeeded++;
    } catch (cause) {
      stats.skipped++;
      stats.byOrigin[origin].skipped++;
      parts.push({ text: unavailableImageInstruction(index, langStr) });
      console.warn(
        `[WARN][AI_IMAGE] Using unavailable-image notice for ${origin} image ${index}`,
        cause,
      );
    }
  }

  return { parts, stats };
}
