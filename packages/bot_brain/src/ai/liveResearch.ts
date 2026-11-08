import {
  aiModel,
  isAiGroundingEnabled,
  languageData,
  type UserInfoGemini,
} from "@bsky-affirmative-bot/shared-configs";
import { generateContentForProvider, normalizeJsonSchema } from "./generationClient.js";
import { searxngSearch, type SearchHit } from "../api/searxng/index.js";

/**
 * リプライのその場調べ。
 *
 * 【なぜ同期に戻すか】
 * 以前は体感の待ち時間を理由に、リプライの同期パスでは検索せず「知らないことは知らないと
 * 言う」にしていた。調べるのは裏のワーカーで、次に同じ語が来たときに効く設計だった。
 * しかし「最近 Nagi で遊戯王の話が多い」のような場面では、その場で共感できないと意味がない。
 * ユーザーは10秒程度の遅れなら許容すると明言している（2026-11-07）。
 *
 * 【流れ】
 * 1. 申告: 返信は書かせず、投稿の中の「知らない固有名詞」とそのジャンルだけを短く返させる
 *    （実測 中央値1.4秒）。ジャンルが付くので「トリシューラ」を「遊戯王」の語として調べられる。
 * 2. 記憶: 同じ語・同じジャンルの知識カードがあればそれを使い、検索しない。
 * 3. Web: 最初の1語は自前 SearXNG で「語 ジャンル」を検索し、上位の抜粋を使う（カード Wiki など。
 *    略称も検索エンジンが正式名へ解決する）。1件の返信につき1語、1日の上限つき。
 * 4. Wikipedia: 2語目以降と Web で取れなかった語は Wikipedia で引き、抜粋か本文の語の周辺を使う。
 *    LLM の要約は挟まない（ローカル推論が1回増えて遅くなるため）。
 * 5. 結果を返信の材料（researchMemory）に入れ、公開の文脈なら知識カードとして保存する。
 *
 * Web 検索（自前 SearXNG）は、IPv6 で出すようにして Yahoo の汚染が直った（2026-11-08）ので
 * 使う。最初に調べる1語だけ、1日の上限つき。結果の中身は searxngRelevance.ts が監視している。
 *
 * 【守ること】
 * - 外へ出すのは語とジャンルだけ。投稿本文は検索に渡さない（申告はローカル LLM）。
 * - 申告された語は投稿に実際に出ているものだけ採用する。モデルが作った語で検索しない。
 * - こっそりの文脈で調べたものは公開の記憶に保存しない（botMemoryImpressions と同じ規則）。
 * - 締め切り（既定5秒）を超えたら、そこまでに取れた材料だけで返信へ進む。
 */

export type LiveResearchTerm = { term: string; context: string };

export type LiveResearchCard = {
  term: string;
  context: string;
  content: string;
  source: "memory" | "wikipedia" | "web";
  /** term は申告された語、work は語が属する作品そのもの（「遊戯王」など）のカード。 */
  kind?: "term" | "work";
};

export type LiveResearchResult = {
  terms: LiveResearchTerm[];
  cards: LiveResearchCard[];
  /** 返信の材料。その場で取ったカード＋ジャンルが合う既存のカード。何も無ければ null。 */
  researchMemory: string | null;
  /** 既存の材料のうち、申告された語のジャンルに合わず外したカードの見出し語。 */
  droppedTerms: string[];
  elapsedMs: number;
  timedOut: boolean;
};

type WebResearchCardLike = { term: string; context: string | null; content: string };

export type LiveResearchDeps = {
  plan?: (text: string, signal: AbortSignal) => Promise<LiveResearchTerm[]>;
  findCards?: (terms: string[]) => Promise<WebResearchCardLike[]>;
  searchWikipedia?: (
    term: string,
    context: string,
    signal: AbortSignal,
    language: string,
    allowExtract: boolean,
  ) => Promise<{ content: string; titles: string[] } | null>;
  searchWeb?: (
    term: string,
    context: string,
    signal: AbortSignal,
    language: string,
  ) => Promise<{ content: string; titles: string[] } | null>;
  saveCard?: (card: LiveResearchCard, titles: string[], language: string) => Promise<void>;
  now?: () => number;
};

/**
 * 調べる時間の上限。生成と合わせて、混雑時でも合計がおおむね10秒前後に収まるようにする。
 * 8秒では合計の p90 が12秒（2026-11-07）。Web 検索を先にした版は、ゲートウェイの待ち行列
 * （1リクエストごとに1秒空ける）の分だけ調べる時間が延び、6秒で合計 p90 11.4秒だった（2026-11-08）。
 */
const DEFAULT_DEADLINE_MS = 5_000;
const MAX_TERMS = 3;
/**
 * Wikipedia を引く語の上限。記憶との照合は申告された語すべてで行う。
 * ゲートウェイは1リクエストごとに1秒以上空けるので、3語を引くと締め切りを超えやすい
 * （実測: 3語で8秒の締め切りに達した）。
 */
const MAX_SEARCH_TERMS = 2;
/**
 * Web 検索（自前 SearXNG）は1件の返信につき1語まで、1日の上限つき。
 *
 * 検索はスクレイピングで、量が多いと上流にボットとして目を付けられる。自宅の IPv4 は
 * 1日300回前後のスクレイピングを数週間続けたあと、Yahoo に汚染された結果を返されるように
 * なった（2026-11）。今は IPv6 で出しているが、同じことを繰り返さないよう Wikipedia で
 * 取れなかった語だけに使い、量を絞る。上限はプロセスごと（nagi-bot と bsky-bot で別々に数える）。
 */
const MAX_WEB_SEARCHES_PER_REPLY = 1;
/** Wikipedia の本文を取りに行くのに必要な残り時間。足りなければ抜粋だけで判断する。 */
const EXTRACT_MIN_REMAINING_MS = 2_500;
const DEFAULT_WEB_DAILY_LIMIT = 50;

let webBudget = { day: "", used: 0 };

function webDailyLimit(): number {
  const raw = Number(process.env.AI_LIVE_RESEARCH_WEB_DAILY);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WEB_DAILY_LIMIT;
}

/** 今日の Web 検索の枠を1つ使う。使い切っていれば false。 */
function takeWebBudget(now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  if (webBudget.day !== day) webBudget = { day, used: 0 };
  if (webBudget.used >= webDailyLimit()) return false;
  webBudget.used++;
  return true;
}

/** テスト用。日ごとの Web 検索の枠を空に戻す。 */
export function resetLiveResearchWebBudget(): void {
  webBudget = { day: "", used: 0 };
}
const MAX_TERM_LENGTH = 40;
const MAX_CONTEXT_LENGTH = 30;
const EXCERPT_BEFORE = 150;
const EXCERPT_AFTER = 350;
const MAX_EXCERPTS_PER_ARTICLE = 2;
const MAX_ARTICLES = 2;
const MAX_CARD_CHARS = 1_200;

/** その場調べを使うか。`AI_LIVE_RESEARCH=0` で止められる（切り戻し用）。 */
export function isLiveResearchEnabled(): boolean {
  return process.env.AI_LIVE_RESEARCH !== "0" && isAiGroundingEnabled();
}

function deadlineMs(): number {
  const raw = Number(process.env.AI_LIVE_RESEARCH_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

/**
 * 照合用の正規化。全角半角・大小文字・区切り記号（中黒、空白、ハイフン、☆）の揺れを吸収する。
 * 「シャイニング・ネオス・ウィングマン」と「シャイニングネオスウィングマン」、
 * 「遊☆戯☆王」と「遊戯王」を同じものとして扱う。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s・･\-－‐☆★]/g, "");
}

const PLAN_INSTRUCTION =
  `投稿に出てくる固有名詞（作品・ゲーム・カード・キャラクター・人物・商品・イベント・用語）のうち、あなたが具体的に説明できないものを最大${MAX_TERMS}つ挙げる。
- term には投稿に書かれているとおりの名詞を書く。文や言い回し（「〜になれる」「神！」など）は含めない。言い換えたり補ったりしない。
- context には、その語が属する作品・ゲーム・シリーズの名前だけを短く書く（例: 遊戯王、ポケモンカード、メイドインアビス）。投稿の他の語から判断してよい。
- アプリ・食べ物・飲み物・機械など、特定の作品やシリーズに属さないものは context を空文字にする。「アプリ」「アニメの作品名」のような説明は書かない。
- よく知っているもの・一般的な言葉・人のハンドルや表示名は挙げない。
- 無ければ空配列を返す。`;

const planSchema = () => normalizeJsonSchema({
  type: "OBJECT",
  properties: {
    terms: {
      type: "ARRAY",
      maxItems: MAX_TERMS,
      items: {
        type: "OBJECT",
        properties: { term: { type: "STRING" }, context: { type: "STRING" } },
        required: ["term", "context"],
      },
    },
  },
  required: ["terms"],
});

/**
 * 申告をそのまま信用しない。投稿に実際に出ている語だけを残す。
 *
 * モデルが補った語（「ラー」から「ラーの翼神竜」を作るなど）で検索すると、投稿と関係ない
 * 外部の情報を材料に入れることになる。語は投稿から取り、ジャンルだけをモデルに決めさせる。
 */
export function sanitizePlannedTerms(value: unknown, sourceText: string): LiveResearchTerm[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { terms?: unknown }).terms;
  if (!Array.isArray(raw)) return [];
  const normalizedSource = normalizeForMatch(sourceText);
  const seen = new Set<string>();
  const terms: LiveResearchTerm[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const term = typeof (item as any).term === "string"
      ? (item as any).term.replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH)
      : "";
    const context = typeof (item as any).context === "string"
      ? (item as any).context.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_LENGTH)
      : "";
    const key = normalizeForMatch(term);
    if ([...key].length < 2 || seen.has(key)) continue;
    // 句読点や感嘆符を含むものは語ではなく文（「目覚める神秘、神！」など）。
    if (/[、。，．！？!?「」『』…]/.test(term)) continue;
    if (/^https?:\/\//i.test(term) || term.startsWith("@")) continue;
    if (!normalizedSource.includes(key)) continue;
    seen.add(key);
    terms.push({ term, context });
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** 申告の材料。投稿本文と、引用している投稿の本文。 */
function planningText(userinfo: UserInfoGemini): string {
  return [userinfo.posts?.[0] ?? "", userinfo.embed?.text_embed ?? ""]
    .filter((text) => typeof text === "string" && text.trim())
    .join("\n");
}

async function planTerms(text: string, signal: AbortSignal): Promise<LiveResearchTerm[]> {
  const response = await generateContentForProvider("ollama", {
    model: aiModel("BSKY_AFFIRMATIVE_REPLY"),
    config: {
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
      responseSchema: planSchema(),
      systemInstruction: PLAN_INSTRUCTION,
      abortSignal: signal,
    },
    contents: [{ role: "user", parts: [{ text: text.slice(0, 4_000) }] }],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch {
    return [];
  }
  return sanitizePlannedTerms(parsed, text);
}

/**
 * ジャンルを表す語。照合と検索語に使う。
 *
 * モデルが書くジャンルは「遊戯王OCG/デュエルモンスターズ」「アニメ・漫画（ジョジョ）」の
 * ように揺れるので、最初の区切りまでを取る。
 */
export function contextKeyword(context: string): string {
  return context.split(/[\/／、,，(（・\s]/)[0]?.trim() ?? "";
}

/**
 * 既存の知識カードが、今回のジャンルの話として使えるか。
 *
 * 裏のワーカーが語だけで調べた古いカードは、一般的な意味になっていることが多い
 * （トリシューラ＝シヴァ神の槍、レモン＝果物）。カードの本文にジャンルの語が出ているか、
 * カード自体がそのジャンルで調べたものなら使う。ジャンルが分からないときは使う。
 */
export function cardMatchesContext(card: WebResearchCardLike, context: string): boolean {
  const keyword = normalizeForMatch(contextKeyword(context));
  if (!keyword) return true;
  if (card.context && normalizeForMatch(card.context).includes(keyword)) return true;
  const body = normalizeForMatch(card.content);
  if (body.includes(keyword)) return true;
  // 「遊戯王OCG」のような書き方は、本文の「遊戯王」でも一致させる。
  const shortened = keyword.replace(/ocg$/, "");
  return shortened.length >= 2 && shortened !== keyword && body.includes(shortened);
}

/** 語の各文字の間に区切り記号が入っていても一致する正規表現（中黒の有無などを吸収）。 */
function termPattern(term: string): RegExp {
  const chars = [...term.normalize("NFKC").replace(/[\s・･\-－‐]/g, "")];
  const escaped = chars.map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("[・･\\s\\-－‐]?"), "gi");
}

/** 記事の本文から、語の周辺だけを切り出す。語が出てこなければ空配列。 */
export function excerptsAround(text: string, term: string): string[] {
  const normalized = text.normalize("NFKC");
  const pattern = termPattern(term);
  const excerpts: string[] = [];
  let lastEnd = -1;
  for (const match of normalized.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index < lastEnd) continue;
    const start = Math.max(0, index - EXCERPT_BEFORE);
    const end = Math.min(normalized.length, index + match[0].length + EXCERPT_AFTER);
    excerpts.push(normalized.slice(start, end).replace(/\s+/g, " ").trim());
    lastEnd = end;
    if (excerpts.length >= MAX_EXCERPTS_PER_ARTICLE) break;
  }
  return excerpts;
}

function gatewayBase(): string {
  const base = process.env.SEARXNG_BASE_URL?.trim();
  if (!base) throw new Error("SEARXNG_BASE_URL is not configured");
  return base.replace(/\/+$/, "");
}

/**
 * 投稿の言語に対応する Wikipedia の言語版。分からなければ日本語版。
 *
 * 英語の投稿の「energy drink」を日本語版で引いていた（デプロイ直後の本番ログ、2026-11-07）。
 * 言語コードは languageData（ISO 639-1）で、Wikipedia のサブドメインと一致する。
 */
export function wikipediaLanguage(langStr: UserInfoGemini["langStr"]): string {
  if (!langStr) return "ja";
  return languageData.find((item) => item.name === langStr)?.code ?? "ja";
}

async function wikipediaQuery(params: Record<string, string>, signal: AbortSignal, language = "ja"): Promise<any> {
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error(`Unsupported Wikipedia language: ${language}`);
  const url = new URL(`${gatewayBase()}/wikipedia/${language}`);
  for (const [key, value] of Object.entries({ action: "query", format: "json", ...params })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-Search-Source": "live-research",
      ...(process.env.SEARXNG_API_KEY ? { Authorization: `Bearer ${process.env.SEARXNG_API_KEY}` } : {}),
    },
    signal,
  });
  if (!response.ok) throw new Error(`Wikipedia gateway HTTP ${response.status}`);
  return response.json();
}

/** 検索結果の抜粋（HTML のハイライトと実体参照を含む）をただの文字列にする。 */
function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 記事がそのジャンルの話か。ジャンルの語が記事名か本文に出ているかで見る。 */
function mentionsContext(text: string, keyword: string): boolean {
  const normalizedKeyword = normalizeForMatch(keyword);
  if (!normalizedKeyword) return true;
  const body = normalizeForMatch(text);
  if (body.includes(normalizedKeyword)) return true;
  const shortened = normalizedKeyword.replace(/ocg$/, "");
  return shortened.length >= 2 && shortened !== normalizedKeyword && body.includes(shortened);
}

/**
 * Wikipedia を「語 ジャンル」で検索し、語の周辺を材料にする。
 *
 * 語だけで検索すると一般的な意味の記事に当たる（トリシューラ → 三叉槍）。ジャンルを足すと
 * 評価用の遊戯王の語23個中20個で、遊戯王の記事が当たった（2026-11-07）。
 * 当たる記事はカード単体ではなく作品の記事のことが多い（BF－アーマード・ウィング →
 * 『遊☆戯☆王5D's』）ので、冒頭ではなく語の周辺を使う。
 *
 * 【速さ】ゲートウェイは前のリクエストの完了から1秒空けるので、リクエスト数がそのまま
 * 待ち時間になる。まず検索結果の抜粋（snippet）に語があればそれで済ませ（1回）、
 * 無いときだけ本文を1記事ずつ取る。
 *
 * 【ジャンルの確認】語が本文に出てくるだけでは採用しない。「氷水 遊戯王」で
 * 『はねるのトびら』の「氷水プールに落下する」が取れたことがある。記事名か本文に
 * ジャンルの語が出ている記事だけを使う。
 */
export async function searchWikipediaExcerpt(
  term: string,
  context: string,
  signal: AbortSignal,
  language = "ja",
  allowExtract = true,
): Promise<{ content: string; titles: string[] } | null> {
  const keyword = contextKeyword(context);
  const query = keyword ? `${term} ${keyword}` : term;
  const search = await wikipediaQuery({ list: "search", srsearch: query, srlimit: "3" }, signal, language);
  const hits: { title: string; snippet: string }[] = (search?.query?.search ?? [])
    .map((item: any) => ({
      title: typeof item?.title === "string" ? item.title : "",
      snippet: typeof item?.snippet === "string" ? cleanSnippet(item.snippet) : "",
    }))
    .filter((hit: { title: string }) => hit.title);

  // 1. 抜粋に語が出ていて、記事名か抜粋にジャンルの語があれば、それで足りる。
  const snippetHits = hits.filter((hit) =>
    excerptsAround(hit.snippet, term).length > 0 && mentionsContext(`${hit.title} ${hit.snippet}`, keyword)
  );
  if (snippetHits.length) {
    const used = snippetHits.slice(0, MAX_ARTICLES);
    return {
      content: used.map((hit) => `Wikipedia「${hit.title}」より: ${hit.snippet}`).join("\n").slice(0, MAX_CARD_CHARS),
      titles: used.map((hit) => hit.title),
    };
  }

  // 2. 本文を取り、語の周辺を切り出す。ジャンルの語が出てこない記事は使わない。
  if (!allowExtract) return null;
  const parts: string[] = [];
  const used: string[] = [];
  for (const { title } of hits.slice(0, MAX_ARTICLES)) {
    if (signal.aborted) break;
    const page = await wikipediaQuery({ prop: "extracts", explaintext: "1", titles: title }, signal, language);
    const text = Object.values<any>(page?.query?.pages ?? {})
      .map((item) => (typeof item?.extract === "string" ? item.extract : ""))
      .join("\n");
    if (!mentionsContext(`${title}\n${text}`, keyword)) continue;
    const excerpts = excerptsAround(text, term);
    if (!excerpts.length) continue;
    used.push(title);
    parts.push(`Wikipedia「${title}」より: ${excerpts.join(" … ")}`);
    // 1記事で語が取れれば十分。2記事目の取得は1秒以上の待ちになる。
    break;
  }
  if (!parts.length) return null;
  return { content: parts.join("\n").slice(0, MAX_CARD_CHARS), titles: used };
}

/**
 * 作品のカードの長さ。作品のカードは人物・カード・出来事の名前が多く並ぶので、
 * 長いほど語と語の関係を取り違える（評価で「海馬がラーの翼神竜でバトルシティを戦った」）。
 * 冒頭の概要に絞る。
 */
const MAX_WORK_CARD_CHARS = 600;

export function clipWorkCard(content: string): string {
  if (content.length <= MAX_WORK_CARD_CHARS) return content;
  const head = content.slice(0, MAX_WORK_CARD_CHARS);
  // 文の途中で切らない。最後の句点までにする（句点が無ければそのまま切る）。
  const lastStop = Math.max(head.lastIndexOf("。"), head.lastIndexOf("\n"));
  return lastStop > MAX_WORK_CARD_CHARS / 2 ? head.slice(0, lastStop + 1) : head;
}

function cardText(card: LiveResearchCard): string {
  // 見出し語を先頭に置く。保存したカードは次回、語の部分一致でも引けるようにするため
  // （botMemoryResearchWorker の knowledge_card と同じ並び）。
  const header = card.context ? `${card.term}（${card.context}）` : card.term;
  return card.content.startsWith(card.term) ? card.content : `${header}\n${card.content}`;
}

/**
 * その場調べの Web 検索で使うエンジン。既定は yahoo だけ。
 *
 * SEARXNG_ENGINES の既定には wikipedia / wikidata が入っているが、SearXNG の中のこの2つは
 * 要約枠（infobox）しか返さず、抜粋を使うその場調べには要らない（Wikipedia は API で直接引く）。
 * しかも wikidata が「too many requests」を返すと、ゲートウェイは出口全体を180秒止める。
 * 評価中に実際に起き、その3分間は本番の検索も止まった（2026-11-08）。
 */
function webEngines(): string {
  return process.env.AI_LIVE_RESEARCH_WEB_ENGINES?.trim() || "yahoo";
}

/** 検索結果の抜粋の先頭に付く日付（「1 day ago · 」「Oct 2, 2026 · 」）を外す。 */
function stripDatePrefix(snippet: string): string {
  return snippet.replace(/^[^·]{1,24}·\s*/, "").trim();
}

/**
 * 自前 SearXNG で「語 ジャンル」を検索し、上位の抜粋を材料にする（本文は取らない）。
 *
 * Wikipedia に載っていない細かい語（カード名・作中の設備など）用。カード Wiki や公式の
 * カード DB の抜粋がそのまま材料になる（「トリシューラ 遊戯王」→ 遊戯王カードWiki
 * 《氷結界の龍 トリシューラ》、「怨念炉 転生したら剣でした」→ 作中の設備の説明）。
 * 本文を取らないのは、検索1回で済ませて時間と上流へのアクセスを抑えるため。
 *
 * ジャンルが分かっているときは、記事名か抜粋にジャンルの語が出ている結果だけを使う
 * （語そのものが出ていなくてもよい。略称を検索エンジンが正式名へ解決した場合。
 * 「スカノヴァ 遊戯王」→《スカーレッド・ノヴァ・ドラゴン》）。ジャンルが空なら、
 * 語が出ている結果だけを使う。
 */
export async function searchWebExcerpt(
  term: string,
  context: string,
  signal: AbortSignal,
  language = "ja",
  search: typeof searxngSearch = searxngSearch,
): Promise<{ content: string; titles: string[] } | null> {
  const keyword = contextKeyword(context);
  const query = keyword ? `${term} ${keyword}` : term;
  const response = await search(query, {
    language: language === "ja" ? "ja" : "en",
    source: "live-research",
    engines: webEngines(),
    signal,
  });
  const usable = response.hits
    .slice(0, 5)
    .map((hit: SearchHit) => ({ ...hit, content: stripDatePrefix(hit.content ?? "") }))
    .filter((hit) => hit.content)
    .filter((hit) => {
      const text = `${hit.title} ${hit.content}`;
      // ジャンルが分かっていれば、そのジャンルの話であることを必須にする（語が出ていても
      // 別ジャンルのページ＝果物の「レモン」などは使わない）。語が出ていなくても、ジャンルが
      // 合っていれば略称の解決とみなす。ジャンルが空なら語が出ていることを必須にする。
      return keyword ? mentionsContext(text, keyword) : excerptsAround(text, term).length > 0;
    })
    .slice(0, MAX_ARTICLES);
  if (!usable.length) return null;
  // URL は材料に入れない。返信に URL を書かせない（urlGuard）ためと、出典は metadata に残すため。
  const lines = usable.map((hit) => `「${hit.title}」より: ${hit.content}`);
  const named = usable.some((hit) => excerptsAround(`${hit.title} ${hit.content}`, term).length);
  return {
    // 語そのものが出ていない（略称を解決した）結果だけのときは、そう明記する。
    content: (named ? lines : [`（「${term}」の検索結果）`, ...lines]).join("\n").slice(0, MAX_CARD_CHARS),
    titles: usable.map((hit) => hit.title),
  };
}

async function defaultFindCards(terms: string[]): Promise<WebResearchCardLike[]> {
  const { findWebResearchByTerms } = await import("@bsky-affirmative-bot/database");
  return findWebResearchByTerms(terms);
}

async function defaultSaveCard(card: LiveResearchCard, titles: string[], language: string): Promise<void> {
  const { researchSubjectHash, tryUpsertBotMemoryDocument } = await import("@bsky-affirmative-bot/database");
  // 日本語版以外は言語もキーに入れる（同じ語でも言語版で中身が違う）。日本語版は従来のキーのまま。
  const languageKey = language === "ja" ? "" : `\u0000${language}`;
  await tryUpsertBotMemoryDocument({
    sourceType: "web_research",
    // 語とジャンルの組で1枚。裏で語だけを調べた一般的な意味のカード（トリシューラ＝槍）を
    // 上書きしない。別のジャンルで話す人にはそちらが正しいこともある。
    sourceId: researchSubjectHash(`${card.term}\u0000${normalizeForMatch(contextKeyword(card.context))}${languageKey}`),
    content: cardText(card),
    occurredAt: new Date(),
    metadata: {
      term: card.term,
      context: card.context,
      format: card.source === "web" ? "web_snippet_v1" : "wikipedia_excerpt_v1",
      titles,
      language,
    },
  });
}

/**
 * 既存の材料（裏で調べた知識カード）のうち、申告された語のカードでジャンルが合わないものを外す。
 *
 * 外さないと、その場で取った正しい材料（遊戯王のトリシューラ）と一緒に、一般的な意味の
 * カード（シヴァ神の槍）が並び、しかも「固有名詞は材料からだけ使え」と縛られる。
 */
function filterExistingCards(
  existing: { term: string; content: string }[],
  terms: LiveResearchTerm[],
): { kept: { term: string; content: string }[]; dropped: string[] } {
  const kept: { term: string; content: string }[] = [];
  const dropped: string[] = [];
  for (const card of existing) {
    const planned = terms.find((item) => normalizeForMatch(item.term) === normalizeForMatch(card.term));
    if (planned && !cardMatchesContext({ ...card, context: null }, planned.context)) {
      dropped.push(card.term);
      continue;
    }
    kept.push(card);
  }
  return { kept, dropped };
}

/**
 * その場調べを行い、返信の材料を返す。失敗しても throw しない（材料なしで返信へ進む）。
 */
export async function runLiveResearch(
  userinfo: UserInfoGemini,
  deps: LiveResearchDeps = {},
): Promise<LiveResearchResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const controller = new AbortController();
  const deadlineAt = startedAt + deadlineMs();
  const timer = setTimeout(() => controller.abort(new Error("live research deadline")), deadlineMs());
  const existing = userinfo.researchCards ?? [];
  const language = wikipediaLanguage(userinfo.langStr);
  const cards: LiveResearchCard[] = [];
  let terms: LiveResearchTerm[] = [];
  let timedOut = false;

  try {
    const text = planningText(userinfo);
    if (text.trim()) terms = await (deps.plan ?? planTerms)(text, controller.signal);

    if (terms.length) {
      // 記憶にある語は検索しない。同じ語が何度も出る話題（遊戯王の「ラーの翼神竜」など）では
      // 2回目から検索の時間が消える。
      // 作品そのもののカード（「遊戯王」など）も同じ問い合わせで引く。投稿に出ていない
      // 同じ作品の要素（別のシリーズ・キャラ・カード）を返信で出すための引き出しになる。
      // 「わかってるな！」と思わせるには、相手の話を理解するだけでは足りない（2026-11-07）。
      const workKeywords = [...new Set(terms.map((item) => contextKeyword(item.context)).filter((word) => [...word].length >= 2))];
      const remembered = await (deps.findCards ?? defaultFindCards)([...terms.map((item) => item.term), ...workKeywords])
        .catch((error) => {
          console.warn("[WARN][LIVE_RESEARCH] 知識カードを引けなかった", error instanceof Error ? error.message : error);
          return [] as WebResearchCardLike[];
        });
      const workCard = workKeywords
        .map((keyword) => remembered.find((candidate) => normalizeForMatch(candidate.term) === normalizeForMatch(keyword)))
        .find(Boolean);
      let searched = 0;
      let webSearched = 0;
      for (const item of terms) {
        if (controller.signal.aborted) break;
        const card = remembered.find((candidate) =>
          normalizeForMatch(candidate.term) === normalizeForMatch(item.term) &&
          cardMatchesContext(candidate, item.context)
        );
        if (card) {
          cards.push({ term: item.term, context: item.context, content: card.content, source: "memory" });
          continue;
        }
        if (searched >= MAX_SEARCH_TERMS) continue;
        searched++;
        // 最初に調べる語は Web 検索（抜粋1回）を先にする。カード名のような細かい語は Wikipedia に
        // 載っていないことが多く、Wikipedia を先にすると検索＋本文取得の待ち（ゲートウェイは
        // 1リクエストごとに1秒空ける）で締め切りを使い切っていた（評価で33件中12件が時間切れ）。
        // Web 検索は1件の返信につき1語、1日の上限つき。2語目以降と、Web で取れなかった語は Wikipedia。
        let source: LiveResearchCard["source"] = "web";
        let result: { content: string; titles: string[] } | null = null;
        if (webSearched < MAX_WEB_SEARCHES_PER_REPLY && takeWebBudget()) {
          webSearched++;
          result = await (deps.searchWeb ?? searchWebExcerpt)(item.term, item.context, controller.signal, language)
            .catch((error) => {
              if (!controller.signal.aborted) {
                console.warn("[WARN][LIVE_RESEARCH] Web 検索に失敗", error instanceof Error ? error.message : error);
              }
              return null;
            });
        }
        if (!result && !controller.signal.aborted) {
          source = "wikipedia";
          // 本文の取得は、残り時間が十分あるときだけ（抜粋で足りなければ本文を1記事取る＝さらに1秒以上）。
          const allowExtract = deadlineAt - now() > EXTRACT_MIN_REMAINING_MS;
          result = await (deps.searchWikipedia ?? searchWikipediaExcerpt)(item.term, item.context, controller.signal, language, allowExtract)
            .catch((error) => {
              if (!controller.signal.aborted) {
                console.warn("[WARN][LIVE_RESEARCH] Wikipedia を引けなかった", error instanceof Error ? error.message : error);
              }
              return null;
            });
        }
        if (!result) continue;
        const liveCard: LiveResearchCard = { term: item.term, context: item.context, content: result.content, source };
        cards.push(liveCard);
        // こっそりの文脈では保存しない。保存先は公開の記憶で、定期ポストの根拠にもなる。
        if (userinfo.persistLiveResearch) {
          void (deps.saveCard ?? defaultSaveCard)(liveCard, result.titles, language).catch((error) => {
            console.warn("[WARN][LIVE_RESEARCH] 知識カードを保存できなかった", error instanceof Error ? error.message : error);
          });
        }
      }
      // 作品のカードは1枚だけ、語のカードの後ろに置く。語の説明の方が今回の投稿に近い。
      if (workCard && !cards.some((card) => normalizeForMatch(card.term) === normalizeForMatch(workCard.term))) {
        cards.push({
          term: workCard.term,
          context: workCard.term,
          content: clipWorkCard(workCard.content),
          source: "memory",
          kind: "work",
        });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("[WARN][LIVE_RESEARCH] その場調べに失敗。材料なしで返信へ進む", error instanceof Error ? error.message : error);
    }
  } finally {
    timedOut = controller.signal.aborted;
    clearTimeout(timer);
  }

  const { kept, dropped } = filterExistingCards(existing, terms);
  const liveTerms = new Set(cards.map((card) => normalizeForMatch(card.term)));
  const blocks = [
    ...cards.map(cardText),
    // その場で取ったカードと同じ語の古いカードは重ねない。
    ...kept.filter((card) => !liveTerms.has(normalizeForMatch(card.term))).map((card) => card.content),
    // researchCards を渡さない呼び出し側（文字列だけ）は、ジャンルで選り分けられないのでそのまま残す。
    ...(!existing.length && userinfo.researchMemory?.trim() ? [userinfo.researchMemory.trim()] : []),
  ];
  const researchMemory = blocks.length ? blocks.join("\n\n") : null;

  return {
    terms,
    cards,
    researchMemory,
    droppedTerms: dropped,
    elapsedMs: now() - startedAt,
    timedOut,
  };
}
