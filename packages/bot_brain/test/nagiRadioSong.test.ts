import assert from "node:assert/strict";
import test from "node:test";
import { getLastFmTrackInfo, lastFmAlbumImage, lastFmSongUrl } from "../src/api/lastfm/index.js";
import { resolveLinkedMoodSong, resolveNagiRadioSong, resolveNagiRadioSongLink } from "../src/ai/linkedMoodSong.js";
import { discoverLastFmMoodSongCandidates, type RankedLastFmTrack } from "../src/ai/lastFmMoodSong.js";
import { songIdentityKey } from "../src/ai/songIdentity.js";
import { selectNagiRadioCandidate } from "../src/ai/nagiRadioCandidate.js";

const songUrl = "https://www.last.fm/music/Artist/_/Song";
const thumbnailUrl = "https://lastfm-img.freetls.fastly.net/i/u/300x300/album.png";
const info = { title: "Song", artist: "Artist", lastFmUrl: songUrl, thumbnailUrl, listeners: 10, summary: "", topTags: [] };
const candidate: RankedLastFmTrack = { title: "Song", artist: "Artist", lastFmUrl: songUrl, rank: 1, tags: [], weight: 1, info };
const scope = { purpose: "dj", subjectDid: "did:plc:alice" } as const;
const pool = (allowed: RankedLastFmTrack[]) => ({ allowed, screenedOutCount: 0, contextualPostText: "Hello", tags: [] });

test("曲詳細から曲URLと最大サイズの実ジャケットを取得する", async () => {
  const actual = await getLastFmTrackInfo("Song", "Artist", {
    apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ track: {
      name: "Song", artist: { name: "Artist" }, url: songUrl, listeners: "10",
      album: { image: [{ size: "small", "#text": thumbnailUrl.replace("300x300", "34s") },
        { size: "extralarge", "#text": thumbnailUrl }] },
    } })),
  });
  assert.deepEqual(actual, info);
});

test("空・ダミー・別ホストの画像と曲でないURLは使わない", () => {
  for (const value of ["", "https://evil.test/image.png", "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png"]) {
    assert.equal(lastFmAlbumImage([{ size: "extralarge", "#text": value }]), undefined);
  }
  for (const value of ["javascript:alert(1)", "https://last.fm.evil.test/music/A/_/B", "https://www.last.fm/music/Artist"])
    assert.equal(lastFmSongUrl(value), undefined);
  assert.equal(lastFmSongUrl(songUrl.replace("https:", "http:")), songUrl);
});

test("曲リンクだけで候補を選べ、既取得の曲詳細を再取得しない", async () => {
  const song = await resolveNagiRadioSong("Hello", "English", scope, {
    getRecentSelections: async () => [], discover: async () => pool([candidate]),
    trackInfo: async () => { throw new Error("must reuse info"); },
  });
  assert.deepEqual(song, { title: "Song", artist: "Artist", songKey: songIdentityKey(candidate), songUrl, thumbnailUrl, url: songUrl, lastFmUrl: songUrl, comment: "" });
  assert.equal(song?.videoId, undefined);
  assert.equal((await selectNagiRadioCandidate(async () => song, async () => null, 1))?.song, song);
});

test("サムネイルなしの曲を飛ばし、正規化後の曲キーも重複判定する", async () => {
  const song = await resolveNagiRadioSong("Hello", "English", scope, {
    getRecentSelections: async () => [], excludeSongKeys: new Set([songIdentityKey(candidate)]),
    discover: async (_input, _language, options) => {
      assert.ok(options?.excludedSongKeys?.has(songIdentityKey(candidate)));
      return pool([
        { ...candidate, title: "Alias" },
        { ...candidate, title: "No cover", info: { ...info, title: "No cover", thumbnailUrl: undefined } },
        { ...candidate, title: "Other", info: { ...info, title: "Other", lastFmUrl: songUrl + "Other" } },
      ]);
    },
  });
  assert.equal(song?.title, "Other");
});

test("画像やLast.fm曲ページがなければ推測リンクを作らない", async () => {
  assert.equal(await resolveNagiRadioSongLink("Song", "Artist", async () => ({ ...info, thumbnailUrl: undefined })), null);
  assert.equal(await resolveNagiRadioSongLink("Song", "Artist", async () => ({ ...info, lastFmUrl: undefined })), null);
});

test("実際の候補探索からラジオ曲リンクまでYouTube検索を一度も呼ばない", async () => {
  let youtubeCalls = 0;
  const song = await resolveNagiRadioSong("晴れた朝", "English", scope, {
    getRecentSelections: async () => [],
    discover: (input, language, options) => discoverLastFmMoodSongCandidates(input, language, {
      ...options,
      analyze: async () => ({ request: { anime: null, artist: null, topic: null },
        history: { anime: null, artist: null, topic: null }, tags: ["happy"] }),
      topTracks: async () => [candidate], trackInfo: async () => info,
      screen: async () => ({ allowedIndices: [0], additionalCandidates: [] }),
      searchYoutube: async () => { youtubeCalls++; throw new Error("YouTube quota exceeded"); },
    }),
  });
  assert.equal(song?.songUrl, songUrl);
  assert.equal(youtubeCalls, 0);
});


test("Bluesky DJ用はLast.fmリンクに紹介文を添え、動画検索は不要", async () => {
  const song = await resolveLinkedMoodSong("Hello", "English", scope, {
    getRecentSelections: async () => [], discover: async () => pool([candidate]),
    comment: async (_post, _language, picked) => `Listen to ${picked.title}!`,
  });
  assert.equal(song?.url, songUrl);
  assert.equal(song?.thumbnailUrl, thumbnailUrl);
  assert.equal(song?.comment, "Listen to Song!");
  assert.equal(song?.videoId, undefined);
});

test("リンク型DJも投稿前に予約し、動画IDなしの複数曲を記憶する", async () => {
  const { MoodSongResolver } = await import("../src/ai/memorySong.js");
  const song = await resolveLinkedMoodSong("Hello", "English", scope, {
    getRecentSelections: async () => [], discover: async () => pool([candidate]), comment: async () => "Hello",
  });
  assert.ok(song);
  let excluded = new Set<string>();
  const now = new Date();
  const resolver = new MoodSongResolver<typeof song>(30, {
    now: () => now,
    resolve: async (_input, _language, _scope, deps) => { excluded = new Set(deps?.excludeSongKeys); return song; },
    reserve: async (selected) => {
      assert.equal(selected.videoId, undefined);
      return { id: 1, videoId: null, songKey: selected.songKey, scope, selectedAt: now, expiresAt: new Date(now.getTime() + 60_000) };
    },
  });
  const reserved = await resolver.resolveAndReserve("Hello", "English", scope);
  assert.equal(reserved?.song.url, songUrl);
  resolver.remember(scope, song);
  resolver.remember(scope, { ...song, songKey: "other-song" });
  await resolver.resolve("Hello", "English", scope);
  assert.deepEqual(excluded, new Set([song.songKey, "other-song"]));
});
