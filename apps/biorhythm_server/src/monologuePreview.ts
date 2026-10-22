import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateImage, generateMonologue } from "@bsky-affirmative-bot/bot-brain";
import retry from "async-retry";
import { MONOLOGUE_SCENARIOS, runMonologueScenario, seededRandom } from "./monologueScenarios.js";
import { monologueImageSource, monologueSituationJa } from "./monologueTriggers.js";

/**
 * ひとりごとの「架空の1日」ドライラン。**投稿もDB書き込みもしない。**
 *
 * 本番と同じ planMonologue で撃つ step を決め、撃った step では実際に generateMonologue を
 * 呼ぶ（Ollama を使う）。--images を付けると、絵の当たった step で generateImage も呼ぶ
 * （GPU サイドカーを回すので、ユーザーの依頼が少ない時間帯に）。お絵描きの日次枠は取らない。
 *
 * 実行: pnpm --filter biorhythm-server monologue:preview -- --out <dir> [--seeds 1,2,3] [--images] [--scenario weekday]
 * 出力: <dir>/day-<scenario>-seed<N>.md と、絵があれば同じ名前の .png
 */

const IMAGE_MAX_BYTES = 950_000;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outDir = arg("out");
if (!outDir) {
  console.error("--out <dir> を指定してください");
  process.exit(1);
}
const seeds = (arg("seeds") ?? "1,2,3").split(",").map(Number).filter(Number.isFinite);
const withImages = process.argv.includes("--images");
const only = arg("scenario");

await mkdir(outDir, { recursive: true });

for (const scenario of MONOLOGUE_SCENARIOS.filter((s) => !only || s.name === only)) {
  for (const seed of seeds) {
    const name = `day-${scenario.name}-seed${seed}`;
    const rows: string[] = [];
    let imageIndex = 0;

    const { firings } = await runMonologueScenario(scenario, seededRandom(seed), async (firing, state) => {
      const started = Date.now();
      let text: string;
      let textEn: string;
      try {
        const generated = await retry(
          () =>
            generateMonologue({
              currentActivity: firing.step.activity,
              hour: firing.hour,
              isWeekend: scenario.isWeekend,
              energy: firing.step.energy,
              weather: scenario.weather,
              situationJa: monologueSituationJa(firing.trigger, scenario.isWeekend),
              reactionJa: firing.reaction.ja,
              recentMonologues: state.recentTexts,
              emoji: firing.emoji,
            }),
          { retries: 2 },
        );
        text = generated.textJa;
        textEn = generated.textEn;
      } catch (error) {
        rows.push(`### ${firing.step.time} — 生成失敗\n\n${error instanceof Error ? error.message : String(error)}\n`);
        return null;
      }

      let imageNote = "なし";
      if (firing.withImage) {
        if (!withImages) {
          imageNote = "当たり（--images なしのため描いていない）";
        } else {
          const image = await generateImage(
            monologueImageSource(text, firing.step.activity),
            IMAGE_MAX_BYTES,
            { purpose: "picture", outfit: { status: firing.step.status, casualOutfit: scenario.outfit, now: firing.at } },
          );
          if (image) {
            const file = `${name}-${++imageIndex}.png`;
            await writeFile(path.join(outDir, file), image.data);
            imageNote = `![](${file})`;
          } else {
            imageNote = "当たり（描けなかった）";
          }
        }
      }

      rows.push(
        [
          `### ${firing.step.time} ${firing.step.status} — ${firing.trigger} / ${firing.reaction.id}`,
          "",
          `- いましていること: ${firing.step.activity}`,
          `- 元気: ${firing.step.energy} / 確率: ${firing.probability.toFixed(2)} / 生成: ${((Date.now() - started) / 1000).toFixed(1)}秒`,
          "",
          `> ${text.replace(/\n/g, "\n> ")}`,
          ">",
          `> ${textEn.replace(/\n/g, "\n> ")}`,
          "",
          `絵: ${imageNote}`,
          "",
        ].join("\n"),
      );
      console.log(`[${name}] ${firing.step.time} ${firing.trigger}/${firing.reaction.id}: ${text}`);
      return text;
    });

    const header = [
      `# ${scenario.name}（${scenario.day}・${scenario.isWeekend ? "休日" : "平日"}・${scenario.weather}） seed=${seed}`,
      "",
      `ひとりごと ${firings.length} 件 / step ${scenario.steps.length} 個`,
      "",
      "| 時刻 | status | 元気 | 撃った | きっかけ / 型 |",
      "|---|---|---|---|---|",
      ...scenario.steps.map((step) => {
        const firing = firings.find((f) => f.step === step);
        const note = step.otherPost ? `（${step.otherPost} を投稿）` : "";
        return `| ${step.time} | ${step.status} | ${step.energy} | ${firing ? "○" : ""} | ${firing ? `${firing.trigger} / ${firing.reaction.id}` : note} |`;
      }),
      "",
    ];
    await writeFile(path.join(outDir, `${name}.md`), [...header, ...rows].join("\n"));
    console.log(`wrote ${path.join(outDir, `${name}.md`)}`);
  }
}
process.exit(0);
