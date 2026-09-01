import {
  aiModel,
  estimateMessagesTokens,
  isAiGroundingEnabled,
  ollamaPromptBudget,
  ollamaTextContextLength,
  type AiFeatureKey,
} from "@bsky-affirmative-bot/shared-configs";
import { fetchReadableText } from "@bsky-affirmative-bot/nagi-linkcard";
import { searxngSearch, type SearchHit } from "../api/searxng/index.js";
import { generateContentForProvider, normalizeJsonSchema } from "./generationClient.js";

export type GroundingPolicy = "off" | "deferred" | "required" | "preferred";
export type GroundingPlan = { needed: boolean; queries: string[]; urls: string[] };
export type GroundingDeps = {
  plan?: (model: string, subject: string, forced: boolean) => Promise<GroundingPlan>;
  research?: (input: { queries: string[]; urls: string[] }) => Promise<string>;
};

/**
 * リプライ系。**同期パスでは検索しない。**
 *
 * 以前は "auto" として、リプライ 1 本ごとに planner（ローカル1回）→ 調査 → 本生成
 * を直列で回していた。検索を自前化すると要約段が増えてローカル推論が 3 回になり、
 * 投稿からリプライまでの体感が確実に悪化する。
 *
 * そこで同期パスからは検索を外し、その場では「分からない」と言わせる。調べる方は
 * NagiResearchWorker が非同期で回し、結果を bot memory に貯めて次回以降に効かせる。
 * これで同期パスのローカル推論は本生成の 1 回だけになる。
 */
const DEFERRED_FEATURES = new Set<AiFeatureKey>([
  "BSKY_AFFIRMATIVE_REPLY",
  "BSKY_CONVERSATION",
  "BSKY_WHIMSICAL_REPLY",
]);

/**
 * required / preferred はいずれもバッチ（季節の話題作は7日キャッシュ、ポジニュースは
 * 6時間スロット）なので、同期で検索してよい。体感レイテンシに影響しない。
 */
const REQUIRED_FEATURES = new Set<AiFeatureKey>([
  "BIORHYTHM_SEASONAL_WORKS",
  "BSKY_MY_MOOD_SONG",
]);

const PREFERRED_FEATURES = new Set<AiFeatureKey>(["NEWS_POSITIVE_COMMENT"]);

const UNAVAILABLE_RESEARCH_NOTE =
  "External research was unavailable. Avoid unverified current facts and do not invent details.";

/**
 * 同期パスで検索しない機能へ渡す注意書き。
 *
 * 黙って素通りさせると、ローカルモデルは学習データの古い作品名を平気で並べる。
 * 「知らないなら知らないと言う」まで明示しないと埋め合わせに走る。
 */
const DEFERRED_RESEARCH_NOTE =
  "External research is not available in this turn. Do not invent current facts, titles, numbers, or dates. If you do not know something, say so plainly in your own voice instead of guessing.";

export function groundingPolicyForFeature(feature?: AiFeatureKey): GroundingPolicy {
  if (!feature) return "off";
  if (REQUIRED_FEATURES.has(feature)) return "required";
  if (PREFERRED_FEATURES.has(feature)) return "preferred";
  if (DEFERRED_FEATURES.has(feature)) return "deferred";
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

export function urlsFromText(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>()"']+/g) ?? [])].slice(0, 5);
}

export function clearlyNeedsFreshFacts(text: string): boolean {
  return /(最新|現在|現時点|最近|今日.{0,8}(天気|気温)|ニュース|実在|調べ|検索|20\d{2}年|latest|current|recent|today.{0,12}(weather|temperature)|verify|search)/i.test(text);
}

/** 日本のクール。1-3月=冬、4-6月=春、7-9月=夏、10-12月=秋。 */
const SEASON_BY_MONTH = ["冬", "冬", "冬", "春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋"];

/**
 * 今期の作品を探す定型クエリ。**トピック語を先頭に、年を末尾に置く。**
 *
 * 【実測で確かめた規則。触る前に必ず読むこと】
 * Gemini は曖昧なクエリを内部で言い換えてから検索していたので
 * 「現在 日本 今期 話題 アニメ マンガ ゲーム ドラマ 映画 音楽」でも通っていた。
 * SearXNG（実体は Bing）はリテラルに引くので、同じ書き方は通用しない。
 *
 *   夏アニメ 2026     → 作品一覧サイトが5件           ✅
 *   夏ドラマ 2026     → 7月期ドラマ一覧が5件          ✅
 *   新作ゲーム 2026   → 発売日カレンダー・ファミ通     ✅
 *   話題の映画 2026   → 公開予定作品の一覧が5件        ✅
 *   2026年 夏ドラマ   → 全部「2026年カレンダー」       ❌
 *   2026年 新作ゲーム → 全部「2026年カレンダー」       ❌
 *   2026年 ヒット曲   → 全部「2026年カレンダー」       ❌
 *
 * 年を先頭に置くと Bing がそれを主要語と解釈し、カレンダー配布サイトへ落ちる。
 * 「ヒット曲」は株式会社ヒットに食われるので「音楽ランキング」を使う。
 */
export function seasonalWorksQueries(now = new Date()): string[] {
  const year = now.getFullYear();
  const season = SEASON_BY_MONTH[now.getMonth()];
  return [
    `${season}アニメ ${year}`,
    `${season}ドラマ ${year}`,
    `話題の映画 ${year}`,
    `新作ゲーム ${year}`,
  ];
}

function requiredFallbackQueries(feature?: AiFeatureKey): string[] {
  // 入力文を検索側へ転送せず、サーバー管理の定型検索だけに限定する。
  if (feature === "BIORHYTHM_SEASONAL_WORKS") return seasonalWorksQueries();
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

/** 非同期リサーチワーカーからも使う。生入力を見るのはこのローカル planner だけ。 */
export async function planResearch(
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

Queries go to a plain search engine that takes them literally, so follow these rules exactly:
1. Lead with the specific topic word. Put any year at the END, never at the start — a query
   beginning with a year returns calendar sites instead of the topic.
2. Never lead with a bare relative word such as 今 / 現在 / 最近 / 今期 / latest / recent.
   Those return dictionary and clock pages.
3. Keep each query to one topic and a few words. Piling on keywords makes the engine drop
   everything but the strongest single word.
Good: "${SEASON_BY_MONTH[new Date().getMonth()]}アニメ ${new Date().getFullYear()}" / "話題の映画 ${new Date().getFullYear()}"
Bad: "${new Date().getFullYear()}年 話題のアニメ" / "現在 人気 アニメ ゲーム 音楽 まとめ"
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

/** 検索で集めた素材。要約の入力にも、末尾の Sources 行にも使う。 */
type ResearchSource = { title: string; url: string; body: string };

/**
 * 本文まで取りに行く検索結果の件数。
 *
 * スニペットは 200〜500 字の断片で、実測では一覧ページのスニペットに作品名が
 * 1 つも含まれないことが普通にあった。Gemini の URL Context はページ本文を読んで
 * いたので、ここを埋めないと調査の質が落ちる。
 */
const FETCH_TOP_N = 2;
const MAX_QUERIES = 4;
const MAX_URLS = 3;
const SUMMARY_OUTPUT_TOKENS = 1_024;
const RESEARCH_TEXT_LIMIT = 8_000;

const SUMMARY_INSTRUCTION = `You are a neutral research component. Extract only facts that appear in the
supplied material. Do not imitate a persona and do not compose a user-facing reply.
Copy every proper noun — titles, artists, product names, people, dates, numbers — verbatim from the
material. Never translate, abbreviate, or normalise them, and never add anything from your own
knowledge. Set "source" to the URL the fact came from. Return fewer items rather than filling gaps.`;

/**
 * 散文ではなく項目リストで返させる。
 *
 * 下流の RESEARCH_ONLY_NOTE は「固有名詞が調査ブロックに逐語で存在すること」を要求する。
 * 弱いローカルモデルに散文で要約させると言い換えが混ざり、その逐語照合が成立しなくなる。
 */
const summarySchema = normalizeJsonSchema({
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      maxItems: 12,
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          detail: { type: "STRING" },
          source: { type: "STRING" },
        },
        required: ["name", "detail"],
      },
    },
  },
  required: ["items"],
});

async function readBody(url: string): Promise<string> {
  try {
    const { text } = await fetchReadableText(url);
    return text;
  } catch (error) {
    // SPA や bot 避けサイトはここで落ちる。スニペットとカード情報で代替するので致命ではない。
    console.warn(
      `[WARN][AI_GROUNDING] body fetch failed: ${url} (${error instanceof Error ? error.message : String(error)})`,
    );
    return "";
  }
}

async function gatherMaterial(input: { queries: string[]; urls: string[] }): Promise<{
  sources: ResearchSource[];
  infoboxes: string[];
}> {
  const searched = await Promise.all(
    input.queries.slice(0, MAX_QUERIES).map(async (query) => {
      try {
        return await searxngSearch(query);
      } catch (error) {
        console.warn(`[WARN][AI_GROUNDING] search failed: ${query}`, error);
        return null;
      }
    }),
  );

  const infoboxes: string[] = [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const result of searched) {
    if (!result) continue;
    infoboxes.push(...result.infoboxes);
    // 同じ URL が複数クエリから返る。本文取得を二重に走らせない。
    for (const hit of result.hits) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }

  // 利用者が投稿に含めた URL は検索結果より優先して読む。
  const userUrls = input.urls.slice(0, MAX_URLS).filter((url) => !seen.has(url));
  const bodies = await Promise.all([
    ...userUrls.map(readBody),
    ...hits.slice(0, FETCH_TOP_N).map((hit) => readBody(hit.url)),
  ]);

  const sources: ResearchSource[] = [];
  userUrls.forEach((url, index) => {
    sources.push({ title: "", url, body: bodies[index] });
  });
  hits.forEach((hit, index) => {
    // 上位 FETCH_TOP_N 件は本文、それ以外はスニペットで代用する。
    // 本文取得に失敗した場合もスニペットへ落ちる。
    const body = (index < FETCH_TOP_N ? bodies[userUrls.length + index] : "") || hit.content;
    sources.push({ title: hit.title, url: hit.url, body });
  });
  return { sources: sources.filter((source) => source.body), infoboxes };
}

/**
 * 調査素材を num_ctx に収まる範囲で詰める。
 *
 * generationClient 側にも緊急トリムはあるが、あれは「末尾を残して切る」ので先頭に
 * 置いた infobox と上位の検索結果が丸ごと消える。ここで先に予算内へ収める。
 *
 * 文字数からトークン数を換算してはいけない。ASCII は 3.5 文字で 1 トークン、日本語は
 * 1 文字で 1.1 トークンと比が 4 倍近く違ううえ、安全係数とメッセージ overhead も乗る。
 * 実測では「3 文字＝1 トークン」と見積もって 39,855/31,616 トークンの超過を出した。
 * generationClient と同じ estimateMessagesTokens で測り、二分探索で詰める。
 */
function packCorpus(sources: ResearchSource[], infoboxes: string[]): string {
  const budget = ollamaPromptBudget({
    numCtx: ollamaTextContextLength(),
    outputTokens: SUMMARY_OUTPUT_TOKENS,
  });
  const fits = (corpus: string) =>
    estimateMessagesTokens([
      { content: SUMMARY_INSTRUCTION },
      { content: corpus },
    ]) <= budget;

  const blocks: string[] = [];
  const join = (extra: string) => [...blocks, extra].join("\n\n");

  // infobox は Wikipedia/Wikidata 由来の定義。実在確認の核心なので先に入れる。
  for (const box of infoboxes) {
    const block = `[infobox] ${box}`;
    if (fits(join(block))) blocks.push(block);
  }

  for (const source of sources) {
    const head = `[source] ${source.title || source.url}\n${source.url}\n`;
    if (fits(join(head + source.body))) {
      blocks.push(head + source.body);
      continue;
    }
    // 丸ごと入らない場合は、入るところまで切って予算を使い切る。
    let low = 0;
    let high = source.body.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(join(head + source.body.slice(0, mid)))) low = mid;
      else high = mid - 1;
    }
    if (low) blocks.push(head + source.body.slice(0, low));
    // 1件でも入り切らなくなったら以降も入らない。
    break;
  }
  return blocks.join("\n\n");
}

function renderSummary(parsed: unknown, sources: ResearchSource[]): string {
  const items = Array.isArray((parsed as any)?.items) ? (parsed as any).items : [];
  const lines: string[] = [];
  for (const item of items) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const detail = typeof item?.detail === "string" ? item.detail.trim() : "";
    if (!name) continue;
    const source = typeof item?.source === "string" ? item.source.trim() : "";
    lines.push(`- ${name}${detail ? ` — ${detail}` : ""}${source ? ` (${source})` : ""}`);
  }
  if (!lines.length) return "";
  // 出典は API が返した URL を機械的に並べる。要約モデルに URL を書かせない
  // （ローカルモデルは平気で存在しない URL を作る）。
  const urls = [...new Set(sources.map((source) => source.url))].slice(0, 8);
  return `${lines.join("\n")}\n\nSources:\n${urls.map((url) => `- ${url}`).join("\n")}`;
}

/**
 * 自宅ホストの SearXNG と自前の本文取得だけで調査する。Gemini は使わない。
 *
 * 呼ばれるのは required / preferred のバッチ機能だけ（リプライ系は非同期ワーカーへ
 * 回す）。素材が何ひとつ集まらなかったときだけ throw し、required の
 * 「調べられなければ生成しない」契約を保つ。
 */
export async function researchSelfHosted(input: {
  queries: string[];
  urls: string[];
}): Promise<string> {
  const { sources, infoboxes } = await gatherMaterial(input);
  if (!sources.length && !infoboxes.length)
    throw new Error("Self-hosted research returned no material");

  const corpus = packCorpus(sources, infoboxes);
  if (!corpus) throw new Error("Self-hosted research produced an empty corpus");

  const response = await generateContentForProvider("ollama", {
    model: aiModel("GROUNDING_RESEARCH"),
    config: {
      temperature: 0,
      maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseSchema: summarySchema,
      systemInstruction: SUMMARY_INSTRUCTION,
    },
    contents: [{ role: "user", parts: [{ text: corpus }] }],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch (error) {
    throw new Error("Self-hosted research summary was not valid JSON", { cause: error });
  }
  const text = renderSummary(parsed, sources);
  if (!text) throw new Error("Self-hosted research summary contained no items");
  return text.slice(0, RESEARCH_TEXT_LIMIT);
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
 * Ollama 最終生成の前処理。
 *
 * 検索へ渡すのはローカル planner が作った検索語と URL だけで、元投稿・会話履歴・
 * SYSTEM_INSTRUCTION・DID は渡さない。宛先が Gemini から自宅の SearXNG になっても
 * この制約は変えない。
 *
 * リプライ系（deferred）はここで検索しない。ローカル推論を本生成の 1 回に抑えるため、
 * 調べる方は NagiResearchWorker が非同期で回す。
 */
export async function prepareOllamaGrounding(
  feature: AiFeatureKey | undefined,
  params: any,
  deps: GroundingDeps = {},
  researchMemory?: string | null,
): Promise<any> {
  const stripped = stripGroundingTools(params);
  const policy = groundingPolicyForFeature(feature);
  if (policy === "off" || !hasGroundingTools(params)) return stripped;

  // 同期パスでは調べない。ここで planner も検索も呼ばないことがレイテンシ改善の本体。
  //
  // 代わりに、NagiResearchWorker が先に調べて bot memory へ入れた分があればそれを渡す。
  // 事前に調べてある話題なら答えられ、無ければ「知らない」と言う。
  if (policy === "deferred") {
    const remembered = researchMemory?.trim();
    return remembered
      ? appendResearch(stripped, remembered, true)
      : appendResearch(stripped, DEFERRED_RESEARCH_NOTE);
  }

  // AI_GROUNDING_PROVIDER=off でも、実在確認が要る機能には「調べられなかった」ことを
  // 必ず伝える。黙って素通りさせると、今期作品や気分ソングで存在しない作品名を平気で作る。
  if (!isAiGroundingEnabled()) return appendResearch(stripped, UNAVAILABLE_RESEARCH_NOTE);

  const subject = latestUserText(params.contents);
  if (!subject) return stripped;
  try {
    const plan = await (deps.plan ?? planResearch)(params.model, subject, true);
    if (!plan.needed) return stripped;
    const queries = plan.queries.length
      ? plan.queries
      : requiredFallbackQueries(feature);
    if (!queries.length && !plan.urls.length) {
      throw new Error("Grounding planner returned no safe query or URL");
    }
    const research = await (deps.research ?? researchSelfHosted)({
      queries,
      urls: plan.urls,
    });
    console.log(
      `[INFO][AI_GROUNDING] feature=${feature ?? "unknown"} queries=${queries.length} urls=${plan.urls.length}`,
    );
    // required / preferred は実在確認が目的なので、固有名詞の出所を調査結果に限定する。
    return appendResearch(stripped, research, true);
  } catch (error) {
    if (policy === "required") throw error;
    console.warn(
      `[WARN][AI_GROUNDING] feature=${feature ?? "unknown"} unavailable; continuing without external facts`,
      error,
    );
    return appendResearch(stripped, UNAVAILABLE_RESEARCH_NOTE);
  }
}
