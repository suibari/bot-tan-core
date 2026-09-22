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
  resolveMoodSong,
  songKey,
} from "../src/ai/memorySong.js";

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
    getRecentSelections: async () => [{
      videoId: "used-video",
      songKey: songKey({ title: "SUN", artist: "星野源" }),
      title: "SUN",
      artist: "星野源",
      purpose: "scheduled_post",
      subjectDid: null,
      outputRef: null,
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
