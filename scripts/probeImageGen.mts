/**
 * 画像生成の通し確認。おやすみポストを待たずに、本文から絵が出るところまでを実測する。
 *
 * 本番の組み立て関数（planImageScene / buildImagePrompt）をそのまま import するので、
 * プロンプトを直したらこの確認も自動的に追随する。評価ハーネスと同じ思想。
 *
 * 使い方:
 *   # 何も叩かず、組み上がるプロンプトだけ見る
 *   pnpm imagegen:probe
 *
 *   # 実際にサイドカーへ投げて out/ へ保存する
 *   pnpm imagegen:probe -- --run
 *
 *   # 任意の本文で試す（おやすみポストの実物を貼るのが一番実態に近い）
 *   pnpm imagegen:probe -- --run --text="今日はモルフォと公園を走ったよ！..."
 *
 *   # 画風を切り替える
 *   pnpm imagegen:probe -- --run --style=anime
 *
 *   # お絵描きの依頼（既存キャラの解決込み）で試す。材料は judgeDrawingRequest の subject
 *   pnpm imagegen:probe -- --run --purpose=picture --text="艦これの島風"
 *
 * 【前提】IMAGEGEN_BASE_URL と OLLAMA_BASE_URL / OLLAMA_MODEL が .env にあること。
 * サイドカーは GPU 機で起動しておく（bot-tan-imagegen の scripts/sidecar.sh start）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildImagePrompt,
  planImageScene,
  type ImageScenePurpose,
  type ImageStyle,
} from "../packages/bot_brain/src/ai/buildImagePrompt.js";
import { resolveCharacters } from "../packages/bot_brain/src/ai/characterLookup.js";
import { isImageGenConfigured, requestImage } from "../packages/bot_brain/src/ai/imageGenClient.js";

/** `--name=value` は後勝ち。指定が黙って無視されて古い結果を上書きする事故を避ける。 */
function argValue(name: string): string | undefined {
  return process.argv
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3))
    .at(-1);
}

const DEFAULT_TEXTS = [
  "今日はね、モルフォと公園を思いっきり走り回ったんだ！ 芝生がふかふかで、しっぽがぶんぶんしてて、もう最高だったよ〜！",
  "アニメの最新話を観て、尊すぎてしばらく床から立ち上がれなくなってたみたい。画面の中の推しがキラキラしてたんだね！",
  "ラテちゃんとカフェでパフェを分けっこしたよ。二人で「あーん」ってしてたら、ちょっと恥ずかしくなっちゃった！",
];

async function main() {
  const run = process.argv.includes("--run");
  const style = (argValue("style") as ImageStyle) ?? "crayon-diary";
  const purpose = (argValue("purpose") as ImageScenePurpose) ?? "good-night";
  const texts = argValue("text") ? [argValue("text")!] : DEFAULT_TEXTS;
  const outDir = path.resolve(argValue("out") ?? "out/imagegen-probe");

  console.log(`style=${style} / ${texts.length}件 / ${run ? "実行する" : "組み立てのみ（--run で実行）"}`);
  if (run && !isImageGenConfigured()) {
    console.error("IMAGEGEN_BASE_URL が未設定。.env を確認すること。");
    process.exitCode = 1;
    return;
  }

  for (const [index, text] of texts.entries()) {
    console.log(`\n${"=".repeat(72)}\n[${index + 1}] ${text}`);

    // お絵描きは DrawingFeature と同じ見出しを付けて渡す。
    const plan = await planImageScene(
      purpose === "picture" ? `### 描いてほしいと頼まれた絵\n${text}` : text,
      purpose,
    );
    if (!plan) {
      console.error("  シーン変換に失敗した（Ollama が応答しないか JSON が壊れている）");
      continue;
    }
    console.log(`  同伴者: ${plan.companions.join(", ") || "なし"} / 構図: ${plan.framing} / 屋外: ${plan.outdoor}`);

    const characters = await resolveCharacters(plan.characters);
    if (plan.characters.length > 0) {
      console.log(
        `  キャラ : ${plan.characters.map((c) => `${c.name}(${c.series || "?"})`).join(", ")}` +
          ` -> ${characters.map((c) => c.tag).join(", ") || "解決できず（botたんを描く）"} / botたん: ${plan.botTan}`,
      );
    }

    const built = buildImagePrompt(plan, style, characters);
    if (!built) {
      console.error("  シーンが薄すぎるので描かない（本番でもここで止まる）");
      continue;
    }
    console.log(`  prompt : ${built.prompt}`);
    console.log(`  領域   : ${built.regions.length}（2キャラのときだけ入る）`);
    console.log(`  解像度 : ${built.width}x${built.height} / LoRA: ${built.loras.map(([n]) => n).join(", ") || "なし"}`);
    if (!run) continue;

    const started = Date.now();
    const image = await requestImage({
      prompt: built.prompt,
      negativePrompt: built.negativePrompt,
      width: built.width,
      height: built.height,
      regions: built.regions,
      loras: built.loras,
      // Leaflet の coverImage 上限 1,000,000 バイトに対する余裕分。本番と同じ値。
      maxBytes: 950_000,
    });
    if (!image) {
      console.error("  サイドカーが画像を返さなかった");
      continue;
    }

    await mkdir(outDir, { recursive: true });
    const ext = image.mimeType.includes("jpeg") ? "jpg" : "png";
    const file = path.join(outDir, `${purpose}-${style}-${index + 1}.${ext}`);
    await writeFile(file, image.data, { mode: 0o600 });
    console.log(
      `  → ${file} (${(image.data.byteLength / 1024).toFixed(0)}KB, ${image.mimeType}, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    if (image.data.byteLength > 1_000_000) {
      console.error("  ★1MBを超えている。Leaflet の coverImage が弾かれる。");
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // **明示的に落とす。** fetch(undici) の keep-alive ソケットがイベントループを掴んだまま
    // になり、生成が全部終わっているのにプロセスが終わらない（実際に45分残った）。
    // ここは使い捨ての確認スクリプトなので、握っているものごと畳んでよい。
    process.exit(process.exitCode ?? 0);
  });
