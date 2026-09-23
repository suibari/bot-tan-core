/**
 * 統合選曲解析の代表3経路を、本番と同じ外部サービスで評価する。
 *
 * pnpm mood-song:discovery:evaluate
 */
import {
  analyzeSongDiscovery,
  resolveLastFmMoodSong,
  type MoodSongInput,
} from "../packages/bot_brain/src/ai/lastFmMoodSong.js";
import { resetAiRouteCache } from "../packages/shared-configs/src/config/aiRoutes.js";

const analysisOnly = process.argv.includes("--analysis-only");
const selectedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
if (!analysisOnly && !process.env.LASTFM_API_KEY) throw new Error("LASTFM_API_KEY is required");
if (!analysisOnly && !process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is required");
if (!process.env.OLLAMA_BASE_URL || !process.env.OLLAMA_MODEL) {
  throw new Error("OLLAMA_BASE_URL and OLLAMA_MODEL are required");
}

process.env.AI_ROUTE_COMMON_MOOD_SONG_LOCAL = "ollama-chat";
resetAiRouteCache();

const cases: Array<{
  id: string;
  input: MoodSongInput;
  expectedBasis: { kind: "artist" | "topic" | "mood"; source: "request" | "history" | "fallback" };
  expectedLabel?: string;
}> = [
  {
    id: "artist",
    input: {
      postText: "DJお願い、Perfumeの曲で元気を出したい！",
      recentPosts: ["今日は渋谷をたくさん歩いた", "作業がひと段落してうれしい"],
    },
    expectedBasis: { kind: "artist", source: "request" },
    expectedLabel: "Perfume",
  },
  {
    id: "topic",
    input: { postText: "DJお願い、渋谷をモチーフにした曲が聴きたい" },
    expectedBasis: { kind: "topic", source: "request" },
    expectedLabel: "渋谷",
  },
  {
    id: "mood-only",
    input: { postText: "DJお願い、雨音を聞きながら穏やかに過ごしているよ" },
    expectedBasis: { kind: "mood", source: "fallback" },
  },
  {
    id: "history-artist",
    input: {
      postText: "DJお願い、最近の投稿に合う曲を選んで",
      recentPosts: ["Perfumeを聴きながら作業したらすごく捗った！", "今日は散歩した"],
    },
    expectedBasis: { kind: "artist", source: "history" },
    expectedLabel: "Perfume",
  },
];

const results = [];
for (const item of cases.filter((candidate) => !selectedCase || candidate.id === selectedCase)) {
  const startedAt = Date.now();
  try {
    if (analysisOnly) {
      const analysis = await analyzeSongDiscovery(item.input, "日本語");
      results.push({
        id: item.id,
        ok: true,
        elapsedMs: Date.now() - startedAt,
        analysis,
      });
      continue;
    }
    const song = await resolveLastFmMoodSong(item.input, "日本語");
    results.push({
      id: item.id,
      ok: Boolean(song && song.selectionBasis?.kind === item.expectedBasis.kind &&
        song.selectionBasis.source === item.expectedBasis.source &&
        (!item.expectedLabel || song.selectionBasis.label === item.expectedLabel)),
      expectedBasis: item.expectedBasis,
      elapsedMs: Date.now() - startedAt,
      song,
    });
  } catch (error) {
    results.push({
      id: item.id,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
