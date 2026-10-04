/**
 * ラジオのムード枠（固有名詞の指定がない回）の選曲を、旧ロジックと現在の実装で比べる。
 * 過去の放送枠ごとに本番と同じ選曲用テキストを作り、上位4件（安全確認へ回る枠）に入る
 * アーティストの分布を集計する。安全確認の LLM と track.getInfo は呼ばない。
 *
 * 入力は本番DBから読み取り専用で書き出したJSON（ローカルの.envは開発用DBなので直接つながない）:
 *   { did, tracks: [{ slotKey, claimedAt, artist, title }], posts: [{ text, langs, kossori, recordCreatedAt }] }
 *
 * pnpm exec tsx --env-file=.env scripts/evaluateRadioTagPools.mts --input=<json> \
 *   [--cache=<json>] [--trials=200] [--interest=アイドル,地下アイドル]
 *
 * --interest は本人の関心の語（nagi.actor_interest_genres / actor_interest_keywords）。
 * --cache を付けると、枠ごとの LLM 判定を保存して次回から Ollama を呼ばない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  analyzeSongDiscovery,
  discoverLastFmMoodSongCandidates,
  interestMusicTags,
  type RankedLastFmTrack,
  type SongDiscoveryAnalysis,
} from "../packages/bot_brain/src/ai/lastFmMoodSong.js";
import { selectNagiRadioPostContext } from "../packages/bot_brain/src/ai/nagiRadioPostContext.js";
import { songIdentityKey, songIdentityPart } from "../packages/bot_brain/src/ai/songIdentity.js";
import { getLastFmTopTracks, type LastFmTrack } from "../packages/bot_brain/src/api/lastfm/index.js";
import { resetAiRouteCache } from "../packages/shared-configs/src/config/aiRoutes.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputPath = arg("input");
if (!inputPath) throw new Error("--input=<json> is required");
const cachePath = arg("cache");
const trials = Number(arg("trials") ?? 200);
const interestLabels = (arg("interest") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
const interestTags = interestMusicTags(interestLabels);
if (!process.env.LASTFM_API_KEY) throw new Error("LASTFM_API_KEY is required");
if (!process.env.OLLAMA_BASE_URL || !process.env.OLLAMA_MODEL) throw new Error("OLLAMA_BASE_URL and OLLAMA_MODEL are required");

process.env.AI_ROUTE_COMMON_MOOD_SONG_LOCAL = "ollama-chat";
resetAiRouteCache();

const WEEK_MS = 7 * 24 * 60 * 60_000;

type Input = {
  did: string;
  tracks: Array<{ slotKey: string; claimedAt: string; artist: string; title: string }>;
  posts: Array<{ text: string; langs: string[] | null; recordCreatedAt: string }>;
};
type SlotJudgement = { songContext: string; analysis: SongDiscoveryAnalysis };

const input = JSON.parse(readFileSync(inputPath, "utf8")) as Input;
const cache: Record<string, SlotJudgement> = cachePath && existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

// 放送ごとに、ワーカーと同じ「前回の成功放送の開始〜今回の開始」の投稿を切り出す。
const slots = input.tracks.map((track, index) => {
  const claimedAt = new Date(track.claimedAt).getTime();
  const previous = index > 0 ? new Date(input.tracks[index - 1].claimedAt).getTime() : null;
  const since = previous ?? claimedAt - WEEK_MS;
  const posts = input.posts.filter((post) => {
    const at = new Date(post.recordCreatedAt).getTime();
    return at <= claimedAt && (previous ? at > since : at >= since);
  });
  return { track, posts };
});

const judgements: Array<SlotJudgement | null> = [];
for (const { track, posts } of slots) {
  if (!posts.length) {
    judgements.push(null);
    continue;
  }
  const hit = cache[track.slotKey];
  if (hit) {
    judgements.push(hit);
    continue;
  }
  const context = await selectNagiRadioPostContext(posts.map((post) => post.text), "日本語");
  const analysis = await analyzeSongDiscovery(context.songContext, "日本語");
  const judgement = { songContext: context.songContext, analysis };
  cache[track.slotKey] = judgement;
  if (cachePath) writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  console.error(`[eval] ${track.slotKey} genre=${analysis.genre} tags=${analysis.tags.join(",")}`);
  judgements.push(judgement);
}

const tagCache = new Map<string, Promise<LastFmTrack[]>>();
const topTracks: typeof getLastFmTopTracks = (tag, options = {}) => {
  const key = `${tag}\u0000${options.page ?? 1}\u0000${options.limit ?? 50}`;
  if (!tagCache.has(key)) tagCache.set(key, getLastFmTopTracks(tag, options));
  return tagCache.get(key)!;
};

/** 2026-10-04 以前の rankLastFmTrackPools。先頭3タグだけを足し合わせ、アーティストはそろえない。 */
function legacyRank(pools: Array<{ tag: string; tracks: LastFmTrack[] }>) {
  const combined = new Map<string, LastFmTrack & { weight: number }>();
  pools.slice(0, 3).forEach(({ tracks }, tagIndex) => {
    const tagWeight = [1, 0.55, 0.35][tagIndex];
    tracks.forEach((track, index) => {
      const key = songIdentityKey(track);
      if (!key) return;
      const contribution = tagWeight / Math.sqrt(track.rank > 0 ? track.rank : index + 1);
      const current = combined.get(key);
      if (current) current.weight += contribution;
      else combined.set(key, { ...track, weight: contribution });
    });
  });
  return [...combined.values()]
    .map((track) => ({ track, order: -Math.log(Math.max(Number.EPSILON, Math.random())) / track.weight }))
    .sort((a, b) => a.order - b.order)
    .map(({ track }) => track)
    .slice(0, 4);
}

/** 実装: ムード枠だけを見るため、固有名詞の指定と曲名検索は外して呼ぶ。 */
async function currentTop4(analysis: SongDiscoveryAnalysis): Promise<RankedLastFmTrack[]> {
  const none = { anime: null, artist: null, topic: null };
  const { allowed } = await discoverLastFmMoodSongCandidates("", "日本語", {
    analyze: async () => ({ ...analysis, request: none, history: none, titleQuery: null }),
    topTracks,
    trackInfo: async () => ({ listeners: 0, summary: "", topTags: [] }),
    screen: async (_post, candidates) => ({ allowedIndices: candidates.map((_, index) => index) }),
    interestMusicTags: interestTags,
  });
  return allowed.slice(0, 4);
}

type Tally = Map<string, number>;
const bump = (tally: Tally, artist: string) => tally.set(artist, (tally.get(artist) ?? 0) + 1);
const totals = {
  legacy: { top4: new Map() as Tally, top1: new Map() as Tally, japanese: 0, interest: 0 },
  current: { top4: new Map() as Tally, top1: new Map() as Tally, japanese: 0, interest: 0 },
};

// 「日本の曲」: j-pop/japanese の上位300曲に入る曲・アーティスト、または名前に日本語の文字がある。
const japaneseKeys = new Set<string>();
const japaneseArtists = new Set<string>();
for (const tag of ["j-pop", "japanese"]) for (const page of [1, 2, 3]) {
  for (const track of await topTracks(tag, { limit: 100, page })) {
    japaneseKeys.add(songIdentityKey(track));
    japaneseArtists.add(songIdentityPart(track.artist));
  }
}
const isJapanese = (track: LastFmTrack) => japaneseKeys.has(songIdentityKey(track)) ||
  japaneseArtists.has(songIdentityPart(track.artist)) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(track.artist + track.title);
// 「関心ジャンルの曲」: 関心から引いたタグの上位300曲に入る。
const interestKeys = new Set<string>();
for (const tag of interestTags) for (const page of [1, 2, 3]) {
  for (const track of await topTracks(tag, { limit: 100, page })) interestKeys.add(songIdentityKey(track));
}

const rows: string[] = [];
const genreCount = new Map<string, number>();
let evaluated = 0;
for (const [index, { track, posts }] of slots.entries()) {
  const judgement = judgements[index];
  if (!judgement) {
    rows.push(`| ${track.slotKey} | （新規投稿なし・記憶から） | - | - | ${track.artist} - ${track.title} | - | - |`);
    continue;
  }
  evaluated += 1;
  const { analysis } = judgement;
  genreCount.set(analysis.genre ?? "null", (genreCount.get(analysis.genre ?? "null") ?? 0) + 1);
  const moods = await Promise.all(analysis.tags.map(async (tag) => ({ tag, tracks: await topTracks(tag, { limit: 50, page: 1 }) })));
  const legacyPools = [
    { tag: "j-pop", tracks: await topTracks("j-pop", { limit: 100, page: 1 }) },
    { tag: "japanese", tracks: await topTracks("japanese", { limit: 100, page: 1 }) },
    ...moods,
  ];

  let samples: [LastFmTrack[], LastFmTrack[]] = [[], []];
  for (let trial = 0; trial < trials; trial++) {
    const drawn: Array<[keyof typeof totals, LastFmTrack[]]> = [
      ["legacy", legacyRank(legacyPools)],
      ["current", await currentTop4(analysis)],
    ];
    for (const [key, songs] of drawn) {
      songs.forEach((song) => bump(totals[key].top4, song.artist));
      if (!songs[0]) continue;
      bump(totals[key].top1, songs[0].artist);
      if (isJapanese(songs[0])) totals[key].japanese += 1;
      if (interestKeys.has(songIdentityKey(songs[0]))) totals[key].interest += 1;
    }
    if (trial === 0) samples = [drawn[0][1], drawn[1][1]];
  }
  const signals = (["request", "history"] as const).flatMap((source) =>
    (["anime", "artist", "topic"] as const).flatMap((kind) =>
      analysis[source][kind] ? [`${source}.${kind}=${analysis[source][kind]!.mentionedName}`] : []));
  const excerpt = posts.map((post) => post.text.replace(/\s+/gu, " ")).join(" / ").slice(0, 60).replace(/\|/gu, "｜");
  const list = (songs: LastFmTrack[]) => songs.map((song) => `${song.artist}「${song.title}」`).join("<br>").replace(/\|/gu, "｜");
  rows.push(`| ${track.slotKey} | ${excerpt}${signals.length ? `<br>**${signals.join(", ")}**` : ""} | ${analysis.genre} | ${analysis.tags.join(", ")} | ${track.artist} - ${track.title} | ${list(samples[0])} | ${list(samples[1])} |`);
}

const draws = evaluated * trials;
const pct = (value: number) => `${(100 * value / draws).toFixed(1)}%`;
const share = (tally: Tally, limit = 8) => [...tally.entries()]
  .sort((a, b) => b[1] - a[1]).slice(0, limit)
  .map(([artist, count]) => `${artist} ${pct(count)}`).join(", ");

console.log(`# ラジオのムード枠: 旧ロジック vs 実装（${input.did}）\n`);
console.log(`放送 ${slots.length} 枠のうち、新規投稿から選曲した ${evaluated} 枠を各 ${trials} 回抽選。`);
console.log(`関心: ${interestLabels.join(", ") || "なし"} → 曲のジャンル: ${interestTags.join(", ") || "なし"}\n`);
console.log("| | 旧ロジック | 実装 |\n|---|---|---|");
console.log(`| 宇多田ヒカル（1位） | ${pct(totals.legacy.top1.get("宇多田ヒカル") ?? 0)} | ${pct(totals.current.top1.get("宇多田ヒカル") ?? 0)} |`);
console.log(`| 日本の曲（1位） | ${pct(totals.legacy.japanese)} | ${pct(totals.current.japanese)} |`);
console.log(`| 関心ジャンルの曲（1位） | ${pct(totals.legacy.interest)} | ${pct(totals.current.interest)} |`);
console.log(`| 異なりアーティスト数（上位4件） | ${totals.legacy.top4.size} | ${totals.current.top4.size} |`);
console.log(`| 1位のアーティスト上位 | ${share(totals.legacy.top1)} | ${share(totals.current.top1)} |`);
console.log(`\n実放送: 宇多田ヒカル ${input.tracks.filter((track) => track.artist === "宇多田ヒカル").length}/${input.tracks.length}`);
console.log(`genre 内訳: ${[...genreCount.entries()].sort((a, b) => b[1] - a[1]).map(([genre, count]) => `${genre}×${count}`).join(", ")}\n`);
console.log("## 枠ごと（上位4件は1回目の抽選例）\n");
console.log("| 枠 | 投稿の抜粋 | genre | mood | 実際の放送 | 旧ロジック 上位4件 | 実装 上位4件 |\n|---|---|---|---|---|---|---|");
rows.forEach((row) => console.log(row));
