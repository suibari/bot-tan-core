import { resolveAiImageRoute } from "@bsky-affirmative-bot/shared-configs";
import {
  buildImagePrompt,
  planImageScene,
  type ImageScenePurpose,
  type ImageStyle,
} from "./buildImagePrompt.js";
import { generateImageGemini } from "./generateImageGemini.js";
import { isImageGenConfigured, requestImage, type GeneratedImage } from "./imageGenClient.js";
import { applyBotSignature } from "./botSignature.js";

/**
 * 絵を描ける状態か。お絵描き機能は、描けないときに依頼の判定（LLM）ごと回さないためにこれを見る。
 * Gemini ルートを明示しているときはサイドカーが無くても描ける。
 */
export function isImageGenerationAvailable(): boolean {
  return resolveAiImageRoute("BSKY_IMAGE").provider === "gemini" || isImageGenConfigured();
}

/**
 * botたんが「その日の印象的な出来事」を1枚の絵にする。おやすみポストに添える。
 *
 * ## 経緯
 * 2025-09 に Gemini の画像生成を費用の問題で止めて以来、呼び出し元ごと凍結していた
 * （ea19880 / ccf265d）。GPU 機に自前の生成サイドカーを置いたので復活させた。
 *
 * ## 3段構え
 *  1. 日本語の情景文（絵文字・話し言葉まじり）を、常駐している gemma へ渡して
 *     シーンの構造化タグにする。SDXL 系の CLIP は日本語をほぼ読めないので、この層が
 *     無いと何を描いてほしいかが伝わらない。英訳しても読まない（実測）。
 *  2. タグにキャラ固定部を **TypeScript 側の定数として** 連結する。外見を LLM に
 *     書かせないのは、揺れると同一性が壊れるため。2キャラなら領域プロンプトを組む。
 *  3. GPU 機のサイドカーへ HTTP。
 *
 * ## 失敗しても throw しない
 * 呼び出し元はおやすみポストの経路。ここで例外を投げると投稿そのものが飛ぶ。
 * **絵は無くてもおやすみポストは成立する**ので、null を返して呼び出し側に判断させる。
 *
 * ## Gemini へ自動フォールバックしない
 * 費用で止めた経路なので、AI_ROUTE_BSKY_IMAGE=image-gemini を明示したときしか使わない。
 * 自動で戻すと、サイドカーが落ちている間ずっと課金され、しかも絵は出続けるので気付けない。
 *
 * @param sourceText その日の出来事やユーザーとの会話から、印象に残ったことを書いた文。
 *                   おやすみポストの本文をそのまま渡す使い方を想定している。
 * @param maxBytes   配信先の blob 上限。Leaflet の coverImage と Nagi はどちらも
 *                   1,000,000 バイトなので、余裕を見た値を呼び出し側が渡す。
 * @param options.purpose 材料の種類。既定はおやすみポスト。お絵描き（DrawingFeature /
 *                   nagiDrawingGift）は "picture" で、材料は「描いてほしい絵」の記述になる。
 */
export async function generateImage(
  sourceText: string,
  maxBytes?: number,
  options: { purpose?: ImageScenePurpose } = {},
): Promise<GeneratedImage | null> {
  const route = resolveAiImageRoute("BSKY_IMAGE");

  try {
    if (route.provider === "gemini") {
      const data = await generateImageGemini(sourceText);
      return data
        ? await applyBotSignature({ data, mimeType: "image/png", width: 0, height: 0 }, maxBytes)
        : null;
    }

    if (!isImageGenConfigured()) {
      console.log("[INFO][IMGGEN] IMAGEGEN_BASE_URL が未設定なので画像生成をしない。");
      return null;
    }

    const plan = await planImageScene(sourceText, options.purpose);
    if (!plan) return null;

    const style = (process.env.IMAGEGEN_STYLE as ImageStyle) || "crayon-diary";
    const built = buildImagePrompt(plan, style);
    // シーンが薄いときは buildImagePrompt が null を返す。**そのまま描かせてはいけない。**
    // キャラ固定タグだけの同じプロンプトになり、同じ絵が毎日出る（PoC で3枚重複した）。
    if (!built) return null;

    console.log(`[INFO][IMGGEN] style=${style} regions=${built.regions.length} prompt=${built.prompt}`);
    const generated = await requestImage({
      prompt: built.prompt,
      negativePrompt: built.negativePrompt,
      width: built.width,
      height: built.height,
      regions: built.regions,
      loras: built.loras,
      ...(maxBytes ? { maxBytes } : {}),
    });
    return generated ? await applyBotSignature(generated, maxBytes) : null;
  } catch (error) {
    console.error("[ERROR][IMGGEN] 画像生成に失敗した。絵は添えずに進める:", error);
    return null;
  }
}
