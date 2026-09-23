/**
 * 実際のbotたん定期ポストを、ローカルLLM → AnimeThemes / Last.fm → YouTube のPoCへ流す。
 *
 * pnpm exec tsx --env-file=.env scripts/evaluateLastFmMoodSongs.mts --count=8
 * LASTFM_API_KEY は別途必要。結果を保存する場合は --out=path/to/report.json を付ける。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resetAiRouteCache } from "../packages/shared-configs/src/config/aiRoutes.js";
import { resolveLastFmMoodSong } from "../packages/bot_brain/src/ai/lastFmMoodSong.js";

type FeedItem = {
  post?: {
    uri?: string;
    indexedAt?: string;
    author?: { did?: string };
    record?: { text?: string };
  };
  reason?: unknown;
};

const option = (name: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const actor = option("actor") ?? process.env.BSKY_DID;
const count = Math.min(30, Math.max(1, Number(option("count") ?? 8)));
const outPath = option("out");
if (!actor) throw new Error("BSKY_DID or --actor is required");
if (!process.env.LASTFM_API_KEY) throw new Error("LASTFM_API_KEY is required");
if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is required");
if (!process.env.OLLAMA_BASE_URL || !process.env.OLLAMA_MODEL) {
  throw new Error("OLLAMA_BASE_URL and OLLAMA_MODEL are required");
}

// PoCは曲名生成をGeminiへ送らず、分類と紹介文を必ずローカルモデルで処理する。
process.env.AI_ROUTE_COMMON_MOOD_SONG_LOCAL = "ollama-chat";
resetAiRouteCache();

const withoutExistingSong = (text: string) => text.split(/\n\s*MyMoodSong:\s*\n/u)[0].trim();

function looksLikeRegularScheduledPost(text: string) {
  if (text.length < 250) return false;
  if (/おやすみ|お休みする|眠りにつく|質問コーナー|Good morning|Good night/iu.test(text)) return false;
  return /みんな|everyone/iu.test(text);
}

async function loadPosts(): Promise<Array<{ uri: string; indexedAt: string; text: string }>> {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
  url.searchParams.set("actor", actor!);
  url.searchParams.set("limit", "100");
  url.searchParams.set("filter", "posts_no_replies");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Bluesky feed HTTP ${response.status}`);
  const body = await response.json() as { feed?: FeedItem[] };
  return (body.feed ?? []).flatMap((item) => {
    const post = item.post;
    const text = withoutExistingSong(post?.record?.text ?? "");
    if (item.reason || post?.author?.did !== actor || !post.uri || !post.indexedAt) return [];
    if (!looksLikeRegularScheduledPost(text)) return [];
    return [{ uri: post.uri, indexedAt: post.indexedAt, text }];
  }).slice(0, count);
}

const posts = await loadPosts();
if (posts.length === 0) throw new Error("No regular scheduled posts found in the recent author feed");

const results = [];
for (const [index, post] of posts.entries()) {
  const startedAt = Date.now();
  process.stdout.write(`[${index + 1}/${posts.length}] ${post.indexedAt} ... `);
  try {
    const song = await resolveLastFmMoodSong(post.text, /[ぁ-んァ-ヶ一-龠]/u.test(post.text) ? "日本語" : "English");
    const row = {
      ...post,
      elapsedMs: Date.now() - startedAt,
      song,
    };
    results.push(row);
    console.log(song
      ? `${song.tags.join(" / ")} -> ${song.title} - ${song.artist}`
      : "no verified song");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ...post, elapsedMs: Date.now() - startedAt, error: message });
    console.log(`ERROR: ${message}`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  actor,
  method: "local Ollama anime-title extraction -> AnimeThemes OP/ED (when explicitly mentioned), otherwise local Ollama tags -> Last.fm candidates -> local safety/language screening -> YouTube verification -> local Ollama comment",
  results,
};

if (outPath) {
  const absolute = resolve(outPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`saved: ${absolute}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
process.exit(0);
