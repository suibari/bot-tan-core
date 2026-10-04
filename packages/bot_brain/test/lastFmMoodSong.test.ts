import assert from "node:assert/strict";
import test from "node:test";
import {
  getLastFmArtistTopTracks,
  getLastFmArtistTags,
  getLastFmTopTracks,
  getLastFmTrackInfo,
  searchLastFmArtists,
  searchLastFmTracks,
} from "../src/api/lastfm/index.js";
import { getAnimeThemeSongs, searchAnimeThemes } from "../src/api/animethemes/index.js";
import {
  classifyLastFmMoodTags,
  analyzeSongDiscovery,
  discoverLastFmMoodSongCandidates,
  interestMusicTags,
  parseSongDiscoveryAnalysis,
  buildLastFmMoodSongComment,
  extractAnimeWorkMention,
  lastFmTrackKey,
  parseMoodTagClassification,
  rankJapaneseLastFmTracks,
  rankLastFmTrackPools,
  resolveLastFmMoodSong,
  screenLastFmMoodSongCandidates,
} from "../src/ai/lastFmMoodSong.js";

test("AnimeThemesの検索結果と作品のOP/EDを整形する", async () => {
  let searchUrl = "";
  const anime = await searchAnimeThemes("Mobile Suit Gundam", {
    fetchImpl: async (input) => {
      searchUrl = String(input);
      return new Response(JSON.stringify({
        search: { anime: [{ id: 1923, name: "Mobile Suit Gundam", slug: "mobile_suit_gundam", year: 1979 }] },
      }));
    },
  });
  assert.equal(new URL(searchUrl).searchParams.get("q"), "Mobile Suit Gundam");
  assert.deepEqual(anime, [{ id: 1923, name: "Mobile Suit Gundam", slug: "mobile_suit_gundam", year: 1979 }]);

  let themesUrl = "";
  const themes = await getAnimeThemeSongs("Mobile Suit Gundam", {
    fetchImpl: async (input) => {
      themesUrl = String(input);
      return new Response(JSON.stringify({ anime: [{
        name: "Mobile Suit Gundam",
        animethemes: [{
          type: "OP",
          sequence: 1,
          song: { title: "Tobe! Gundam", artists: [{ name: "池田鴻" }] },
        }],
      }] }));
    },
  });
  const url = new URL(themesUrl);
  assert.equal(url.searchParams.get("filter[name]"), "Mobile Suit Gundam");
  assert.equal(url.searchParams.get("include"), "animethemes.song.artists");
  assert.deepEqual(themes, [{
    animeName: "Mobile Suit Gundam",
    type: "OP",
    sequence: 1,
    title: "Tobe! Gundam",
    artists: ["池田鴻"],
  }]);
});

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

test("Last.fm track.searchで欠けたアニメ主題歌の歌手を補える", async () => {
  let requested = "";
  const tracks = await searchLastFmTracks("Tobe! Gundam", {
    apiKey: "test-key",
    fetchImpl: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ results: { trackmatches: { track: [{
        name: "Tobe! Gundam",
        artist: "池田鴻",
        url: "https://last.fm/music/example",
      }] } } }));
    },
  });
  const url = new URL(requested);
  assert.equal(url.searchParams.get("method"), "track.search");
  assert.equal(url.searchParams.get("track"), "Tobe! Gundam");
  assert.equal(tracks[0]?.artist, "池田鴻");
});

test("Last.fmでアーティストを正規化し、その代表曲を取得する", async () => {
  let artistSearchUrl = "";
  const artists = await searchLastFmArtists("Perfume", {
    apiKey: "test-key",
    fetchImpl: async (input) => {
      artistSearchUrl = String(input);
      return new Response(JSON.stringify({ results: { artistmatches: { artist: [{
        name: "Perfume",
        url: "https://last.fm/music/Perfume",
        mbid: "artist-mbid",
      }] } } }));
    },
  });
  assert.equal(new URL(artistSearchUrl).searchParams.get("method"), "artist.search");
  assert.equal(artists[0]?.name, "Perfume");

  let topTracksUrl = "";
  const tracks = await getLastFmArtistTopTracks(artists[0]!, {
    apiKey: "test-key",
    fetchImpl: async (input) => {
      topTracksUrl = String(input);
      return new Response(JSON.stringify({ toptracks: { track: [{
        name: "Dream Fighter",
        url: "https://last.fm/dream-fighter",
        artist: { name: "Perfume" },
        "@attr": { rank: "2" },
      }] } }));
    },
  });
  const url = new URL(topTracksUrl);
  assert.equal(url.searchParams.get("method"), "artist.getTopTracks");
  assert.equal(url.searchParams.get("mbid"), "artist-mbid");
  assert.equal(tracks[0]?.title, "Dream Fighter");
});

test("Last.fmの歌手タグを曲調の判断材料として取得する", async () => {
  let requestUrl = "";
  const tags = await getLastFmArtistTags("燐舞曲", {
    apiKey: "test-key",
    fetchImpl: async (input) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ artist: { tags: { tag: [
        { name: "alternative rock" }, { name: "metalcore" },
      ] } } }));
    },
  });
  assert.equal(new URL(requestUrl).searchParams.get("method"), "artist.getInfo");
  assert.deepEqual(tags, ["alternative rock", "metalcore"]);
});

test("統合解析は履歴と依頼を分離し、今回の依頼を最後に置く", async () => {
  let captured: any;
  const analysis = await analyzeSongDiscovery({
    postText: "DJお願い、Perfumeの曲がいい",
    recentPosts: ["渋谷を歩いてきた", "雨の日に勉強中"],
  }, "日本語", {
    chat: async (feature, messages, options) => {
      captured = { feature, messages, options };
      return JSON.stringify({
        request: {
          anime: null,
          artist: { mentionedName: "Perfume", searchQuery: "Perfume", genericFranchise: false },
          topic: null,
        },
        history: {
          anime: null,
          artist: null,
          topic: { mentionedName: "渋谷", searchQuery: "渋谷", genericFranchise: false },
        },
        tags: ["energetic", "dance"],
        titleQuery: null,
      });
    },
  });
  assert.equal(analysis.request.artist?.searchQuery, "Perfume");
  assert.equal(analysis.history.topic?.searchQuery, "渋谷");
  assert.equal(analysis.titleQuery, null);
  assert.equal(captured.messages.at(-1).content, "DJお願い、Perfumeの曲がいい");
  assert.match(captured.messages.at(-2).content, /渋谷を歩いてきた/);
  assert.equal(captured.options.temperature, 0.1);
  assert.equal("num_ctx" in captured.options, false);
});

test("解析が投稿にない題材を創作した場合は破棄する", async () => {
  const analysis = await analyzeSongDiscovery({
    postText: "最近の投稿に合う曲を選んで",
    recentPosts: ["Perfumeを聴きながら作業した"],
  }, "日本語", {
    chat: async () => JSON.stringify({
      request: { anime: null, artist: null, topic: { mentionedName: "作業", searchQuery: "作業" } },
      history: { anime: null, artist: { mentionedName: "Perfume", searchQuery: "Perfume" }, topic: null },
      tags: ["focus"],
      titleQuery: null,
    }),
  });
  assert.equal(analysis.request.topic, null);
  assert.equal(analysis.history.artist?.mentionedName, "Perfume");
});

test("解析のsearchQueryが投稿にない場合はmentionedNameへ寄せる", async () => {
  const analysis = await analyzeSongDiscovery({
    postText: "DJお願い、Perfumeの曲がいい",
    recentPosts: [],
  }, "日本語", {
    chat: async () => JSON.stringify({
      request: {
        anime: null,
        artist: { mentionedName: "Perfume", searchQuery: "Taylor Swift", genericFranchise: false },
        topic: null,
      },
      history: { anime: null, artist: null, topic: null },
      tags: ["dance"],
      titleQuery: null,
    }),
  });
  assert.equal(analysis.request.artist?.searchQuery, "Perfume");
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

test("アニメ作品名を検索用英題へ変換し、投稿を最後に置く", async () => {
  let captured: any;
  const mention = await extractAnimeWorkMention("今日はガンダムの話で盛り上がった", "日本語", {
    chat: async (feature, messages, options) => {
      captured = { feature, messages, options };
      return '{"mentionedTitle":"ガンダム","searchQuery":"Mobile Suit Gundam","genericFranchise":true}';
    },
  });
  assert.deepEqual(mention, {
    mentionedTitle: "ガンダム",
    searchQuery: "Mobile Suit Gundam",
    genericFranchise: true,
  });
  assert.equal(captured.feature, "COMMON_MOOD_SONG_LOCAL");
  assert.equal(captured.messages.at(-1).content, "今日はガンダムの話で盛り上がった");
  assert.equal(captured.options.temperature, 0.1);
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

test("題材検索候補は曲名・作者・URLが検索資料にあるものだけを採用する", async () => {
  const research = "URL: https://example.test/shibuya\n『渋谷で5時』は鈴木雅之と菊池桃子による楽曲。";
  const assessment = await screenLastFmMoodSongCandidates("渋谷モチーフの曲", [], "日本語", {
    chat: async () => JSON.stringify({
      allowedIndices: [],
      researchedCandidates: [
        { title: "渋谷で5時", artist: "鈴木雅之 & 菊池桃子", evidenceUrl: "https://example.test/shibuya" },
        { title: "架空曲", artist: "架空歌手", evidenceUrl: "https://example.test/shibuya" },
      ],
    }),
  }, research);
  assert.deepEqual(assessment.researchedCandidates, [{
    title: "渋谷で5時",
    artist: "鈴木雅之 & 菊池桃子",
    evidenceUrl: "https://example.test/shibuya",
  }]);
});

test("履歴曲を除外し、YouTubeで確認できた候補にだけコメントを付ける", async () => {
  const searched: string[] = [];
  const requestedTags: string[] = [];
  const result = await resolveLastFmMoodSong("穏やかな午後", "日本語", {
    classify: async () => ({ tags: ["calm"] }),
    extractAnime: async () => ({ mentionedTitle: null, searchQuery: null, genericFranchise: false }),
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
  // j-pop / japanese は日本の曲の判定にも使うのでページ別に複数回引く。
  assert.deepEqual([...new Set(requestedTags)].sort(), ["calm", "j-pop", "japanese"]);
  assert.equal(result?.videoId, "video-found");
  assert.equal(result?.comment, "Foundが合いそう！");
  assert.deepEqual(result?.tags, ["calm"]);
  assert.equal(result?.screenedOutCount, 0);
});

test("ガンダム明示時は通常の気分タグ分類より先に公式OPを選ぶ", async () => {
  let classified = false;
  let searchedTrack = "";
  const result = await resolveLastFmMoodSong("今日はガンダムの話で盛り上がった", "日本語", {
    classify: async () => {
      classified = true;
      return { tags: ["happy"] };
    },
    extractAnime: async () => ({
      mentionedTitle: "ガンダム",
      searchQuery: "Mobile Suit Gundam",
      genericFranchise: true,
    }),
    searchAnime: async () => [{
      id: 1923,
      name: "Mobile Suit Gundam",
      slug: "mobile_suit_gundam",
      year: 1979,
    }],
    themeSongs: async () => [{
      animeName: "Mobile Suit Gundam",
      type: "OP",
      sequence: 1,
      title: "Tobe! Gundam (Fly! Gundam)",
      artists: [],
    }],
    topTracks: async () => [],
    searchTracks: async (query) => {
      searchedTrack = query;
      return [{
        title: "Tobe! Gundam",
        artist: "池田鴻",
        lastFmUrl: "https://last.fm/tobe-gundam",
        rank: 1,
      }];
    },
    trackInfo: async () => ({ listeners: 100, summary: "Japanese anime opening theme", topTags: ["anime"] }),
    screen: async (_post, candidates) => ({ allowedIndices: candidates.map((_, index) => index) }),
    searchYoutube: async () => ({
      videoId: "gundam-op",
      url: "https://www.youtube.com/watch?v=gundam-op",
      videoTitle: "翔べ！ガンダム",
      channelTitle: "official",
    }),
    comment: async (_post, _lang, song) => `${song.animeTheme?.animeName}の${song.animeTheme?.type}！`,
    random: () => 0.5,
  });
  assert.equal(classified, false);
  assert.equal(searchedTrack, "Tobe! Gundam (Fly! Gundam)");
  assert.equal(result?.artist, "池田鴻");
  assert.equal(result?.videoId, "gundam-op");
  assert.deepEqual(result?.animeTheme, {
    animeName: "Mobile Suit Gundam",
    type: "OP",
    sequence: 1,
  });
  assert.deepEqual(result?.tags, ["happy"]);
});

test("コメント生成は共通SYSTEM_INSTRUCTIONを人格の基礎にする", async () => {
  let system = "";
  const comment = await buildLastFmMoodSongComment("今日はいい日", "日本語", {
    title: "Song",
    artist: "Artist",
  }, {
    chat: async (_feature, messages) => {
      system = messages[0]?.content ?? "";
      return '{"comment":"いい日にぴったりだね！"}';
    },
  });
  assert.equal(comment, "いい日にぴったりだね！");
  assert.match(system, /全肯定SNS「Nagi」/);
  assert.match(system, /# 選曲コメント/);
});

test("Web根拠がない題材候補を確認済みとして紹介しない", async () => {
  let system = "";
  await buildLastFmMoodSongComment("渋谷をモチーフにした曲", "日本語", {
    title: "渋谷",
    artist: "Artist",
    selectionBasis: { kind: "topic", label: "渋谷", source: "request" },
  }, {
    chat: async (_feature, messages) => {
      system = messages[0]?.content ?? "";
      return '{"comment":"渋谷という題名から選んだよ"}';
    },
  });
  assert.match(system, /確認できていないのに断定しない/);
  assert.doesNotMatch(system, /関係が検索資料で確認された/);
});

test("アーティスト指定、題材指定、指定なしの各経路で実在確認済みの曲を選べる", async (t) => {
  const base = {
    searchAnime: async () => [],
    themeSongs: async () => [],
    searchArtists: async () => [],
    artistTopTracks: async () => [],
    searchTracks: async () => [],
    topTracks: async () => [],
    trackInfo: async () => ({ listeners: 100, summary: "safe Japanese song", topTags: ["j-pop"] }),
    artistTags: async () => [],
    researchTopic: async () => "",
    random: () => 0.5,
    searchYoutube: async (title: string, artist: string) => ({
      videoId: `${title}-${artist}`,
      url: `https://youtube.example/${encodeURIComponent(title)}`,
      videoTitle: `${title} ${artist}`,
      channelTitle: artist,
    }),
    comment: async (_post: string, _lang: "日本語" | "English", song: { title: string }) => `${song.title}を選んだよ！`,
  };

  await t.test("アーティスト名から代表曲を選ぶ", async () => {
    const song = await resolveLastFmMoodSong("DJお願い、Perfumeの曲", "日本語", {
      ...base,
      analyze: async () => ({
        request: { anime: null, artist: { mentionedName: "Perfume", searchQuery: "Perfume" }, topic: null },
        history: { anime: null, artist: null, topic: null },
        tags: ["dance"],
      }),
      searchArtists: async () => [{ name: "Perfume", lastFmUrl: "https://last.fm/perfume", mbid: "perfume" }],
      artistTopTracks: async () => [{
        title: "Dream Fighter",
        artist: "Perfume",
        lastFmUrl: "https://last.fm/dream-fighter",
        rank: 1,
      }],
      screen: async (_post, candidates) => ({ allowedIndices: candidates.map((_, index) => index) }),
    });
    assert.equal(song?.title, "Dream Fighter");
    assert.equal(song?.selectionBasis?.kind, "artist");
  });

  await t.test("題材のWeb根拠から曲を選ぶ", async () => {
    const song = await resolveLastFmMoodSong("DJお願い、渋谷モチーフで", "日本語", {
      ...base,
      analyze: async () => ({
        request: { anime: null, artist: null, topic: { mentionedName: "渋谷", searchQuery: "渋谷" } },
        history: { anime: null, artist: null, topic: null },
        tags: ["energetic"],
      }),
      researchTopic: async () => "URL: https://example.test/shibuya\n渋谷を題材にした楽曲『渋谷で5時』は鈴木雅之と菊池桃子による。",
      screen: async (_post, _candidates, _lang, _deps, research) => ({
        allowedIndices: [],
        researchedCandidates: research ? [{
          title: "渋谷で5時",
          artist: "鈴木雅之 & 菊池桃子",
          evidenceUrl: "https://example.test/shibuya",
        }] : [],
      }),
    });
    assert.equal(song?.title, "渋谷で5時");
    assert.equal(song?.selectionBasis?.kind, "topic");
    assert.equal(song?.selectionBasis?.evidenceUrl, "https://example.test/shibuya");
  });

  await t.test("固有名詞なしでは気分タグから選ぶ", async () => {
    const song = await resolveLastFmMoodSong("穏やかな午後だね", "日本語", {
      ...base,
      analyze: async () => ({
        request: { anime: null, artist: null, topic: null },
        history: { anime: null, artist: null, topic: null },
        tags: ["calm"],
      }),
      topTracks: async (tag) => tag === "calm" ? [{
        title: "やさしさに包まれたなら",
        artist: "松任谷由実",
        lastFmUrl: "https://last.fm/yasashisa",
        rank: 1,
      }] : [],
      screen: async (_post, candidates) => ({ allowedIndices: candidates.map((_, index) => index) }),
    });
    assert.equal(song?.title, "やさしさに包まれたなら");
    assert.equal(song?.selectionBasis?.kind, "mood");
  });

  await t.test("投稿中の情景語から曲名を検索し、汎用タグ候補より優先する", async () => {
    const song = await resolveLastFmMoodSong("雨音を聞きながら穏やかに過ごしたい", "日本語", {
      ...base,
      analyze: async () => ({
        request: { anime: null, artist: null, topic: null },
        history: { anime: null, artist: null, topic: null },
        tags: ["calm", "rainy day"],
        titleQuery: "雨音",
      }),
      searchTracks: async () => [{ title: "雨音", artist: "つじあやの", lastFmUrl: "https://last.fm/amaoto", rank: 1 }],
      topTracks: async () => [{ title: "踊れる曲", artist: "例の歌手", lastFmUrl: "https://last.fm/dance", rank: 1 }],
      screen: async (_post, candidates) => ({ allowedIndices: candidates.map((_, index) => index) }),
    });
    assert.equal(song?.title, "雨音");
    assert.equal(song?.selectionBasis?.kind, "mood");
  });

  await t.test("同じ検索語の曲は安全判定が返した適合順で選ぶ", async () => {
    const song = await resolveLastFmMoodSong("雨音を聞きながら穏やかに過ごしたい", "日本語", {
      ...base,
      analyze: async () => ({
        request: { anime: null, artist: null, topic: null },
        history: { anime: null, artist: null, topic: null },
        tags: ["calm"],
        titleQuery: "雨音",
      }),
      searchTracks: async () => [
        { title: "雨音", artist: "激しいバンド", lastFmUrl: "https://last.fm/rock", rank: 1 },
        { title: "雨音", artist: "穏やかな歌手", lastFmUrl: "https://last.fm/gentle", rank: 2 },
      ],
      screen: async () => ({ allowedIndices: [1, 0] }),
    });
    assert.equal(song?.artist, "穏やかな歌手");
  });
});

test("曲数の多いアーティストも抽選では最良の1曲ぶんにそろえる", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    title: `Hit ${index + 1}`, artist: "宇多田ヒカル", lastFmUrl: `u${index}`, rank: index + 1,
  }));
  const single = { title: "Only", artist: "Other", lastFmUrl: "o", rank: 1 };
  // 乱数を固定すると、抽選の重みが大きい順に並ぶ。生の重みは同じでも、合計を分け合う側が負ける。
  const ranked = rankLastFmTrackPools([{ tag: "j-pop", tracks: [...many, single] }], () => 0.5);
  assert.equal(ranked[0].artist, "Other");
  assert.equal(ranked.find((track) => track.title === "Hit 1")?.weight, 1);
});

test("4つ目以降のタグも捨てず、補正用タグは候補を増やさない", () => {
  const track = (title: string, rank = 1) => ({ title, artist: title, lastFmUrl: title, rank });
  const ranked = rankLastFmTrackPools([
    { tag: "a", tracks: [track("A")] },
    { tag: "b", tracks: [track("B")] },
    { tag: "c", tracks: [track("C")] },
    { tag: "d", tracks: [track("D")] },
  ], () => 0.5, { boostPools: [{ tag: "calm", tracks: [track("A"), track("Mood only")] }] });
  assert.deepEqual(ranked.map((song) => song.title).sort(), ["A", "B", "C", "D"]);
  assert.deepEqual(ranked.find((song) => song.title === "A")?.tags, ["a", "calm"]);
  assert.equal(ranked.find((song) => song.title === "D")?.weight, 0.2);
});

test("抽選の重みへ係数を掛けても、返す重みは生の値のまま", () => {
  const ranked = rankLastFmTrackPools([{ tag: "j-pop", tracks: [
    { title: "Western", artist: "Band", lastFmUrl: "w", rank: 1 },
    { title: "邦楽", artist: "歌手", lastFmUrl: "j", rank: 4 },
  ] }], () => 0.5, { trackFactor: (track) => track.title === "Western" ? 0.3 : 1 });
  assert.equal(ranked[0].title, "邦楽");
  assert.equal(ranked[1].weight, 1);
});

test("ジャンルは言語ごとの許可値だけを採用する", () => {
  const base = { request: {}, history: {}, tags: ["calm"], titleQuery: null };
  assert.equal(parseSongDiscoveryAnalysis(JSON.stringify({ ...base, genre: "idol" }), "日本語").genre, "idol");
  assert.equal(parseSongDiscoveryAnalysis(JSON.stringify({ ...base, genre: "pop" }), "日本語").genre, null);
  assert.equal(parseSongDiscoveryAnalysis(JSON.stringify({ ...base, genre: "pop" }), "English").genre, "pop");
  assert.equal(parseSongDiscoveryAnalysis(JSON.stringify(base), "日本語").genre, null);
});

test("関心の語からアニメとアイドルだけを曲のジャンルへ対応づける", () => {
  assert.deepEqual(interestMusicTags(["料理", "地下アイドル", "nagiアニメ部", "アイドル", "ゲーム"]), ["anime", "idol"]);
  assert.deepEqual(interestMusicTags(["ゲーム", "AI"]), []);
});

/** ムード枠の検証用。タグごとの上位曲を固定し、安全確認は全件通す。 */
const moodDeps = (charts: Record<string, Array<{ title: string; artist: string }>>, requested: Array<{ tag: string; page?: number }> = []) => ({
  analyze: async () => ({
    request: { anime: null, artist: null, topic: null },
    history: { anime: null, artist: null, topic: null },
    tags: ["calm" as const],
    genre: "j-pop",
  }),
  topTracks: async (tag: string, options?: { page?: number }) => {
    requested.push({ tag, page: options?.page });
    return (charts[tag] ?? []).map((track, index) => ({ ...track, lastFmUrl: `${tag}-${index}`, rank: index + 1 }));
  },
  trackInfo: async () => ({ listeners: 100, summary: "", topTags: [] }),
  screen: async (_post: string, candidates: unknown[]) => ({ allowedIndices: candidates.map((_, index) => index) }),
  random: () => 0.5,
});

test("日本語のムード枠はジャンルと japanese を候補にし、ムードタグは補正だけにする", async () => {
  const requested: Array<{ tag: string; page?: number }> = [];
  const { allowed } = await discoverLastFmMoodSongCandidates("穏やかな午後", "日本語", moodDeps({
    "j-pop": [{ title: "First Love", artist: "宇多田ヒカル" }],
    japanese: [{ title: "ポリリズム", artist: "Perfume" }],
    calm: [{ title: "Western calm", artist: "Somebody" }, { title: "ポリリズム", artist: "Perfume" }],
  }, requested));
  assert.deepEqual(allowed.map((song) => song.title).sort(), ["First Love", "ポリリズム"]);
  assert.deepEqual(allowed.find((song) => song.title === "ポリリズム")?.tags, ["japanese", "calm"]);
  // random 0.5 なら 2 ページ目。j-pop / japanese は日本の曲の判定にも使うので全ページ引く。
  assert.deepEqual([...new Set(requested.filter((call) => call.tag === "j-pop").map((call) => call.page))].sort(), [1, 2, 3]);
});

test("投稿判定が j-pop の回は、本人の関心ジャンルを言語タグなしで軸にする", async () => {
  const requested: Array<{ tag: string; page?: number }> = [];
  const { allowed } = await discoverLastFmMoodSongCandidates("今日もがんばった", "日本語", {
    ...moodDeps({
      "j-pop": [{ title: "First Love", artist: "宇多田ヒカル" }],
      japanese: [{ title: "ポリリズム", artist: "Perfume" }],
      idol: [{ title: "会いたかった", artist: "AKB48" }],
    }, requested),
    interestMusicTags: ["idol"],
  });
  assert.deepEqual(allowed.map((song) => song.title), ["会いたかった"]);
  assert.ok(requested.some((call) => call.tag === "idol" && call.page === 2));
});

test("投稿からジャンルが判定できたら、関心ジャンルより投稿を優先する", async () => {
  const deps = moodDeps({
    japanese: [{ title: "ポリリズム", artist: "Perfume" }],
    vocaloid: [{ title: "メルト", artist: "ryo" }],
    idol: [{ title: "会いたかった", artist: "AKB48" }],
  });
  const { allowed } = await discoverLastFmMoodSongCandidates("ボカロ聴いてる", "日本語", {
    ...deps,
    analyze: async () => ({ ...(await deps.analyze()), genre: "vocaloid" }),
    interestMusicTags: ["idol"],
  });
  assert.deepEqual(allowed.map((song) => song.title).sort(), ["ポリリズム", "メルト"]);
});

test("7日以内に流した歌手はムード枠から外し、尽きるなら戻す", async () => {
  const charts = {
    "j-pop": [{ title: "First Love", artist: "宇多田ヒカル" }, { title: "ブルーバード", artist: "いきものがかり" }],
  };
  const avoided = await discoverLastFmMoodSongCandidates("穏やか", "日本語", {
    ...moodDeps(charts),
    recentArtists: { avoid: new Set(["宇多田ヒカル"]), demote: new Set() },
  });
  assert.deepEqual(avoided.allowed.map((song) => song.artist), ["いきものがかり"]);
  const exhausted = await discoverLastFmMoodSongCandidates("穏やか", "日本語", {
    ...moodDeps(charts),
    recentArtists: { avoid: new Set(["宇多田ヒカル", "いきものがかり"]), demote: new Set() },
  });
  assert.equal(exhausted.allowed.length, 2);
});

test("直近3回に流した歌手の指定はムード枠の後ろへ回し、DJの明示依頼は抑えない", async () => {
  const deps = (source: "request" | "history") => ({
    ...moodDeps({ "j-pop": [{ title: "ブルーバード", artist: "いきものがかり" }] }),
    analyze: async () => {
      const artist = { mentionedName: "The Pillows", searchQuery: "The Pillows" };
      return {
        request: { anime: null, artist: source === "request" ? artist : null, topic: null },
        history: { anime: null, artist: source === "history" ? artist : null, topic: null },
        tags: ["calm" as const],
        genre: "j-pop",
      };
    },
    searchArtists: async () => [{ name: "The Pillows", lastFmUrl: "https://last.fm/pillows", mbid: "" }],
    artistTopTracks: async () => [{ title: "Funny Bunny", artist: "The Pillows", lastFmUrl: "fb", rank: 1 }],
  });
  const recentArtists = { avoid: new Set<string>(), demote: new Set(["thepillows"]) };
  const order = async (source: "request" | "history", demoteRequest?: boolean) =>
    (await discoverLastFmMoodSongCandidates("さわおさん", "日本語", {
      ...deps(source), recentArtists: { ...recentArtists, demoteRequest },
    })).allowed.map((song) => song.artist);
  assert.deepEqual(await order("history"), ["いきものがかり", "The Pillows"]);
  assert.deepEqual(await order("request"), ["The Pillows", "いきものがかり"]);
  assert.deepEqual(await order("request", true), ["いきものがかり", "The Pillows"]);
});
