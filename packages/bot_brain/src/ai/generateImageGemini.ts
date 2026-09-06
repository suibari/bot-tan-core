import { PartListUnion } from "@google/genai";
import * as fs from "node:fs";
import { resolveAiImageRoute } from "@bsky-affirmative-bot/shared-configs";
import { gemini } from "./googleClient.js";

/**
 * 凍結前の Gemini 画像生成。**切り戻し専用**なので挙動を変えていない。
 *
 * 2025-09 に費用の問題で止めた経路（ea19880 / ccf265d）。ローカル生成が使えないときに
 * `AI_ROUTE_BSKY_IMAGE=image-gemini` を明示したときだけ通る。自動フォールバックはしない
 * （黙って課金が再開し、しかも絵は出続けるので気付けない）。
 *
 * ローカル版と違い、参照画像そのものをモデルに見せてキャラの同一性を担保している。
 * SDXL に同じことはできないので、ローカル側は固定タグと LoRA で代替している。
 */
export async function generateImageGemini(mood: string): Promise<Buffer | null> {
  const prompt =
    `Please create your illustration using the attached character design as a reference.
  The 1st attached character's name is "Fully-Affirmative Bot-tan".
  The 2nd attached character's name is "Latte-chan".
  Please faithfully maintain the following characteristics. You may change the outfit to suit the scene.
  * Fully-Affirmative Bot-tan
    - Light blue hair, long hair, ahoge
    - Thick eyebrows, squinting eyes
  * Morpho
    - a Samoyed dog
    - not show up at school
  * Latte-chan
    - pink hair, long princess hair, red ribbon
    - nekomimi
    - green eyes
    - maid clothes
    - a red hairpin with the kanji character "ten (heaven)"
    - white cat tail
    - not show up at school
  Rules: 
  * **Be careful not to lose balance between the body and face.**
  * **Do not include text in images**
  Scene: ${mood}`;

  const contents: PartListUnion = [
    { text: prompt },
    {
      inlineData: {
        mimeType: "image/png",
        data: fs.readFileSync("./img/bot-tan-concept.png").toString("base64"),
      },
    },
    {
      inlineData: {
        mimeType: "image/png",
        data: fs.readFileSync("./img/latte-chan-concept.png").toString("base64"),
      },
    },
  ];

  const route = resolveAiImageRoute("BSKY_IMAGE");
  const response = await gemini.models.generateContent({
    model: route.model!,
    contents,
  });

  for (const part of response.candidates?.[0].content?.parts || []) {
    if (part.text) {
      console.log("[INFO][IMGGEN] Generated image prompt:", part.text);
    } else if (part.inlineData?.data) {
      console.log("[INFO][IMGGEN] Generated image received.");
      return Buffer.from(part.inlineData.data, "base64");
    }
  }
  return null;
}
