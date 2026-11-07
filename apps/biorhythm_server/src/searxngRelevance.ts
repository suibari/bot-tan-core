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
/** エンジンごとに、この割合以上の語で期待どおりなら正常とみなす。 */
const PASS_RATIO = 2 / 3;

export type EngineRelevance = {
  engine: string;
  passed: number;
  total: number;
  /** 期待どおりでなかった語と、そのときの1位のタイトル（原因を追うため）。 */
  failures: { query: string; top: string }[];
};

export type RelevanceResult = {
  state: HealthState;
  checkedAt?: string;
  lastOkAt?: string;
  lastError?: string;
  engines: EngineRelevance[];
};

type Search = (query: string, options: { engines: string; source: "probe" }) => Promise<SearxngResponse>;

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

/** エンジンごとの結果から、監視の状態を決める。 */
export function summarizeRelevance(engines: EngineRelevance[], now = new Date()): RelevanceResult {
  if (!engines.length) return { state: "unconfigured", engines };
  const failing = engines.filter((item) => item.passed / item.total < PASS_RATIO);
  const checkedAt = now.toISOString();
  if (!failing.length) return { state: "ok", checkedAt, lastOkAt: checkedAt, engines };
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

export async function checkSearxngRelevance(
  deps: { search?: Search; engines?: string[]; canaries?: RelevanceCanary[]; now?: Date } = {},
): Promise<RelevanceResult> {
  const search: Search = deps.search ?? ((query, options) => searxngSearch(query, options));
  const engines = deps.engines ?? enginesToCheck();
  const canaries = deps.canaries ?? RELEVANCE_CANARIES;
  const results: EngineRelevance[] = [];
  for (const engine of engines) {
    const item: EngineRelevance = { engine, passed: 0, total: canaries.length, failures: [] };
    for (const canary of canaries) {
      try {
        const response = await search(canary.query, { engines: engine, source: "probe" });
        if (isRelevant(response, canary)) item.passed++;
        else item.failures.push({ query: canary.query, top: response.hits[0]?.title?.slice(0, 40) ?? "" });
      } catch (error) {
        item.failures.push({ query: canary.query, top: `エラー: ${error instanceof Error ? error.message.slice(0, 60) : String(error)}` });
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
      const summary = result.engines.map((item) => `${item.engine}=${item.passed}/${item.total}`).join(" ");
      if (result.state === "ok") {
        console.log(`[INFO][SEARXNG_RELEVANCE] ${summary}`);
      } else {
        console.warn(`[WARN][SEARXNG_RELEVANCE] state=${result.state} ${result.lastError}`);
      }
    },
  }).unref();
}
