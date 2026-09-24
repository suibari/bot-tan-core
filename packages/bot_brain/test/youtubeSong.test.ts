import assert from "node:assert/strict";
import test from "node:test";
import { selectYoutubeSongMatch } from "../src/api/youtube/index.js";

test("曲名と作者が動画タイトルまたはチャンネルに一致する動画を返す", () => {
  const result = selectYoutubeSongMatch([
    {
      id: { videoId: "unrelated" },
      snippet: { title: "I LOVE YOU cover", channelTitle: "別の歌手" },
    },
    {
      id: { videoId: "official" },
      snippet: { title: "尾崎豊『I LOVE YOU』Official Music Video", channelTitle: "Sony Music" },
    },
  ], "I LOVE YOU", "尾崎豊");
  assert.equal(result?.videoId, "official");
  assert.equal(result?.url, "https://www.youtube.com/watch?v=official");
});

test("検索語に似ていても作者を確認できない動画は返さない", () => {
  const result = selectYoutubeSongMatch([
    {
      id: { videoId: "cover" },
      snippet: { title: "I LOVE YOU / cover", channelTitle: "別の歌手" },
    },
  ], "I LOVE YOU", "尾崎豊");
  assert.equal(result, null);
});

test("曲名と歌手名がタグにあっても歌ってみたを採用しない", () => {
  const cover = {
    id: { videoId: "fan-cover" },
    snippet: {
      title: "ライバル! The rivals #ポケモン #松本梨香 #歌ってみた #ものまね #shorts",
      channelTitle: "ファンのチャンネル",
    },
  };
  assert.equal(selectYoutubeSongMatch([cover], "Rival!", "松本梨香", ["ポケモン"]), null);
  const result = selectYoutubeSongMatch([
    cover,
    {
      id: { videoId: "original" },
      snippet: { title: "松本梨香 - Rival! ライバル!", channelTitle: "松本梨香 - Topic" },
    },
  ], "Rival!", "松本梨香", ["ポケモン"]);
  assert.equal(result?.videoId, "original");
});

test("検索上位に非公式投稿があっても本人チャンネルの動画を選ぶ", () => {
  const result = selectYoutubeSongMatch([
    { id: { videoId: "reupload" }, snippet: { title: "NOMA Brain Power", channelTitle: "Music Archive" } },
    { id: { videoId: "artist" }, snippet: { title: "Brain Power", channelTitle: "NOMA" } },
  ], "Brain Power", "NOMA");
  assert.equal(result?.videoId, "artist");
  assert.equal(selectYoutubeSongMatch([
    { id: { videoId: "reupload" }, snippet: { title: "NOMA Brain Power", channelTitle: "Music Archive" } },
  ], "Brain Power", "NOMA"), null);
});

test("括弧内の作者別名でも一致する", () => {
  const result = selectYoutubeSongMatch([
    {
      id: { videoId: "brain-power" },
      snippet: { title: "NOMA - Brain Power", channelTitle: "NOMA" },
    },
  ], "Brain Power", "ノマ（NOMA）");
  assert.equal(result?.url, "https://www.youtube.com/watch?v=brain-power");
});

test("ローマ字題と日本語題が混在しても固有語と作者が一致すれば採用する", () => {
  const result = selectYoutubeSongMatch([
    {
      id: { videoId: "gundam-op" },
      snippet: { title: "翔べ！ガンダム", channelTitle: "池田鴻 - Topic" },
    },
  ], "Tobe! Gundam", "池田鴻", ["ガンダム"]);
  assert.equal(result?.videoId, "gundam-op");
});

test("作者名を補助語に渡しても別の曲を採用しない", () => {
  const result = selectYoutubeSongMatch([{
    id: { videoId: "wrong-song" },
    snippet: { title: "Perfume - ポリリズム", channelTitle: "Perfume" },
  }], "Dream Fighter", "Perfume", ["Perfume"]);
  assert.equal(result, null);
});

test("客演表記だけに候補の作者名がある動画は採用しない", () => {
  const result = selectYoutubeSongMatch([{
    id: { videoId: "featured-only" },
    snippet: { title: "decago - shibuya 渋谷 (ft. fernie & baz)", channelTitle: "別のチャンネル" },
  }], "渋谷", "Fernie", ["渋谷"]);
  assert.equal(result, null);
});
