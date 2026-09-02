import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import "dotenv/config";
import postgres from "postgres";
import { buildUserDiaryContext } from "../packages/clients/src/userDiaryContext.js";
import { selectUserDiaryMediaReference } from "../packages/clients/src/userDiaryMediaReference.js";
import { withPreferredName } from "../packages/clients/src/preferredName.js";
import { generateUserDiaryDraft } from "../packages/bot_brain/src/ai/generateUserDiary.js";
import type { GeminiUsage } from "../packages/bot_brain/src/ai/util.js";

const COST_LIMIT_USD = 5;
const caseCountArg = process.argv.find((value) => value.startsWith("--case-count="));
const CASE_COUNT = caseCountArg
  ? Number.parseInt(caseCountArg.split("=")[1] ?? "", 10)
  : 24;
if (!Number.isInteger(CASE_COUNT) || CASE_COUNT < 1 || CASE_COUNT > 24) {
  throw new Error("--case-count must be an integer from 1 to 24");
}
const subjectDid = process.argv
  .find((value) => value.startsWith("--subject-did="))
  ?.slice("--subject-did=".length);
const repetitionsArg = process.argv.find((value) => value.startsWith("--repetitions="));
const REPETITIONS = repetitionsArg
  ? Number.parseInt(repetitionsArg.split("=")[1] ?? "", 10)
  : 2;
if (!Number.isInteger(REPETITIONS) || REPETITIONS < 1 || REPETITIONS > 5) {
  throw new Error("--repetitions must be an integer from 1 to 5");
}
const run = process.argv.includes("--run");

type CaseKind = "dense" | "sparse" | "technical" | "english";
type DiaryCase = {
  did: string;
  date: string;
  displayName: string;
  posts: string[];
  baselineDiary: string;
  kind: CaseKind;
  generatedAt: Date;
};

const MODELS = [
  { name: "2.5-flash-lite", model: "gemini-2.5-flash-lite", input: 0.05, output: 0.2 },
  { name: "2.5-flash", model: "gemini-2.5-flash", input: 0.15, output: 1.25 },
  { name: "3.5-flash-lite", model: "gemini-3.5-flash-lite", input: 0.15, output: 1.25 },
  { name: "3.6-flash", model: "gemini-3.6-flash", input: 0.75, output: 3.75 },
] as const;
type ModelConfig = (typeof MODELS)[number];
const modelNamesArg = process.argv
  .find((value) => value.startsWith("--models="))
  ?.slice("--models=".length)
  .split(",")
  .filter(Boolean);
const SELECTED_MODELS: readonly ModelConfig[] = modelNamesArg?.length
  ? MODELS.filter((model) => modelNamesArg.includes(model.name))
  : MODELS;
if (SELECTED_MODELS.length === 0 || SELECTED_MODELS.length !== (modelNamesArg?.length ?? SELECTED_MODELS.length)) {
  throw new Error(`--models must contain known model names: ${MODELS.map((model) => model.name).join(", ")}`);
}

function classify(posts: string[], langs: unknown): CaseKind[] {
  const joined = posts.join("\n");
  const result: CaseKind[] = [];
  if (posts.length >= 6) result.push("dense");
  if (posts.length <= 2) result.push("sparse");
  if (/(systemd|typescript|javascript|api|database|sql|コード|実装|開発|サーバー)/i.test(joined)) {
    result.push("technical");
  }
  if (/"en"|English/i.test(JSON.stringify(langs)) || /^[\x00-\x7f\s\p{P}]+$/u.test(joined)) {
    result.push("english");
  }
  return result;
}

async function loadLatestSubjectCase(
  sql: postgres.Sql,
  did: string,
): Promise<DiaryCase> {
  const rows = await sql<{
    did: string;
    display_name: string | null;
    texts: string[];
    langs: unknown;
  }[]>`
    select p.did, coalesce(pf.display_name, a.handle, p.did) as display_name,
           array_agg(p.text order by p.record_created_at) as texts,
           jsonb_agg(p.langs) as langs
      from nagi.posts p
      left join nagi.profiles pf on pf.did = p.did
      left join nagi.actors a on a.did = p.did
     where p.did = ${did}
       and p.deleted_at is null
       and p.record_created_at >= now() - interval '24 hours'
     group by p.did, pf.display_name, a.handle
  `;
  const row = rows[0];
  if (!row?.texts.length) throw new Error("No posts found for the subject in the last 24 hours");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return {
    did: row.did,
    date,
    displayName: row.display_name || row.did,
    posts: row.texts,
    baselineDiary: "",
    kind: classify(row.texts, row.langs)[0] ?? "dense",
    generatedAt: new Date(),
  };
}

async function loadCases(sql: postgres.Sql): Promise<DiaryCase[]> {
  if (subjectDid && CASE_COUNT === 1) {
    return [await loadLatestSubjectCase(sql, subjectDid)];
  }
  const rows = await sql<{
    did: string;
    diary_date: string;
    display_name: string | null;
    texts: string[];
    langs: unknown;
    baseline_diary: string;
    generated_at: Date;
  }[]>`
    select d.subject_did as did, d.diary_date,
           coalesce(pf.display_name, a.handle, d.subject_did) as display_name,
           array_agg(p.text order by p.record_created_at) as texts,
           jsonb_agg(p.langs) as langs,
           d.text as baseline_diary,
           d.record_created_at as generated_at
      from nagi.diaries d
      join nagi.posts p
        on p.did = d.subject_did
       and p.deleted_at is null
       and p.record_created_at >= d.record_created_at - interval '24 hours'
       and p.record_created_at < d.record_created_at
      left join nagi.profiles pf on pf.did = d.subject_did
      left join nagi.actors a on a.did = d.subject_did
     group by d.subject_did, d.diary_date, pf.display_name, a.handle,
              d.text, d.record_created_at
     order by d.record_created_at desc
     limit 240
  `;
  const buckets = new Map<CaseKind, DiaryCase[]>([
    ["dense", []], ["sparse", []], ["technical", []], ["english", []],
  ]);
  for (const row of rows) {
    for (const kind of classify(row.texts, row.langs)) {
      buckets.get(kind)?.push({
        did: row.did,
        date: row.diary_date,
        displayName: row.display_name || row.did,
        posts: row.texts,
        baselineDiary: row.baseline_diary,
        kind,
        generatedAt: row.generated_at,
      });
    }
  }
  const selected: DiaryCase[] = [];
  const keys = new Set<string>();
  for (const kind of ["dense", "sparse", "technical", "english"] as const) {
    for (const item of buckets.get(kind) ?? []) {
      const key = `${item.did}:${item.date}`;
      if (keys.has(key)) continue;
      selected.push(item);
      keys.add(key);
      if (selected.filter((candidate) => candidate.kind === kind).length === 6) break;
    }
  }
  if (selected.length < CASE_COUNT) {
    throw new Error(`Need ${CASE_COUNT} cases; found ${selected.length}`);
  }
  return selected.slice(0, CASE_COUNT);
}

function usageCost(model: (typeof MODELS)[number], usage: GeminiUsage): number {
  return (usage.promptTokens * model.input + (usage.outputTokens + usage.thinkingTokens) * model.output) / 1_000_000;
}

const estimatedCost = CASE_COUNT * REPETITIONS * SELECTED_MODELS.reduce<number>(
  (sum, model) => sum + (5_000 * model.input + 1_000 * model.output) / 1_000_000,
  0,
);
async function main(): Promise<void> {
  if (estimatedCost > COST_LIMIT_USD) {
    throw new Error(`Preflight estimate $${estimatedCost.toFixed(4)} exceeds $${COST_LIMIT_USD}`);
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
  const cases = await loadCases(sql);
  const report: any = {
    createdAt: new Date().toISOString(),
    mode: run ? "run" : "dry-run",
    pricing: { asOf: "2026-08-10", unit: "USD per 1M tokens", models: SELECTED_MODELS },
    limits: { cases: CASE_COUNT, repetitions: REPETITIONS, preflightUsd: estimatedCost, maximumUsd: COST_LIMIT_USD },
    rubric: ["naturalness", "interest", "dayVariation", "botTanVoice", "postConsistency"],
    adoption: { maximumHardFailRate: 0.05, minimumAverageScore: 4, cheapestWithinBestScore: 0.25 },
    cases: cases.map(({ did, ...item }) => ({
      ...item,
      didHash: createHash("sha256").update(did).digest("hex").slice(0, 16),
    })),
    results: [],
    actualCostUsd: 0,
  };
  if (run) {
    for (const diaryCase of cases) {
      const until = diaryCase.generatedAt;
      const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
      const english = diaryCase.kind === "english";
      const dayContext = await buildUserDiaryContext({
        did: diaryCase.did,
        date: diaryCase.date,
        since,
        until,
        timezone: subjectDid ? "Asia/Tokyo" : "UTC",
        japanese: !english,
      });
      const mediaReference = await selectUserDiaryMediaReference(
        diaryCase.did,
        diaryCase.date,
      );
      for (const model of SELECTED_MODELS) {
        for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
          const nextRequestEstimate =
            4 * (5_000 * model.input + 1_000 * model.output) / 1_000_000;
          if (report.actualCostUsd + nextRequestEstimate > COST_LIMIT_USD) {
            throw new Error("Actual cost plus the next request estimate would exceed the $5 cap");
          }
          const usages: GeminiUsage[] = [];
          const startedAt = Date.now();
          let output: any = null;
          let error: string | null = null;
          try {
            const userinfo = await withPreferredName({
                follower: { did: diaryCase.did, handle: diaryCase.did, displayName: diaryCase.displayName },
                posts: diaryCase.posts,
                langStr: english ? "English" : "日本語",
              });
            const draft = await generateUserDiaryDraft(
              userinfo,
              {
                dayContext,
                mediaReference,
                aiRoute: { model: model.model, serviceTier: "flex" },
                onUsage: (value) => { usages.push(value); },
              },
            );
            output = {
              ...draft,
              mediaReference: {
                id: mediaReference.id,
                source: mediaReference.source,
                titleJa: mediaReference.titleJa,
                titleEn: mediaReference.titleEn,
                selectedReferenceUsed: (english
                  ? mediaReference.requiredTermsEn
                  : mediaReference.requiredTermsJa
                ).some((term) =>
                  english
                    ? draft.diary.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en"))
                    : draft.diary.includes(term),
                ),
              },
            };
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
          }
          const cost = usages.reduce((sum, measured) => sum + usageCost(model, measured), 0);
          report.actualCostUsd += cost;
          report.results.push({
            case: `${diaryCase.did}:${diaryCase.date}`,
            kind: diaryCase.kind,
            model: model.name,
            repetition,
            latencyMs: Date.now() - startedAt,
            usage: usages,
            retries: Math.max(0, usages.length - 1),
            costUsd: cost,
            costProjectionUsd: { one: cost, monthly99: cost * 99, monthly3000: cost * 3_000 },
            output,
            hardFail: {
              jsonOrValidation: Boolean(error),
              supplementalUnused: Boolean(dayContext.candidates.length && output?.usedContextId === "none"),
              lengthViolation: Boolean(
                output &&
                  ([...output.title_ja].length > 20 ||
                    [...output.title_en].length > 30),
              ),
              subjectMisattribution: null,
              fabrication: null,
            },
            scores: { naturalness: null, interest: null, dayVariation: null, botTanVoice: null, postConsistency: null },
            error,
          });
        }
      }
    }
  }
  const path = `/tmp/nagi-diary-eval-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`${run ? "Evaluation" : "Dry run"} complete: ${path}`);
  console.log(`preflight=$${estimatedCost.toFixed(4)} actual=$${report.actualCostUsd.toFixed(4)}`);
  } finally {
    await sql.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
