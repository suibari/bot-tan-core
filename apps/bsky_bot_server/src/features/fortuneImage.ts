import type { FortuneResult, generateImage } from "@bsky-affirmative-bot/bot-brain";
import { textToImageBufferWithBackground, textToImageBufferWithGeneratedBackground } from "../util/canvas.js";

/** app.bsky.embed.images の blob 上限は 1,000,000 バイト。符号化の誤差ぶん下げる。 */
export const FORTUNE_IMAGE_MAX_BYTES = 950_000;
const FALLBACK_BACKGROUND = "./img/bot-tan-fortune.png";

/**
 * 画像生成は引数で受け取る。
 *
 * scripts/probeFortune.mts は bot_brain を src から読むので、ここで
 * `@bsky-affirmative-bot/bot-brain`（dist）を import すると別インスタンスになり、
 * スクリプト側で差し替えた観測先（telemetry）が効かなくなる。
 */
export type FortuneImageDeps = {
    generateImage: typeof generateImage;
    isImageGenerationAvailable: () => boolean;
};

type GeneratedBackground = NonNullable<Awaited<ReturnType<typeof generateImage>>>;

export type FortuneImage = {
    fortune: FortuneResult;
    data: Buffer;
    mimeType: string;
    /** 背景に使った生成画像。固定背景に戻ったときは undefined。 */
    background?: GeneratedBackground;
};

export function fortuneBackgroundSource(picture: string): string {
    return `### 描いてほしいと頼まれた絵\n今日の占い結果をモチーフにした絵。${picture}`;
}

/** 占い結果を題材に描いた絵を背景にする。描けなければ従来の固定背景に戻す。 */
export async function composeFortuneImage(
    fortune: FortuneResult,
    deps: FortuneImageDeps,
    logLabel: string,
): Promise<FortuneImage> {
    if (fortune.picture && deps.isImageGenerationAvailable()) {
        console.log(`[INFO][${logLabel}] Fortune background: ${fortune.picture}`);
        // generateImage は失敗しても throw せず null を返す。
        const background = await deps.generateImage(
            fortuneBackgroundSource(fortune.picture),
            FORTUNE_IMAGE_MAX_BYTES,
            { purpose: "picture" },
        );
        if (background) {
            try {
                const composed = await textToImageBufferWithGeneratedBackground(fortune.fortune, background.data, FORTUNE_IMAGE_MAX_BYTES);
                return { fortune, ...composed, background };
            } catch (error) {
                console.warn(`[WARN][${logLabel}] Failed to compose fortune background, using fixed image:`, error);
            }
        }
    }

    const data = await textToImageBufferWithBackground(fortune.fortune, FALLBACK_BACKGROUND);
    return { fortune, data, mimeType: "image/png" };
}
