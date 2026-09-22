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

test("括弧内の作者別名でも一致する", () => {
  const result = selectYoutubeSongMatch([
    {
      id: { videoId: "brain-power" },
      snippet: { title: "NOMA - Brain Power", channelTitle: "NOMA" },
    },
  ], "Brain Power", "ノマ（NOMA）");
  assert.equal(result?.url, "https://www.youtube.com/watch?v=brain-power");
});
