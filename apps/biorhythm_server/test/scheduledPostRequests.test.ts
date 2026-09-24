import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMorningPostRequest,
  buildWhimsicalPostRequest,
  buildGoodNightPostRequest,
} from "../src/scheduledPostRequests.js";

// AI・DB・外部APIは呼ばない。生成済みの固定値を使い、送信データ全体の契約を検証する。
// 余分なメタデータも入れ、オブジェクトの展開による漏出を検知する。
const generated = {
  textJa: "日本語の生成本文",
  textEn: "Generated English text",
  theme: "内部用テーマ",
  selectedNewsUrl: "https://news.example/article",
  selectedNewsArticleId: "internal-news-id",
  selectedMemoryDocumentIds: [123],
  selectedGiftIndex: 2,
  usedYoutubeShort: true,
};
const song = {
  title: "again",
  artist: "YUI",
  url: "https://www.youtube.com/watch?v=stub",
  lastFmUrl: "https://www.last.fm/music/YUI/_/again",
  thumbnailUrl: "https://image.example/jacket.jpg",
  comment: "曲の紹介文は定期ポストへ付けない",
  songKey: "internal-song-key",
  documentId: 456,
};
const image = {
  dataBase64: "c3R1Yg==", mimeType: "image/png", width: 1, height: 1, alt: "画像スタブ",
};

test("おはよう：日英の質問本文と固定タグだけ。曲・ニュース・画像・引用元を付けない", () => {
  assert.deepEqual(buildMorningPostRequest(generated), {
    kind: "morning",
    contentByTarget: {
      bsky: { text: "日本語の生成本文\n\nGenerated English text\n\n#全肯定質問コーナー #BottansQuestion" },
      nagi: {
        text: "日本語の生成本文\n\n#全肯定質問コーナー #BottansQuestion",
        langs: ["ja"],
        translations: [{ lang: "en", text: "Generated English text\n\n#全肯定質問コーナー #BottansQuestion" }],
      },
    },
  });
});

for (const isJapanesePost of [true, false]) {
  test(`気まぐれ：Bluesky ${isJapanesePost ? "日本語" : "英語"}、Nagi日英、ニュースはNagiのみ、曲はYouTubeのみ`, () => {
    assert.deepEqual(buildWhimsicalPostRequest({ generated, song, isJapanesePost }), {
      kind: "whimsical",
      contentByTarget: {
        bsky: { text: isJapanesePost
          ? "日本語の生成本文\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub"
          : "Generated English text\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" },
        nagi: {
          text: "日本語の生成本文\n\nhttps://news.example/article\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
          langs: ["ja"],
          translations: [{ lang: "en", text: "Generated English text\n\nhttps://news.example/article\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" }],
        },
      },
    });
  });
}

for (const withNews of [true, false]) {
  test(`気まぐれ：曲なし・ニュース${withNews ? "あり" : "なし"}で余分な要素や空の曲欄を付けない`, () => {
    assert.deepEqual(buildWhimsicalPostRequest({
      generated: { ...generated, selectedNewsUrl: withNews ? generated.selectedNewsUrl : undefined },
      song: null,
      isJapanesePost: true,
    }), {
      kind: "whimsical",
      contentByTarget: {
        bsky: { text: "日本語の生成本文" },
        nagi: {
          text: withNews ? "日本語の生成本文\n\nhttps://news.example/article" : "日本語の生成本文",
          langs: ["ja"],
          translations: [{ lang: "en", text: withNews ? "Generated English text\n\nhttps://news.example/article" : "Generated English text" }],
        },
      },
    });
  });
}

test("気まぐれ：ニュースなし・曲ありでもニュース枠や画像を追加しない", () => {
  assert.deepEqual(buildWhimsicalPostRequest({
    generated: { ...generated, selectedNewsUrl: undefined }, song, isJapanesePost: true,
  }), {
    kind: "whimsical",
    contentByTarget: {
      bsky: { text: "日本語の生成本文\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" },
      nagi: {
        text: "日本語の生成本文\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
        langs: ["ja"],
        translations: [{ lang: "en", text: "Generated English text\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" }],
      },
    },
  });
});

for (const network of ["bsky", "nagi"] as const) {
  for (const withImage of [true, false]) {
    test(`おやすみ：${network}選出・画像${withImage ? "あり" : "なし"}、本文・引用元・任意の絵だけ`, () => {
      const sourcePost = {
        network,
        uri: network === "nagi"
          ? "at://did:plc:example/com.suibari.nagi.post/stub"
          : "at://did:plc:example/app.bsky.feed.post/stub",
        cid: "stub-cid",
      };
      const result = buildGoodNightPostRequest({ generated, sourcePost, image: withImage ? image : null });
      assert.deepEqual(result, {
        kind: "good-night",
        contentByTarget: {
          bsky: {
            text: network === "nagi"
              ? "日本語の生成本文\n\nGenerated English text\n\nhttps://nagi.suibari.com/thread/did%3Aplc%3Aexample/stub"
              : "日本語の生成本文\n\nGenerated English text",
            ...(withImage ? { image } : {}),
          },
          nagi: {
            text: network === "nagi"
              ? "日本語の生成本文\n\nhttps://nagi.suibari.com/thread/did%3Aplc%3Aexample/stub"
              : "日本語の生成本文",
            langs: ["ja"],
            translations: [{ lang: "en", text: "Generated English text" }],
            ...(withImage ? { image } : {}),
          },
        },
        sourcePost,
      });
    });
  }
}
