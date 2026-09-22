import assert from "node:assert/strict";
import test from "node:test";
import { getLastFmTopTracks, getLastFmTrackInfo } from "../src/api/lastfm/index.js";
import {
  classifyLastFmMoodTags,
  lastFmTrackKey,
  parseMoodTagClassification,
  rankJapaneseLastFmTracks,
  rankLastFmTrackPools,
  resolveLastFmMoodSong,
  screenLastFmMoodSongCandidates,
} from "../src/ai/lastFmMoodSong.js";

test("Last.fm tag.getTopTracksを認証情報なしの公開メソッドとして呼ぶ", async () => {
  let requested = "";
  const tracks = await getLastFmTopTracks("rainy day", {
    apiKey: "test-key",
    limit: 20,
    fetchImpl: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({
        tracks: {
          track: [{
            name: "Rain",
            url: "https://last.fm/music/example",
            mbid: "mbid-1",
            artist: { name: "Example" },
            "@attr": { rank: "7" },
          }],
        },
      }));
    },
  });
  const url = new URL(requested);
  assert.equal(url.searchParams.get("method"), "tag.getTopTracks");
  assert.equal(url.searchParams.get("tag"), "rainy day");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.deepEqual(tracks, [{
    title: "Rain",
    artist: "Example",
    lastFmUrl: "https://last.fm/music/example",
    mbid: "mbid-1",
    rank: 7,
  }]);
});

test("track.getInfoからリスナー数・概要・タグを安全確認用に整形する", async () => {
  const info = await getLastFmTrackInfo("Song", "Artist", {
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      track: {
        listeners: "12345",
        wiki: { summary: 'A &quot;bright&quot; song. <a href="https://example">Read more</a>' },
        toptags: { tag: [{ name: "happy" }, { name: "pop" }] },
      },
    })),
  });
  assert.deepEqual(info, {
    listeners: 12345,
    summary: 'A "bright" song.',
    topTags: ["happy", "pop"],
  });
});

test("タグ分類は許可リストだけを重複なしで採用する", () => {
  assert.deepEqual(
    parseMoodTagClassification('{"tags":["Chill","chill","not-a-tag","dreamy"]}'),
    { tags: ["chill", "dreamy"] },
  );
  assert.throws(
    () => parseMoodTagClassification('{"tags":["invented"]}'),
    /no allowed Last.fm mood tags/,
  );
});

test("投稿を最後のメッセージに置き、num_predictとtemperatureを共通Ollama経路へ任せる", async () => {
  let captured: any;
  const result = await classifyLastFmMoodTags("雨音を聞きながら静かに勉強中", "日本語", {
    chat: async (feature, messages, options) => {
      captured = { feature, messages, options };
      return '{"tags":["rainy day","study","calm"]}';
    },
  });
  assert.deepEqual(result.tags, ["rainy day", "study", "calm"]);
  assert.equal(captured.feature, "COMMON_MOOD_SONG_LOCAL");
  assert.equal(captured.messages.at(-1).role, "user");
  assert.equal(captured.messages.at(-1).content, "雨音を聞きながら静かに勉強中");
  assert.equal(captured.options.maxTokens, 64);
  assert.equal(captured.options.temperature, 0.2);
  assert.equal("num_ctx" in captured.options, false);
});

test("タグ候補はANDせず、重複曲の重みとタグを合算する", () => {
  const shared = {
    title: "Shared",
    artist: "Artist",
    lastFmUrl: "https://last.fm/shared",
    rank: 4,
  };
  const ranked = rankLastFmTrackPools([
    { tag: "chill", tracks: [shared] },
    { tag: "dreamy", tracks: [{ ...shared, rank: 1 }] },
  ], () => 0.5);
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].tags, ["chill", "dreamy"]);
  assert.equal(ranked[0].weight, 1.05);
});

test("日本語曲プールはj-popとjapaneseの積集合を単独タグ候補より先にする", () => {
  const shared = { title: "アイドル", artist: "YOASOBI", lastFmUrl: "shared", rank: 10 };
  const ranked = rankJapaneseLastFmTracks(
    [{ title: "J-pop only", artist: "A", lastFmUrl: "a", rank: 1 }, shared],
    [{ title: "Japanese only", artist: "B", lastFmUrl: "b", rank: 1 }, shared],
    () => 0.5,
  );
  assert.equal(ranked[0].title, "アイドル");
  assert.deepEqual(ranked[0].tags, ["j-pop", "japanese"]);
});

test("安全ゲートは曲を順位付けせず、不適切と判断した番号だけを落とす", async () => {
  let lastMessage = "";
  let systemMessage = "";
  const assessment = await screenLastFmMoodSongCandidates("明るいカフェの投稿", [
    { title: "Safe", artist: "A", lastFmUrl: "", rank: 1, tags: ["happy"], weight: 1 },
    { title: "Unsafe", artist: "B", lastFmUrl: "", rank: 2, tags: ["happy"], weight: 0.5 },
  ], "日本語", {
    chat: async (_feature, messages, options) => {
      systemMessage = messages[0]?.content ?? "";
      lastMessage = messages.at(-1)?.content ?? "";
      assert.equal(options.temperature, 0.1);
      assert.equal("num_ctx" in options, false);
      return '{"allowedIndices":[0]}';
    },
  });
  assert.equal(lastMessage, "明るいカフェの投稿");
  assert.match(systemMessage, /日本語で歌われる曲だけ/);
  assert.deepEqual(assessment, { allowedIndices: [0] });
});

test("安全ゲートの全落ちは候補を復活させない", async () => {
  const assessment = await screenLastFmMoodSongCandidates("post", [
    { title: "Unknown", artist: "Unknown", lastFmUrl: "", rank: 1, tags: ["happy"], weight: 1 },
  ], "English", {
    chat: async (_feature, messages) => {
      assert.match(messages[0]?.content ?? "", /英語で歌われる英語圏の曲だけ/);
      return '{"allowedIndices":[]}';
    },
  });
  assert.deepEqual(assessment.allowedIndices, []);
});

test("履歴曲を除外し、YouTubeで確認できた候補にだけコメントを付ける", async () => {
  const searched: string[] = [];
  const requestedTags: string[] = [];
  const result = await resolveLastFmMoodSong("穏やかな午後", "日本語", {
    classify: async () => ({ tags: ["calm"] }),
    topTracks: async (tag) => {
      requestedTags.push(tag);
      return [
        { title: "Used", artist: "A", lastFmUrl: "used", rank: 1 },
        { title: "Missing", artist: "B", lastFmUrl: "missing", rank: 2 },
        { title: "Found", artist: "C", lastFmUrl: "found", rank: 3 },
      ];
    },
    excludedSongKeys: new Set([lastFmTrackKey({ title: "Used", artist: "A" })]),
    random: () => 0.5,
    screen: async (_post, candidates) => ({
      allowedIndices: candidates.map((_, index) => index),
    }),
    trackInfo: async () => ({ listeners: 100, summary: "", topTags: [] }),
    searchYoutube: async (title) => {
      searched.push(title);
      return title === "Found" ? {
        videoId: "video-found",
        url: "https://www.youtube.com/watch?v=video-found",
        videoTitle: "Found C",
        channelTitle: "C",
      } : null;
    },
    comment: async (_post, _lang, song) => `${song.title}が合いそう！`,
  });
  assert.deepEqual(searched, ["Missing", "Found"]);
  assert.deepEqual(requestedTags.sort(), ["j-pop", "japanese"]);
  assert.equal(result?.videoId, "video-found");
  assert.equal(result?.comment, "Foundが合いそう！");
  assert.deepEqual(result?.tags, ["calm"]);
  assert.equal(result?.screenedOutCount, 0);
});
