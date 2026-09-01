/**
 * 自宅ホストの SearXNG を叩く検索クライアント。
 *
 * grounding の調査段を Gemini + Google Search から置き換えるためのもの。API キーも
 * アカウントも要らないので、利用者が第三者サービスの規約に同意する関係が生まれない
 * （18歳以上要件の根拠だった Gemini 規約を外すのが目的）。
 *
 * 【重要】ここで叩く先は自分自身（bot 機の loopback、既定 http://127.0.0.1:8080）。
 * nagi-linkcard の `safeUrl` / `blockedAddress` はループバックと RFC1918 を遮断するので、
 * **この呼び出しを SSRF 検証に通してはいけない**。SSRF 検証を掛けるのは
 * 「利用者が投稿に含めた URL」と「検索結果として返ってきた URL」だけ。
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;
/**
 * bing = 一覧・時事の索引。wikipedia / wikidata = 固有名詞の実在確認。
 *
 * wikipedia と wikidata は `results` ではなく **infobox** を返す。
 * 「薬屋のひとりごと」で『日向夏による日本のライトノベル』という定義が取れるので、
 * RESEARCH_ONLY_NOTE が要求する実在確認にそのまま効く。必ず入れておくこと。
 *
 * duckduckgo は外してある。自前インスタンスからだと CAPTCHA (jp-jp) を返し続け、
 * 実測では全クエリで応答なし。残すと毎回タイムアウト待ちが乗るだけになる。
 */
export const DEFAULT_ENGINES = "bing,wikipedia,wikidata";

/** 実際に問い合わせるエンジン。プローブと表示を揃えるために公開する。 */
export function searxngEngines(): string {
  return process.env.SEARXNG_ENGINES?.trim() || DEFAULT_ENGINES;
}

export type SearchHit = {
  title: string;
  url: string;
  content: string;
  engine?: string;
  publishedDate?: string;
};

export type SearxngResponse = {
  hits: SearchHit[];
  /** Wikidata / Wikipedia 由来の要約。固有名詞の実在確認に効くので捨てない。 */
  infoboxes: string[];
  /** 上流エンジンにブロックされたことの検知に使う。 */
  unresponsiveEngines: string[];
};

type RawResult = {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  engine?: unknown;
  publishedDate?: unknown;
};

type RawInfobox = {
  infobox?: unknown;
  content?: unknown;
  /** Wikipedia / Wikidata の記事 URL。Sources 行を機械的に組み立てるのに使う。 */
  id?: unknown;
};

type RawBody = {
  results?: unknown;
  infoboxes?: unknown;
  unresponsive_engines?: unknown;
};

export function isSearxngConfigured(): boolean {
  return Boolean(process.env.SEARXNG_BASE_URL?.trim());
}

/**
 * 検索回数の計上。LLM 呼び出しではないので rpd / localRpd とは別カウンタにする。
 * ここを rpd に混ぜると、課金枠を使っていないのに Gemini の日次上限判定
 * （MemoryService.checkRPD、2000/日）に引っかかって bsky の全機能が止まる。
 *
 * `@bsky-affirmative-bot/database` は import しただけで dotenv を読み Postgres
 * クライアントを作るので、検索を呼ばないユニットテストを巻き込まないよう遅延 import する。
 */
function reportSearchCall(outcome: "ok" | "error"): void {
  void (async () => {
    try {
      const { MemoryService } = await import("@bsky-affirmative-bot/database");
      await MemoryService.incrementStats(
        outcome === "ok" ? "searchRpd" : "searchRpdError",
        1,
      );
    } catch {
      // 計上の失敗で検索そのものを落とさない。
    }
  })();
}

function searxngBaseUrl(): string {
  const configured = process.env.SEARXNG_BASE_URL?.trim();
  if (!configured) throw new Error("SEARXNG_BASE_URL is not configured");
  return configured.replace(/\/+$/, "");
}

function maxResults(): number {
  const raw = Number(process.env.SEARXNG_MAX_RESULTS);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_RESULTS;
  return Math.min(10, Math.max(1, Math.trunc(raw)));
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * SearXNG は結果ゼロでも 200 を返す。呼び出し側が「検索できなかった」と
 * 「検索したが何も無かった」を区別できるよう、ここでは throw せず空配列を返す。
 * required 機能の throw 判定は上位（全クエリ全滅かどうか）で行う。
 */
export async function searxngSearch(query: string): Promise<SearxngResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], infoboxes: [], unresponsiveEngines: [] };

  const url = new URL(`${searxngBaseUrl()}/search`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "ja");
  url.searchParams.set("categories", "general");
  url.searchParams.set("safesearch", "1");
  url.searchParams.set("engines", searxngEngines());

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(
        Number(process.env.SEARXNG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    reportSearchCall("error");
    throw error;
  }
  if (!response.ok) {
    reportSearchCall("error");
    const detail = (await response.text()).slice(0, 1_000);
    // 403 は settings.yml の `search.formats` に json が無いときの典型。
    throw new Error(`SearXNG HTTP ${response.status}: ${detail}`, {
      cause: { status: response.status },
    });
  }
  reportSearchCall("ok");

  const body = (await response.json()) as RawBody;
  const limit = maxResults();

  const hits: SearchHit[] = [];
  for (const item of Array.isArray(body.results) ? body.results : []) {
    const raw = item as RawResult;
    const hitUrl = text(raw.url);
    const title = text(raw.title);
    if (!hitUrl || !title) continue;
    hits.push({
      title,
      url: hitUrl,
      content: text(raw.content),
      ...(text(raw.engine) ? { engine: text(raw.engine) } : {}),
      ...(text(raw.publishedDate) ? { publishedDate: text(raw.publishedDate) } : {}),
    });
    if (hits.length >= limit) break;
  }

  const infoboxes: string[] = [];
  for (const item of Array.isArray(body.infoboxes) ? body.infoboxes : []) {
    const raw = item as RawInfobox;
    const content = text(raw.content);
    if (!content) continue;
    const label = text(raw.infobox);
    const source = /^https?:\/\//.test(text(raw.id)) ? ` (${text(raw.id)})` : "";
    infoboxes.push(`${label ? `${label}: ` : ""}${content}${source}`);
  }

  // [["duckduckgo", "timeout"], ...] の形で来る。エンジン名だけ拾う。
  const unresponsiveEngines: string[] = [];
  for (const item of Array.isArray(body.unresponsive_engines)
    ? body.unresponsive_engines
    : []) {
    const name = Array.isArray(item) ? text(item[0]) : text(item);
    if (name) unresponsiveEngines.push(name);
  }
  if (unresponsiveEngines.length) {
    // 上流に弾かれ始めた合図。結果が薄いときの原因究明はここを見る。
    console.warn(
      `[WARN][SEARXNG] unresponsive engines: ${unresponsiveEngines.join(", ")}`,
    );
  }

  return { hits, infoboxes, unresponsiveEngines };
}
