import type { HealthState } from "@bsky-affirmative-bot/database";
import { startWorkerLoop } from "@bsky-affirmative-bot/bot-runtime";
import {
  isSearxngConfigured,
  searxngEngines,
  searxngSearch,
  type SearxngResponse,
} from "@bsky-affirmative-bot/bot-brain";

/**
 * 自前 SearXNG の「検索結果の中身」の監視。
 *
 * 【なぜ要るか】
 * healthMonitor の probeSearxng は /healthz に答えるかしか見ていない。2026-11-07 に分かった
 * 汚染は、HTTP 200・応答しないエンジン無し・件数もそろう、という形で起きていた。
 *   - Yahoo: 自宅の IPv4 からだと、クエリと無関係な結果（他人の検索のようなもの）を返す
 *   - Bing: IP に関係なく、日本語クエリの頭の一語だけで検索する（「トリシューラ」→「トリ」）
 * 知識カードはこれを材料に作られ、「トリシューラ＝シヴァ神の槍」のようなジャンル違いが
 * 返信に混ざっていた。中身を見ないと気づけない。
 *
 * 【やり方】
 * 決まった語をエンジンごとに検索し、期待する語が上位に出るかを見る。6時間ごと。
 * 30秒ごとの死活監視に混ぜないのは、検索そのものがスクレイピングで、回数が多いと
 * 上流にボットとして目を付けられるから（3語×2エンジン×1日4回＝24回/日）。
 *
 * 【答えが返らなかった語は「無関係」に数えない】
 * 2026-11-09 に state=down が2回出たが、どちらも汚染ではなかった。1語目で Yahoo が
 * timeout（または接続エラー）になると、SearXNG がその場で Yahoo を数秒 Suspended にし、
 * gateway の1秒間隔で続く2語も巻き添えで0件になって 0/3 と判定されていた。
 * そこで1語ごとの結果を3つに分ける。
 *   - relevant / irrelevant: エンジンが答えた。中身で判定する（0件も「答えた」側）
 *   - blocked: too many requests / CAPTCHA / access denied、または gateway の 429。
 *     上流に弾かれた合図なので外れとして数える
 *   - unanswered: timeout・HTTP error・parsing error など。Suspended が解けるのを待って
 *     1回だけ引き直し、それでも答えなければ判定から外す（「確認できず」として記録）
 */

export type RelevanceCanary = {
  query: string;
  /** 上位の結果のどれかに含まれていてほしい語（小文字・全角半角は吸収して照合）。 */
  expect: string[];
};

/**
 * 監視に使う語。どれも、まともな検索エンジンなら上位が必ずその作品のページになるもの。
 * 日本語の固有名詞（Bing の頭の一語問題を拾う）と英語（Yahoo の汚染は言語に関係なく出た）を混ぜる。
 */
export const RELEVANCE_CANARIES: RelevanceCanary[] = [
  { query: "葬送のフリーレン", expect: ["フリーレン"] },
  { query: "超融合 遊戯王", expect: ["超融合"] },
  { query: "Puella Magi Madoka Magica", expect: ["madoka", "まどか"] },
];

const TOP_N = 3;
const INTERVAL_MS = 6 * 60 * 60_000;
/**
 * 答えが返らなかった語を引き直すまでの待ち。SearXNG は失敗したエンジンを
 * ban_time_on_fail（既定5秒）× 連続失敗回数だけ Suspended にするので、それより長く待つ。
 */
const RETRY_DELAY_MS = 15_000;
/** エンジンごとに、この割合以上の語で期待どおりなら正常とみなす。 */
const PASS_RATIO = 2 / 3;

export type EngineRelevance = {
  engine: string;
  passed: number;
  /** 判定できた語の数（答えが返らなかった語は含めない）。 */
  total: number;
  /** 期待どおりでなかった語と、そのときの1位のタイトル（原因を追うため）。 */
  failures: { query: string; top: string }[];
  /** 引き直しても答えが返らず、判定から外した語とその理由。 */
  unanswered?: { query: string; reason: string }[];
};

export type CanaryOutcome =
  | { kind: "relevant" }
  | { kind: "irrelevant"; top: string }
  | { kind: "blocked"; reason: string }
  | { kind: "unanswered"; reason: string };

export type RelevanceResult = {
  state: HealthState;
  checkedAt?: string;
  lastOkAt?: string;
  lastError?: string;
  engines: EngineRelevance[];
};

type Search = (query: string, options: { engines: string; source: "probe" }) => Promise<SearxngResponse>;

/** 上流に弾かれたことを示す理由。SearXNG の文言（"Suspended: " 付きも含む）と gateway の 429。 */
const BLOCKED_REASON = /too many requests|captcha|access denied|cloudflare|\bHTTP 429\b/i;

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 監視するエンジン。wikipedia / wikidata は通常の結果を返さない（infobox だけ）ので外す。 */
export function enginesToCheck(configured = searxngEngines()): string[] {
  return configured
    .split(",")
    .map((engine) => engine.trim())
    .filter((engine) => engine && engine !== "wikipedia" && engine !== "wikidata");
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function isRelevant(response: SearxngResponse, canary: RelevanceCanary): boolean {
  const expected = canary.expect.map(normalize);
  return response.hits.slice(0, TOP_N).some((hit) => {
    const text = normalize(`${hit.title} ${hit.content} ${safeDecode(hit.url)}`);
    return expected.some((word) => text.includes(word));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 60) : String(error);
}

/** 1語の検索結果を、そのエンジンについて分類する。 */
export function classifyCanary(engine: string, response: SearxngResponse, canary: RelevanceCanary): CanaryOutcome {
  if (response.unresponsiveEngines.includes(engine)) {
    const reason = response.unresponsiveReasons?.[engine] || "unresponsive";
    return BLOCKED_REASON.test(reason) ? { kind: "blocked", reason } : { kind: "unanswered", reason };
  }
  if (isRelevant(response, canary)) return { kind: "relevant" };
  return { kind: "irrelevant", top: response.hits[0]?.title?.slice(0, 40) ?? "" };
}

export function classifySearchError(error: unknown): CanaryOutcome {
  const reason = errorMessage(error);
  return BLOCKED_REASON.test(reason) ? { kind: "blocked", reason } : { kind: "unanswered", reason };
}

/** エンジンごとの結果から、監視の状態を決める。 */
export function summarizeRelevance(engines: EngineRelevance[], now = new Date()): RelevanceResult {
  if (!engines.length) return { state: "unconfigured", engines };
  const judged = engines.filter((item) => item.total > 0);
  const failing = judged.filter((item) => item.passed / item.total < PASS_RATIO);
  const checkedAt = now.toISOString();
  if (!failing.length) {
    // どのエンジンも1語も答えなかった。汚染とも正常とも言えないので unknown にする。
    if (!judged.length) {
      return { state: "unknown", checkedAt, lastError: `確認できず: ${describeUnanswered(engines)}`, engines };
    }
    return { state: "ok", checkedAt, lastOkAt: checkedAt, engines };
  }
  const lastError = failing
    .map((item) => {
      const example = item.failures[0];
      return `${item.engine}: ${item.passed}/${item.total}` +
        (example ? `（「${example.query}」→ ${example.top || "0件"}）` : "");
    })
    .join(" / ");
  // 一部のエンジンだけなら検索自体は成り立つ（残りのエンジンが返す）ので stale。全滅なら down。
  return { state: failing.length === engines.length ? "down" : "stale", checkedAt, lastError, engines };
}

function describeUnanswered(engines: EngineRelevance[]): string {
  return engines
    .filter((item) => item.unanswered?.length)
    .map((item) => {
      const reasons = [...new Set(item.unanswered!.map((entry) => entry.reason))].join(", ");
      return `${item.engine}（${item.unanswered!.length}語: ${reasons}）`;
    })
    .join(" / ");
}

/** ログ用の1行。判定できなかった語があれば添える。 */
export function formatRelevanceSummary(engines: EngineRelevance[]): string {
  return engines
    .map((item) => {
      const skipped = item.unanswered?.length
        ? `（確認できず${item.unanswered.length}: ${[...new Set(item.unanswered.map((entry) => entry.reason))].join(", ")}）`
        : "";
      return `${item.engine}=${item.passed}/${item.total}${skipped}`;
    })
    .join(" ");
}

export async function checkSearxngRelevance(
  deps: {
    search?: Search;
    engines?: string[];
    canaries?: RelevanceCanary[];
    now?: Date;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<RelevanceResult> {
  const search: Search = deps.search ?? ((query, options) => searxngSearch(query, options));
  const engines = deps.engines ?? enginesToCheck();
  const canaries = deps.canaries ?? RELEVANCE_CANARIES;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempt = async (engine: string, canary: RelevanceCanary): Promise<CanaryOutcome> => {
    try {
      return classifyCanary(engine, await search(canary.query, { engines: engine, source: "probe" }), canary);
    } catch (error) {
      return classifySearchError(error);
    }
  };
  const results: EngineRelevance[] = [];
  for (const engine of engines) {
    const item: EngineRelevance = { engine, passed: 0, total: 0, failures: [], unanswered: [] };
    for (const canary of canaries) {
      let outcome = await attempt(engine, canary);
      if (outcome.kind === "unanswered") {
        // SearXNG の Suspended が解けるのを待ってから1回だけ引き直す。
        await sleep(RETRY_DELAY_MS);
        outcome = await attempt(engine, canary);
      }
      switch (outcome.kind) {
        case "relevant":
          item.passed++;
          item.total++;
          break;
        case "irrelevant":
          item.total++;
          item.failures.push({ query: canary.query, top: outcome.top });
          break;
        case "blocked":
          item.total++;
          item.failures.push({ query: canary.query, top: `制限: ${outcome.reason}` });
          break;
        case "unanswered":
          item.unanswered!.push({ query: canary.query, reason: outcome.reason });
          break;
      }
    }
    results.push(item);
  }
  return summarizeRelevance(results, deps.now);
}

let latest: RelevanceResult = { state: "unknown", engines: [] };

/** 直近の監視結果。healthMonitor がダッシュボードのタイルに載せる。 */
export function getSearxngRelevance(): RelevanceResult {
  return latest;
}

export function startSearxngRelevanceMonitor() {
  if (!isSearxngConfigured()) {
    latest = { state: "unconfigured", engines: [] };
    return;
  }
  // setInterval で直接回さないこと（AGENTS.md「定期ワーカーの回し方」）。
  startWorkerLoop({
    name: "SEARXNG_RELEVANCE",
    intervalMs: INTERVAL_MS,
    immediate: true,
    tick: async () => {
      const previous = latest;
      const result = await checkSearxngRelevance();
      // 最後に正常だった時刻は引き継ぐ（汚染が始まった時期の目安になる）。
      latest = { ...result, lastOkAt: result.lastOkAt ?? previous.lastOkAt };
      const summary = formatRelevanceSummary(result.engines);
      if (result.state === "ok") {
        console.log(`[INFO][SEARXNG_RELEVANCE] ${summary}`);
      } else {
        console.warn(`[WARN][SEARXNG_RELEVANCE] state=${result.state} ${result.lastError} | ${summary}`);
      }
    },
  }).unref();
}
