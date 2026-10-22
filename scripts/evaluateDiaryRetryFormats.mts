/**
 * 事前にread-onlyで抽出した実データを同一条件で比較する。投稿/DB更新はしない。
 * 入力・出力は非公開データを含むため、/tmp等の非共有ディレクトリへ保存する。
 * 例: pnpm exec tsx --env-file=.env scripts/evaluateDiaryRetryFormats.mts \
 *   --cases=/tmp/diary-format-eval/cases.json --out=/tmp/diary-format-eval/results.json --run
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateUserDiaryDraft, type UserDiaryResponseFormat } from "../packages/bot_brain/src/ai/generateUserDiary.js";
import { DiaryValidationError } from "../packages/bot_brain/src/ai/diaryValidation.js";
import { setGenerationTelemetrySinkForTest } from "../packages/bot_brain/src/ai/aiCallStats.js";
import type { GeminiUsage } from "../packages/bot_brain/src/ai/util.js";
import { ollamaDefaultTemperature, ollamaTextContextLength, resolveAiRoute } from "../packages/shared-configs/dist/index.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const casesPath = arg("cases");
const out = arg("out");
if (!casesPath || !out) throw new Error("--cases and --out are required");
const candidate = "paragraphFlags" as const;
const repetitions = Number(arg("repetitions") ?? 2);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error("repetitions must be 1..3");
const count = Number(arg("count") ?? 24);
if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error("count must be 1..24");
const route = resolveAiRoute("COMMON_USER_DIARY");
if (route.provider !== "ollama") throw new Error("This evaluation requires the production Ollama route");
// 評価が本番の呼び出し統計や健康状態を更新するのを防ぐ。
setGenerationTelemetrySinkForTest({ async incrementStats() {}, async reportHeartbeat() {}, async reportHealthFailure() {} });
const data = JSON.parse(await readFile(casesPath, "utf8"));
const cases = data.cases.slice(0, count);
if (cases.length !== count) throw new Error("not enough cases");
const report = {
  createdAt: new Date().toISOString(),
  inputSha256: createHash("sha256").update(await readFile(casesPath)).digest("hex"),
  source: data.source,
  repetitions, requestsPlanned: count * repetitions * 2,
  settings: { concurrency: 1, outputTokens: 1024, temperature: ollamaDefaultTemperature(), contextBudgetMirror: ollamaTextContextLength(), model: route.model, formats: ["excerpt", candidate], retries: 0 },
  results: [] as any[],
};
if (!process.argv.includes("--run")) {
  console.log(JSON.stringify({ mode: "dry-run", cases: count, ...report.settings, requests: report.requestsPlanned }));
  process.exit(0);
}
for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const [index, item] of cases.entries()) {
    // case/repetitionごとに先行形式を反転。キャッシュ/時刻による片側だけの有利さを抑える。
    const formats: UserDiaryResponseFormat[] = (index + repetition) % 2
      ? ["excerpt", candidate] : [candidate, "excerpt"];
    for (const format of formats) {
      const usages: GeminiUsage[] = [];
      let calls = 0;
      let raw = "";
      let output: unknown = null;
      let reason: string | null = null;
      let diagnostics: unknown = null;
      const started = Date.now();
      try {
        output = await generateUserDiaryDraft(item.userinfo, {
          dayContext: item.dayContext, mediaReference: item.mediaReference,
          responseFormat: format,
          onRequest: () => { calls++; },
          onUsage: (usage) => { usages.push(usage); },
          onResponseText: (text) => { raw = text; },
        });
      } catch (error) {
        reason = error instanceof DiaryValidationError ? error.reason : "request_error";
        diagnostics = error instanceof DiaryValidationError ? error.diagnostics : null;
      }
      report.results.push({
        case: index + 1, group: item.group, english: item.english,
        date: item.date, format, repetition, calls,
        success: output !== null, reason, diagnostics,
        elapsedMs: Date.now() - started, usages, raw, output,
      });
      await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ progress: `${report.results.length}/${report.requestsPlanned}`, case: index + 1, format, repetition, reason, tokens: usages.reduce((n, u) => n + u.outputTokens, 0), elapsedMs: Date.now() - started }));
    }
  }
}
