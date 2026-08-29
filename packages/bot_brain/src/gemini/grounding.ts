import {
  isAiGroundingEnabled,
  resolveAiRoute,
  type AiFeatureKey,
} from "@bsky-affirmative-bot/shared-configs";
import { generateContentForProvider, normalizeJsonSchema } from "./generationClient.js";

export type GroundingPolicy = "off" | "auto" | "required" | "preferred";
export type GroundingPlan = { needed: boolean; queries: string[]; urls: string[] };
export type GroundingDeps = {
  plan?: (model: string, subject: string, forced: boolean) => Promise<GroundingPlan>;
  research?: (input: { queries: string[]; urls: string[] }) => Promise<string>;
};

const AUTO_FEATURES = new Set<AiFeatureKey>([
  "BSKY_AFFIRMATIVE_REPLY",
  "BSKY_CONVERSATION",
  "BSKY_WHIMSICAL_REPLY",
]);

const REQUIRED_FEATURES = new Set<AiFeatureKey>([
  "BIORHYTHM_SEASONAL_WORKS",
  "BSKY_MY_MOOD_SONG",
]);

const PREFERRED_FEATURES = new Set<AiFeatureKey>(["NEWS_POSITIVE_COMMENT"]);

const UNAVAILABLE_RESEARCH_NOTE =
  "External research was unavailable. Avoid unverified current facts and do not invent details.";

export function groundingPolicyForFeature(feature?: AiFeatureKey): GroundingPolicy {
  if (!feature) return "off";
  if (REQUIRED_FEATURES.has(feature)) return "required";
  if (PREFERRED_FEATURES.has(feature)) return "preferred";
  if (AUTO_FEATURES.has(feature)) return "auto";
  return "off";
}

function hasGroundingTools(params: any): boolean {
  return (params.config?.tools ?? []).some(
    (tool: any) => tool?.googleSearch || tool?.urlContext,
  );
}

function stripGroundingTools(params: any): any {
  const tools = (params.config?.tools ?? []).filter(
    (tool: any) => !tool?.googleSearch && !tool?.urlContext,
  );
  const config = { ...params.config };
  if (tools.length) config.tools = tools;
  else delete config.tools;
  delete config.serviceTier;
  delete config.thinkingConfig;
  return { ...params, config };
}

function latestUserText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (!Array.isArray(contents)) return "";
  for (let index = contents.length - 1; index >= 0; index--) {
    const item = contents[index] as any;
    if (typeof item === "string") return item;
    if (item?.role && item.role !== "user") continue;
    const parts = item?.parts ? item.parts : [item];
    const text = (Array.isArray(parts) ? parts : [parts])
      .map((part: any) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function urlsFromText(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>()"']+/g) ?? [])].slice(0, 5);
}

function clearlyNeedsFreshFacts(text: string): boolean {
  return /(最新|現在|現時点|最近|今日.{0,8}(天気|気温)|ニュース|実在|調べ|検索|20\d{2}年|latest|current|recent|today.{0,12}(weather|temperature)|verify|search)/i.test(text);
}

function requiredFallbackQueries(feature?: AiFeatureKey): string[] {
  // 入力文をGeminiへ転送せず、サーバー管理の定型検索だけに限定する。
  if (feature === "BIORHYTHM_SEASONAL_WORKS") {
    return ["現在 日本 今期 話題 アニメ マンガ ゲーム ドラマ 映画 音楽"];
  }
  return [];
}

const plannerSchema = (forced: boolean) => normalizeJsonSchema({
  type: "OBJECT",
  properties: {
    needed: { type: "BOOLEAN" },
    queries: {
      type: "ARRAY",
      items: { type: "STRING" },
      ...(forced ? { minItems: 1 } : {}),
      maxItems: 3,
    },
  },
  required: ["needed", "queries"],
});

function cleanQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/[\r\n\t]+/g, " ").trim().slice(0, 160))
      .filter(Boolean),
  )].slice(0, 3);
}

async function planResearch(
  model: string,
  subject: string,
  forced: boolean,
): Promise<GroundingPlan> {
  const urls = urlsFromText(subject);
  const response = await generateContentForProvider("ollama", {
    model,
    config: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseSchema: plannerSchema(forced),
      systemInstruction: `You decide whether fresh external research is required before answering.
Return concise Japanese or English search queries only. Never copy personal names, handles, DIDs,
conversation history, or the bot persona into a query. Search is needed for current facts, unfamiliar
entities, factual claims that may have changed, recommendations requiring real-world existence, and URLs.
Search is not needed for emotional support, creative writing, transformations, or facts already supplied.
${forced ? "Research is required for this task, so needed must be true." : "Set needed false when research adds no factual value."}`,
    },
    contents: [{ role: "user", parts: [{ text: subject.slice(0, 12_000) }] }],
  });
  const parsed = JSON.parse(response.text || "{}") as { needed?: unknown; queries?: unknown };
  const queries = cleanQueries(parsed.queries);
  return {
    needed: forced || parsed.needed === true || urls.length > 0,
    queries,
    urls,
  };
}

/**
 * Gemini調査の結果を死活監視とRPDへ記録する。
 *
 * `@bsky-affirmative-bot/database` は import しただけで dotenv を読み Postgres クライアントを
 * 作るので、静的importにするとgroundingを呼ばないユニットテストまで巻き込む。実際に
 * Geminiを叩いたときだけ遅延importする。
 */
async function reportGeminiResearch(error?: unknown): Promise<void> {
  try {
    const { MemoryService, reportHealthFailure, reportHeartbeat } =
      await import("@bsky-affirmative-bot/database");
    if (error !== undefined) {
      await Promise.allSettled([
        MemoryService.incrementStats("rpdError", 1),
        reportHealthFailure("gemini", error),
      ]);
      return;
    }
    await Promise.allSettled([
      MemoryService.incrementStats("rpd", 1),
      reportHeartbeat("gemini"),
    ]);
  } catch {
    // 記録の失敗で調査そのものを落とさない。
  }
}

/**
 * Ollama 運用では、Gemini を叩くのが実質ここだけになる。generateContentWithRetry を
 * 通らないので死活監視とRPDを自前で記録する。これが無いと bot-tan.com の Gemini タイルが
 * 6時間で stale・24時間で down になり、Gemini の日次上限判定も実消費を見なくなる。
 */
async function researchWithGemini(input: {
  queries: string[];
  urls: string[];
}): Promise<string> {
  const route = resolveAiRoute("GEMINI_GROUNDING_RESEARCH");
  let response;
  try {
    response = await generateContentForProvider("gemini", {
      model: route.model,
      contents: [{
        role: "user",
        parts: [{
          text: JSON.stringify({
            queries: input.queries,
            urls: input.urls,
            requestedOutput: "Verified facts, uncertainty, and source URLs only",
          }),
        }],
      }],
      config: {
        systemInstruction: `You are a neutral research component. Use Google Search and URL Context when
available. Return only concise verified facts relevant to the supplied queries/URLs, clearly distinguish
uncertainty, and include source URLs. Do not imitate a persona and do not compose a user-facing reply.`,
        tools: [
          { googleSearch: {} },
          ...(input.urls.length ? [{ urlContext: {} }] : []),
        ],
      },
    });
  } catch (error) {
    void reportGeminiResearch(error);
    throw error;
  }
  void reportGeminiResearch();
  const text = String(response.text ?? "").trim();
  if (!text) throw new Error("Gemini grounding returned an empty response");
  return text.slice(0, 8_000);
}

/**
 * 実在確認が目的の機能（required / preferred）向けの追加拘束。
 *
 * 「参考にしてよい」だけだと、ローカルモデルは調査ブロックを読み飛ばして学習データの
 * 古い作品名を並べる（実測: 2026年夏を問うても旧作や実在しない題を返した。Gemini側の
 * 調査結果自体は正確だった）。固有名詞の出所を調査ブロックに限定して塞ぐ。
 */
const RESEARCH_ONLY_NOTE = `
Every proper noun in your answer — titles, artists, product names, people, dates, numbers —
must appear verbatim in the research above. Your own knowledge is out of date and must not be
used to name anything. If the research does not support enough items, return fewer items rather
than filling the gap from memory.`;

function appendResearch(params: any, research: string, strict = false): any {
  const block = `\n\n<grounding_research>\n${research}\n</grounding_research>\nUse this research only as factual reference. The final answer must follow the original system instruction and persona. Do not mention this research block.${strict ? RESEARCH_ONLY_NOTE : ""}`;
  const contents = params.contents;
  if (typeof contents === "string") return { ...params, contents: contents + block };
  if (!Array.isArray(contents)) return params;
  const cloned = contents.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    return { ...item, ...(Array.isArray(item.parts) ? { parts: [...item.parts] } : {}) };
  });
  for (let index = cloned.length - 1; index >= 0; index--) {
    const item = cloned[index];
    if (typeof item === "string") {
      cloned[index] = item + block;
      return { ...params, contents: cloned };
    }
    if (item?.role && item.role !== "user") continue;
    if (Array.isArray(item?.parts)) {
      item.parts.push({ text: block });
      return { ...params, contents: cloned };
    }
  }
  cloned.push({ role: "user", parts: [{ text: block }] });
  return { ...params, contents: cloned };
}

/**
 * Ollama 最終生成の前処理。Geminiへ渡すのはローカルplannerが作った検索語とURLだけで、
 * 元投稿、会話履歴、SYSTEM_INSTRUCTION、DID等は渡さない。
 */
export async function prepareOllamaGrounding(
  feature: AiFeatureKey | undefined,
  params: any,
  deps: GroundingDeps = {},
): Promise<any> {
  const stripped = stripGroundingTools(params);
  const policy = groundingPolicyForFeature(feature);
  if (policy === "off" || !hasGroundingTools(params)) return stripped;

  // AI_GROUNDING_PROVIDER=off でも、実在確認が要る機能（required / preferred）には
  // 「調べられなかった」ことを必ず伝える。黙って素通りさせると、今期作品や気分ソングで
  // 存在しない作品名を平気で作る。
  if (!isAiGroundingEnabled()) {
    if (policy === "auto") return stripped;
    return appendResearch(stripped, UNAVAILABLE_RESEARCH_NOTE);
  }

  const subject = latestUserText(params.contents);
  if (!subject) return stripped;
  try {
    const plan = await (deps.plan ?? planResearch)(
      params.model,
      subject,
      policy !== "auto" || clearlyNeedsFreshFacts(subject),
    );
    if (!plan.needed) return stripped;
    const queries = plan.queries.length
      ? plan.queries
      : requiredFallbackQueries(feature);
    if (!queries.length && !plan.urls.length) {
      throw new Error("Grounding planner returned no safe query or URL");
    }
    const research = await (deps.research ?? researchWithGemini)({
      queries,
      urls: plan.urls,
    });
    console.log(
      `[INFO][AI_GROUNDING] feature=${feature ?? "unknown"} queries=${queries.length} urls=${plan.urls.length}`,
    );
    // required / preferred は実在確認が目的なので、固有名詞の出所を調査結果に限定する。
    return appendResearch(stripped, research, policy !== "auto");
  } catch (error) {
    if (policy === "required") throw error;
    console.warn(
      `[WARN][AI_GROUNDING] feature=${feature ?? "unknown"} unavailable; continuing without external facts`,
      error,
    );
    return appendResearch(stripped, UNAVAILABLE_RESEARCH_NOTE);
  }
}
