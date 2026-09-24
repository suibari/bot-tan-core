import assert from "node:assert/strict";
import test from "node:test";
import type { BotMemorySearchResult } from "@bsky-affirmative-bot/database";
import {
  SCHEDULED_POST_SONG_SCOPE,
  djSongSelectionScope,
} from "@bsky-affirmative-bot/database";
import {
  buildMoodSongMemoryQuery,
  extractMemorySongCandidates,
  findMoodSongCandidates,
  MoodSongResolver,
  resolveMoodSong,
  songKey,
} from "../src/ai/memorySong.js";
import { lastFmTrackKey } from "../src/ai/lastFmMoodSong.js";

test("DBへ渡す曲キーはNULを含まず、Last.fm候補のキーと一致する", () => {
  for (const [song, expected] of [
    [{ title: "Higher & Higher", artist: "Jackie Wilson" }, "higherhigher:jackiewilson"],
    [{ title: "ワンルーム・ディスコ", artist: "Perfume" }, "ワンルームディスコ:perfume"],
  ] as const) {
    assert.equal(songKey(song), expected);
    assert.equal(lastFmTrackKey(song), songKey(song));
    assert.equal(songKey(song).includes("\0"), false);
  }
});

const row = (id: number, content: string): BotMemorySearchResult => ({
  id,
  sourceType: "web_research",
  sourceId: `research-${id}`,
  sourceUri: null,
  authorId: null,
  content,
  botResponse: null,
  occurredAt: new Date("2026-09-22T00:00:00Z"),
  affirmationScore: null,
  salience: null,
  metadata: null,
  relevance: 0.01,
  semanticRank: 1,
});

test("知識カードに明記された曲名と作者だけを抽出する", () => {
  const candidates = extractMemorySongCandidates([
    row(1, "I LOVE YOU\n概要\n「I LOVE YOU」は、日本のシンガーソングライターである尾崎豊による楽曲です。"),
    row(2, "This game\n概要\n「This game」は、鈴木このみの6枚目のシングルです。"),
    row(3, "おすすめアーティストはサンプルバンドです。曲名は書かれていません。"),
  ]);
  assert.deepEqual(candidates, [
    { documentId: 1, title: "I LOVE YOU", artist: "尾崎豊" },
    { documentId: 2, title: "This game", artist: "鈴木このみ" },
  ]);
});

test("記憶検索は web_research に限定し、気分をクエリへ含める", async () => {
  let request: any;
  const candidates = await findMoodSongCandidates("静かに休んでいる", "日本語", {
    search: async (value) => {
      request = value;
      return [row(4, "「Tokimeki」は、Vaundyによる楽曲です。")];
    },
  });
  assert.deepEqual(request.sources, ["web_research"]);
  assert.equal(request.purpose, "scheduled_post");
  assert.match(request.query, /静かに休んでいる/);
  assert.match(buildMoodSongMemoryQuery("元気", "English"), /real song title/);
  assert.deepEqual(candidates, [
    { documentId: 4, title: "Tokimeki", artist: "Vaundy" },
  ]);
});

test("YouTubeで曲名と作者を確認できた候補まで順に進む", async () => {
  const searched: string[] = [];
  const result = await resolveMoodSong("気分", "日本語", SCHEDULED_POST_SONG_SCOPE, {
    resolveLastFm: async () => null,
    getRecentSelections: async (scope) => {
      assert.deepEqual(scope, SCHEDULED_POST_SONG_SCOPE);
      return [];
    },
    findCandidates: async () => [
      { documentId: 1, title: "見つからない曲", artist: "作者A" },
      { documentId: 2, title: "This game", artist: "鈴木このみ" },
    ],
    screenMemory: async (_post, _lang, candidates) => candidates,
    searchYoutube: async (title) => {
      searched.push(title);
      return title === "This game"
        ? {
            videoId: "verified",
            url: "https://www.youtube.com/watch?v=verified",
            videoTitle: "鈴木このみ This game",
            channelTitle: "公式",
          }
        : null;
    },
  });
  assert.deepEqual(searched, ["見つからない曲", "This game"]);
  assert.match(result?.comment ?? "", /記憶に残っていた曲/);
  assert.equal(result?.url, "https://www.youtube.com/watch?v=verified");
});

test("選曲候補を記憶から探すときは全投稿の要約を検索へ渡す", async () => {
  let queried = "";
  await resolveMoodSong("先頭の投稿だけでは分からない文脈", "日本語", SCHEDULED_POST_SONG_SCOPE, {
    memoryQueryText: "投稿期間の全件から作った要約",
    resolveLastFm: async () => null,
    getRecentSelections: async () => [],
    findCandidates: async (query) => { queried = query; return []; },
    screenMemory: async (_post, _lang, candidates) => candidates,
  });
  assert.equal(queried, "投稿期間の全件から作った要約");
});

test("Last.fm経路が成功すればbot memoryフォールバックを呼ばない", async () => {
  let memorySearched = false;
  const result = await resolveMoodSong("晴れた日の散歩", "日本語", SCHEDULED_POST_SONG_SCOPE, {
    getRecentSelections: async () => [],
    resolveLastFm: async (_post, _lang, options) => {
      assert.deepEqual([...options.excludedSongKeys ?? []], []);
      return {
        title: "Mr. Blue Sky",
        artist: "Electric Light Orchestra",
        comment: "明るい空気に合いそう！",
        tags: ["happy"],
        lastFmUrl: "https://www.last.fm/music/Electric+Light+Orchestra/_/Mr.+Blue+Sky",
        screenedOutCount: 1,
        videoId: "blue-sky",
        url: "https://www.youtube.com/watch?v=blue-sky",
        videoTitle: "Mr. Blue Sky",
        channelTitle: "ELO",
      };
    },
    findCandidates: async () => {
      memorySearched = true;
      return [];
    },
  });
  assert.equal(memorySearched, false);
  assert.equal(result?.videoId, "blue-sky");
  assert.equal(result?.lastFmUrl, "https://www.last.fm/music/Electric+Light+Orchestra/_/Mr.+Blue+Sky");
  assert.equal(result?.songKey, songKey({ title: "Mr. Blue Sky", artist: "Electric Light Orchestra" }));
});

test("直近の同一曲を除外し、YouTube検索は3候補までに制限する", async () => {
  const searched: string[] = [];
  const candidates = ["Ａ", "B", "C", "D", "E"].map((title, index) => ({
    documentId: index + 1,
    title,
    artist: `artist-${title}`,
  }));
  const result = await resolveMoodSong("気分", "日本語", djSongSelectionScope("did:plc:alice"), {
    resolveLastFm: async () => null,
    getRecentSelections: async (scope) => {
      assert.deepEqual(scope, { purpose: "dj", subjectDid: "did:plc:alice" });
      return [{
        videoId: "old-a",
        songKey: songKey({ title: "A", artist: "artist-A" }),
        title: "A",
        artist: "artist-A",
        purpose: "dj",
        subjectDid: "did:plc:alice",
        outputRef: null,
        status: "published",
        reservationExpiresAt: null,
        selectedAt: new Date(),
      }];
    },
    findCandidates: async () => candidates,
    screenMemory: async (_post, _lang, values) => values,
    searchYoutube: async (title) => {
      searched.push(title);
      return null;
    },
  });
  assert.equal(result, null);
  assert.deepEqual(searched, ["B", "C"]);
});

test("同じ曲の別動画もsongKeyで、同じ動画の別表記もvideoIdで除外する", async () => {
  const result = await resolveMoodSong("気分", "日本語", SCHEDULED_POST_SONG_SCOPE, {
    resolveLastFm: async () => null,
    getRecentSelections: async () => [{
      videoId: "used-video",
      songKey: songKey({ title: "SUN", artist: "星野源" }),
      title: "SUN",
      artist: "星野源",
      purpose: "scheduled_post",
      subjectDid: null,
      outputRef: null,
      status: "published",
      reservationExpiresAt: null,
      selectedAt: new Date(),
    }],
    findCandidates: async () => [
      { documentId: 1, title: "ＳＵＮ", artist: "星野 源" },
      { documentId: 2, title: "別の曲", artist: "別の人" },
      { documentId: 3, title: "新しい曲", artist: "新しい人" },
    ],
    screenMemory: async (_post, _lang, candidates) => candidates,
    searchYoutube: async (title) => ({
      videoId: title === "別の曲" ? "used-video" : "new-video",
      url: `https://www.youtube.com/watch?v=${title === "別の曲" ? "used-video" : "new-video"}`,
      videoTitle: title,
      channelTitle: "公式",
    }),
  });
  assert.equal(result?.title, "新しい曲");
  assert.equal(result?.videoId, "new-video");
});

const groundedSong = (suffix: string) => ({
  title: `Song ${suffix}`,
  artist: `Artist ${suffix}`,
  comment: "comment",
  songKey: `song-${suffix}`,
  videoId: `video-${suffix}`,
  url: `https://www.youtube.com/watch?v=video-${suffix}`,
  videoTitle: `Song ${suffix}`,
  channelTitle: `Artist ${suffix}`,
});

test("メモリ内履歴はちょうど30日間だけ除外する", async () => {
  let now = new Date("2026-08-01T00:00:00.000Z");
  let excluded: string[] = [];
  const resolver = new MoodSongResolver(30, {
    now: () => now,
    resolve: async (_post, _lang, _scope, options) => {
      excluded = [...options.excludeSongKeys ?? []];
      return null;
    },
  });
  resolver.remember(SCHEDULED_POST_SONG_SCOPE, groundedSong("A"), now);

  now = new Date("2026-08-31T00:00:00.000Z");
  await resolver.resolve("post", "日本語", SCHEDULED_POST_SONG_SCOPE);
  assert.deepEqual(excluded, ["song-A"]);

  now = new Date("2026-08-31T00:00:00.001Z");
  await resolver.resolve("post", "日本語", SCHEDULED_POST_SONG_SCOPE);
  assert.deepEqual(excluded, []);
});

test("予約競合時は別候補を再選し、予約できた曲だけを返す", async () => {
  let resolved = 0;
  let reserved = 0;
  const now = new Date("2026-09-23T00:00:00.000Z");
  const resolver = new MoodSongResolver(30, {
    now: () => now,
    resolve: async () => groundedSong(String.fromCharCode(65 + resolved++)),
    reserve: async (selection) => {
      reserved++;
      if (reserved === 1) return null;
      return {
        id: 2,
        videoId: selection.videoId,
        songKey: selection.songKey,
        scope: selection.scope,
        selectedAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60_000),
      };
    },
  });
  const result = await resolver.resolveAndReserve("post", "日本語", SCHEDULED_POST_SONG_SCOPE);
  assert.equal(result?.song.songKey, "song-B");
  assert.equal(resolved, 2);
  assert.equal(reserved, 2);
});
