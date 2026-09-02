import type { Part } from "@google/genai";
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
 * 肯定返信用の画像入力を、説明ラベルと画像Partの組で構築する。
 * 直接添付は欠けたまま返信しない。補助画像は取得失敗時のみスキップする。
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
      parts.push(
        { text: affirmativeImageLabel(index, origin, langStr) },
        {
          inlineData: {
            mimeType: image.mimeType,
            data: Buffer.from(imageArrayBuffer).toString("base64"),
          },
        },
      );
      stats.succeeded++;
      stats.byOrigin[origin].succeeded++;
    } catch (cause) {
      if (origin === "direct") {
        throw new Error(
          `Failed to fetch directly attached image ${index}; retrying the reply without omitting it`,
          { cause },
        );
      }
      stats.skipped++;
      stats.byOrigin[origin].skipped++;
      console.warn(
        `[WARN][GEMINI] Skipping unavailable ${origin} image ${index}`,
        cause,
      );
    }
  }

  return { parts, stats };
}
