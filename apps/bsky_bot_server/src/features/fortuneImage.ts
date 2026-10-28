import type { FortuneResult } from "@bsky-affirmative-bot/bot-brain";
import { textToImageBufferWithBackground } from "../util/canvas.js";

const BACKGROUND = "./img/bot-tan-fortune.png";

export type FortuneImage = {
  fortune: FortuneResult;
  data: Buffer;
  mimeType: string;
};

/**
 * 占い本文を固定の背景に重ねる。
 *
 * 2026-09 から占い結果を題材に AI で背景を描いていたが、AI の絵は Nagi でだけ使うと決めたので
 * （2026-10-28）、それ以前の固定背景に戻した。
 */
export async function composeFortuneImage(fortune: FortuneResult): Promise<FortuneImage> {
  const data = await textToImageBufferWithBackground(fortune.fortune, BACKGROUND);
  return { fortune, data, mimeType: "image/png" };
}
