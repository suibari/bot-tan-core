import { MemoryService } from "@bsky-affirmative-bot/clients";
import {
  BOT_MEMORY_GRAPH_MAX_NODES,
  BOT_MEMORY_GRAPH_MAX_WINDOW_DAYS,
  getBotMemoryGraph,
} from "@bsky-affirmative-bot/database";
import express from "express";
import { buildHealthSnapshot } from "./healthMonitor.js";
import { isJstDateString, jstDateString, jstDayRange } from "./jstDate.js";

/**
 * bot-tan.com のダッシュボードが直接読む公開エンドポイント。
 *
 * WebSocket は「いまの状態」を流すためのもので、推移や過去の1日を取りに行くのには
 * 向かない（毎フレームに履歴を同梱すると重い）。そこで読み出し専用の GET を分ける。
 *
 * どれも認証なしで配信される。/health と /history は集計値だけで、**個人が特定できる値を
 * 絶対に含めない**。/timeline の mood（botたんの行動描写）だけは例外で、お部屋に来てくれた
 * 人の Bluesky 表示名が入りうる（manager.ts の buildPrompt がお部屋のできごとを行動生成の
 * 材料にするため）。ここに新しい値を足すときは、この非対称を前提にすること。
 */

/** 過去何日分まで遡らせるか。無制限にすると重いクエリを誰でも撃てる。 */
const MAX_HISTORY_DAYS = 365;
const MAX_TIMELINE_DAYS_BACK = 7;
const CACHE_TTL_MS = 60_000;


/** タイムラインに打つイベント。件数が多すぎるもの（全肯定・いいね・返信）は除く。 */
const TIMELINE_EVENT_TYPES = [
  "fortune",
  "cheer",
  "analysis",
  "dj",
  "anniversary",
  "answer",
  "recap",
];

interface CacheEntry {
  at: number;
  /**
   * 値ではなく **Promise** を持つ。冷えているところへ同時にアクセスが来ると、
   * 値キャッシュでは全員が load() を走らせてしまう。/health なら誤差だが、
   * /memory-graph は1回が重いので、ここで束ねる。
   */
  value: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const pending = load();
  cache.set(key, { at: Date.now(), value: pending });
  // 失敗を TTL のあいだ配り続けない。次のアクセスで引き直す。
  pending.catch(() => {
    if (cache.get(key)?.value === pending) cache.delete(key);
  });
  return pending;
}

export interface TimelineSegment {
  start: string;
  end: string;
  status: string;
  mood: string;
  moodEn: string;
  energy: number;
}

/**
 * biorhythm_history の各行を「その時刻から次の行まで」の区間に組み立てる。
 *
 * `rows` は要求日の1件前（前日から継続中だったもの）を先頭に含む前提。これがないと
 * その日の最初のログより前の時間帯が毎朝ぽっかり空く。
 */
export function buildTimelineSegments(
  rows: { status: string; mood: string; mood_en: string | null; energy: number; created_at: Date }[],
  start: Date,
  end: Date,
  now: Date = new Date(),
): TimelineSegment[] {
  // その日のうち、まだ来ていない時間帯は描かない。
  const boundary = Math.min(end.getTime(), Math.max(now.getTime(), start.getTime()));
  const segments: TimelineSegment[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const next = rows[i + 1];

    const segStart = Math.max(row.created_at.getTime(), start.getTime());
    const segEnd = Math.min(next ? next.created_at.getTime() : boundary, boundary);
    if (segEnd <= segStart) continue;

    segments.push({
      start: new Date(segStart).toISOString(),
      end: new Date(segEnd).toISOString(),
      status: row.status,
      mood: row.mood,
      moodEn: row.mood_en ?? "",
      energy: row.energy,
    });
  }

  return segments;
}

export const publicApi = express.Router();

/** 死活監視。WS を張らずに状態だけ見たいとき用。 */
publicApi.get("/health", async (_req, res) => {
  try {
    res.json(await cached("health", () => buildHealthSnapshot()));
  } catch (error) {
    console.error("[ERROR][BIO][API] /health failed:", error);
    res.status(500).json({ error: "failed to build health snapshot" });
  }
});

/** 推移。daily_metrics の蓄積に、遡及できる Nagi ユーザー数を重ねて返す。 */
publicApi.get("/history", async (req, res) => {
  const requested = Number(req.query.days ?? 90);
  if (!Number.isFinite(requested) || requested <= 0) {
    res.status(400).json({ error: "days must be a positive number" });
    return;
  }
  const days = Math.min(Math.floor(requested), MAX_HISTORY_DAYS);

  try {
    const payload = await cached(`history:${days}`, async () => {
      const [daily, nagiUsers, nagiChannels, nagiHourly] = await Promise.all([
        MemoryService.getDailyMetrics(days),
        MemoryService.getNagiUserHistory(days),
        MemoryService.getNagiChannelHistory(days),
        MemoryService.getNagiHourlyActivity(168),
      ]);
      return { days, daily, nagiUsers, nagiChannels, nagiHourly };
    });
    res.json(payload);
  } catch (error) {
    console.error("[ERROR][BIO][API] /history failed:", error);
    res.status(500).json({ error: "failed to load history" });
  }
});

/** 1日の活動タイムライン。 */
publicApi.get("/timeline", async (req, res) => {
  const date = typeof req.query.date === "string" && req.query.date ? req.query.date : jstDateString();

  if (!isJstDateString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }

  const { start, end } = jstDayRange(date);
  const now = new Date();
  const oldest = new Date(now.getTime() - MAX_TIMELINE_DAYS_BACK * 24 * 60 * 60 * 1000);
  if (start < oldest) {
    res.status(400).json({ error: `date must be within the last ${MAX_TIMELINE_DAYS_BACK} days` });
    return;
  }
  if (start > now) {
    res.status(400).json({ error: "date must not be in the future" });
    return;
  }

  try {
    const payload = await cached(`timeline:${date}`, async () => {
      const [rows, events] = await Promise.all([
        MemoryService.getBiorhythmHistoryForTimeline(start, end),
        MemoryService.getInteractionMarkers(start, end, TIMELINE_EVENT_TYPES),
      ]);
      return { date, segments: buildTimelineSegments(rows, start, end), events };
    });
    res.json(payload);
  } catch (error) {
    console.error("[ERROR][BIO][API] /timeline failed:", error);
    res.status(500).json({ error: "failed to load timeline" });
  }
});

/**
 * botたんの記憶のネットワークグラフ。bot-tan.com の /memory が読む。
 *
 * **出るのは印象語のラベルと集計値だけ**で、会話の本文・URI・author_id は含まれない
 * （getBotMemoryGraph の冒頭コメントを参照）。受け付けるのは days と nodes だけで、
 * どちらも上限でクランプする。重いクエリの形を手で組み立てられないようにするため。
 *
 * 他のルートと同じ60秒キャッシュ。実測でノード400件なら250ms 程度なので、これ以上
 * 寝かせる理由がない。**キャッシュは「deleted_at で消した記憶が公開ページに残る
 * 時間」でもある**ので、伸ばすときはコストではなくそちらで判断すること。
 */
publicApi.get("/memory-graph", async (req, res) => {
  const requestedDays = Number(req.query.days ?? BOT_MEMORY_GRAPH_MAX_WINDOW_DAYS);
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
    res.status(400).json({ error: "days must be a positive number" });
    return;
  }
  const days = Math.min(Math.floor(requestedDays), BOT_MEMORY_GRAPH_MAX_WINDOW_DAYS);

  const requestedNodes = req.query.nodes === undefined ? undefined : Number(req.query.nodes);
  if (requestedNodes !== undefined && (!Number.isFinite(requestedNodes) || requestedNodes <= 0)) {
    res.status(400).json({ error: "nodes must be a positive number" });
    return;
  }
  const nodes = requestedNodes === undefined
    ? undefined
    : Math.min(Math.floor(requestedNodes), BOT_MEMORY_GRAPH_MAX_NODES);

  try {
    const payload = await cached(
      `memory-graph:${days}:${nodes ?? "default"}`,
      () => getBotMemoryGraph({ windowDays: days, nodeLimit: nodes }),
    );
    res.json(payload);
  } catch (error) {
    console.error("[ERROR][BIO][API] /memory-graph failed:", error);
    res.status(500).json({ error: "failed to build memory graph" });
  }
});
