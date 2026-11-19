/**
 * 共通の検索 gateway（searxng/gateway.py）を叩く検索クライアント。
 *
 * もとは自宅の SearXNG を叩いていた。2026-11-19 に gateway の中身を Web 検索 API
 * （Tavily → Exa lite、毎月の無料枠）へ替えたが、応答は SearXNG の JSON の形のままなので
 * ここの名前と環境変数（SEARXNG_*）は互換のため残している。
 * 無料枠を使い切った日は gateway が HTTP 429 を返す（呼び出し側は通常の検索失敗として扱う）。
 *
 * 【重要】ここで叩く先は設定済みの共通出口API（本番 http://192.168.1.200:8080）。
 * nagi-linkcard の `safeUrl` / `blockedAddress` はループバックと RFC1918 を遮断するので、
 * **この呼び出しを SSRF 検証に通してはいけない**。接続先は利用者入力から作らない。SSRF 検証を掛けるのは
 * 「利用者が投稿に含めた URL」と「検索結果として返ってきた URL」だけ。
 */

// 共通 gateway: キュー待ち最大10秒 + 上流15秒 + 通信の余裕。
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
/**
 * SearXNG 時代のエンジン指定。gateway は API に替わって engines を無視するが、
 * 古い gateway へ向けても動くよう送り続けている。
 */
export const DEFAULT_ENGINES = "yahoo,bing,wikipedia,wikidata";

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
  /**
   * 応答しなかったエンジンごとの理由（SearXNG の文言のまま。"timeout"、"Suspended: timeout"、
   * "too many requests"、"CAPTCHA" など）。制限と一時的な失敗を見分けるのに使う。
   */
  unresponsiveReasons?: Record<string, string>;
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

export type GatewaySource =
  | "grounding" | "knowledge-card" | "radio" | "topic-song" | "character" | "probe" | "live-research" | "research-page";

/**
 * gateway 経由の Wikipedia API（action=query）。Web 検索の無料枠を使わない。
 * 許される引数は gateway の request_path が決める（list=search / prop=extracts など）。
 */
export async function gatewayWikipediaQuery(
  language: string,
  params: Record<string, string>,
  options: { source: GatewaySource; signal?: AbortSignal },
): Promise<any> {
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error(`Unsupported Wikipedia language: ${language}`);
  const url = new URL(`${searxngBaseUrl()}/wikipedia/${language}`);
  for (const [key, value] of Object.entries({ action: "query", format: "json", ...params })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-Search-Source": options.source,
      ...(process.env.SEARXNG_API_KEY ? { Authorization: `Bearer ${process.env.SEARXNG_API_KEY}` } : {}),
    },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(Number(process.env.SEARXNG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(Number(process.env.SEARXNG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Wikipedia gateway HTTP ${response.status}`);
  return response.json();
}

/** Wikipedia の全文検索（list=search）。抜粋の HTML ハイライトは外して返す。 */
export async function searchWikipediaTitles(
  query: string,
  options: { language?: string; limit?: number; source: GatewaySource; signal?: AbortSignal },
): Promise<{ title: string; snippet: string; url: string }[]> {
  const language = options.language ?? "ja";
  const body = await gatewayWikipediaQuery(language, {
    list: "search", srsearch: query, srlimit: String(options.limit ?? 3),
  }, options);
  return (body?.query?.search ?? [])
    .map((item: any) => {
      const title = typeof item?.title === "string" ? item.title : "";
      const snippet = typeof item?.snippet === "string"
        ? item.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
        : "";
      return { title, snippet, url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` };
    })
    .filter((hit: { title: string }) => hit.title);
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
export async function searxngSearch(
  query: string,
  options: {
    language?: "ja" | "en";
    source?: GatewaySource;
    /** 送信先のエンジンを1つに絞るとき（関連性の監視でエンジンごとに確かめる）。既定は SEARXNG_ENGINES。 */
    engines?: string;
    /** 呼び出し側の締め切り（その場調べなど）。既定のタイムアウト（30秒）と併用する。 */
    signal?: AbortSignal;
  } = {},
): Promise<SearxngResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], infoboxes: [], unresponsiveEngines: [] };

  const url = new URL(`${searxngBaseUrl()}/search`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", options.language ?? "ja");
  url.searchParams.set("categories", "general");
  url.searchParams.set("safesearch", "1");
  url.searchParams.set("engines", options.engines?.trim() || searxngEngines());

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json", "X-Search-Source": options.source ?? "grounding",
        ...(process.env.SEARXNG_API_KEY ? { Authorization: `Bearer ${process.env.SEARXNG_API_KEY}` } : {}),
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(Number(process.env.SEARXNG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)])
        : AbortSignal.timeout(Number(process.env.SEARXNG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
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
  let body: RawBody;
  try {
    body = (await response.json()) as RawBody;
    if (!body || !Array.isArray(body.results)) throw new Error("Invalid SearXNG search JSON");
  } catch (error) {
    reportSearchCall("error");
    throw error;
  }
  reportSearchCall("ok");
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

  // 呼び出し側との互換性は名前配列のまま。ログには原因と件数も残す。
  const unresponsiveEngines: string[] = [];
  const engineErrors: string[] = [];
  const unresponsiveReasons: Record<string, string> = {};
  for (const item of Array.isArray(body.unresponsive_engines)
    ? body.unresponsive_engines
    : []) {
    const name = Array.isArray(item) ? text(item[0]) : text(item);
    if (name) {
      unresponsiveEngines.push(name);
      const reason = Array.isArray(item) ? text(item[1]) : "";
      unresponsiveReasons[name] = reason;
      engineErrors.push(`${name}${reason ? ` (${reason})` : ""}`);
    }
  }
  if (unresponsiveEngines.length) {
    // 上流に弾かれ始めた合図。結果が薄いときの原因究明はここを見る。
    console.warn(
      `[WARN][SEARXNG] source=${options.source ?? "grounding"} unresponsive engines: ${engineErrors.join(", ")}; hits=${hits.length} infoboxes=${infoboxes.length}`,
    );
  }

  return { hits, infoboxes, unresponsiveEngines, unresponsiveReasons };
}
