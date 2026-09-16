/**
 * 占いを1回だけ、本番と同じ生成・合成の経路で回して out/ へ保存する。
 *
 * 本番の関数（generateFortuneResult / composeFortuneImage）をそのまま import するので、
 * プロンプトやレイアウトを直したらこの確認も自動的に追随する。
 *
 * Bluesky への投稿、DB（last_uranai_at / 利用ログ / AI 呼び出しの計上）、ラベラーの
 * バッジには触れない。AI 呼び出しの計上は下で no-op に差し替えている。
 *
 * 使い方:
 *   pnpm fortune:probe
 *   pnpm fortune:probe -- --name="すいぱり"
 *   pnpm fortune:probe -- --lang=English
 *   pnpm fortune:probe -- --no-image     # 画像生成を飛ばし、固定背景で合成する
 *   pnpm fortune:probe -- --n=3          # 3回振る（毎回カテゴリも題材も変わる）
 *   pnpm fortune:probe -- --out=out/foo  # 保存先（既定 out/fortune-probe）
 *
 * 保存物（1回ぶん）:
 *   <時刻>-<n>.png|jpg          投稿される画像そのもの
 *   <時刻>-<n>-background.*     背景に使った生成画像（固定背景に戻ったときは無し）
 *   <時刻>-<n>.json             本文・絵文字・絵の題材・サイズ・所要時間
 *
 * 【前提】
 * - 占い本文: AI_ROUTE_BSKY_FORTUNE のルート（既定は Gemini）が使えること。
 * - 背景の絵: IMAGEGEN_BASE_URL（GPU 機のサイドカー）と Ollama。
 *   AI_ROUTE_BSKY_IMAGE=image-gemini でも描けるが課金される。
 *   どちらも無ければ固定背景で合成され、その旨を最初に表示する。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LanguageName, UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { setGenerationTelemetrySinkForTest } from "../packages/bot_brain/src/ai/aiCallStats.js";
import { generateFortuneResult } from "../packages/bot_brain/src/ai/generateFortuneResult.js";
import { generateImage, isImageGenerationAvailable } from "../packages/bot_brain/src/ai/generateImage.js";
import { composeFortuneImage } from "../apps/bsky_bot_server/src/features/fortuneImage.js";

/** `--name=value` は後勝ち。 */
function argValue(name: string): string | undefined {
  return process.argv
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3))
    .at(-1);
}

function extensionOf(mimeType: string): string {
  if (/jpe?g/.test(mimeType)) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

async function main() {
  // 確認用に回した呼び出しを、本番の日次上限（rpd）や死活監視へ混ぜない。
  setGenerationTelemetrySinkForTest({
    async incrementStats() {},
    async reportHeartbeat() {},
    async reportHealthFailure() {},
  });

  const name = argValue("name") ?? "テストユーザー";
  const lang = (argValue("lang") ?? "日本語") as LanguageName;
  const count = Math.max(1, Number(argValue("n") ?? 1) || 1);
  const skipImage = process.argv.includes("--no-image");
  const outDir = path.resolve(argValue("out") ?? "out/fortune-probe");

  const background = skipImage
    ? "固定（--no-image）"
    : isImageGenerationAvailable()
      ? "生成する"
      : "固定（画像生成が未設定: IMAGEGEN_BASE_URL も AI_ROUTE_BSKY_IMAGE=image-gemini も無い）";
  console.log(`name=${name} / lang=${lang} / ${count}回 / 背景: ${background}`);

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (let index = 1; index <= count; index++) {
    const userinfo = {
      follower: { did: "did:plc:fortuneprobe", handle: "fortune-probe.invalid", displayName: name },
      langStr: lang,
    } as UserInfoGemini;

    const startedAt = Date.now();
    const fortune = await generateFortuneResult(userinfo);
    const textMs = Date.now() - startedAt;

    const image = await composeFortuneImage(
      fortune,
      { generateImage, isImageGenerationAvailable: () => !skipImage && isImageGenerationAvailable() },
      "fortune-probe",
    );
    const imageMs = Date.now() - startedAt - textMs;

    const base = path.join(outDir, `${stamp}-${index}`);
    const imagePath = `${base}.${extensionOf(image.mimeType)}`;
    await writeFile(imagePath, image.data);
    if (image.background) {
      await writeFile(`${base}-background.${extensionOf(image.background.mimeType)}`, image.background.data);
    }
    await writeFile(
      `${base}.json`,
      JSON.stringify(
        {
          name,
          lang,
          fortune,
          output: { mimeType: image.mimeType, bytes: image.data.byteLength },
          background: image.background
            ? {
                mimeType: image.background.mimeType,
                width: image.background.width,
                height: image.background.height,
                bytes: image.background.data.byteLength,
              }
            : null,
          ms: { text: textMs, image: imageMs },
        },
        null,
        2,
      ),
    );

    console.log(`\n===== ${index}/${count} =====`);
    console.log(fortune.fortune);
    console.log(`\nemojis: ${fortune.emojis}`);
    console.log(`picture: ${fortune.picture || "（取れなかった）"}`);
    console.log(
      `背景: ${image.background ? "生成画像" : "固定"} / ${image.mimeType} ${image.data.byteLength}B / ` +
        `本文 ${textMs}ms・画像 ${imageMs}ms`,
    );
    console.log(`-> ${imagePath}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // 読み込んだモジュールが接続を掴んだままでも終わらせる。
  .finally(() => process.exit());
