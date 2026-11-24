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

test("おはよう：Blueskyは日本語の質問と固定タグ、英語はNagiへのリンク。曲・ニュース・画像・引用元を付けない", () => {
  assert.deepEqual(buildMorningPostRequest(generated), {
    kind: "morning",
    contentByTarget: {
      bsky: {
        text: "日本語の生成本文",
        footer: "#全肯定質問コーナー #BottansQuestion",
        nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" },
      },
      nagi: {
        text: "日本語の生成本文\n\n#全肯定質問コーナー #BottansQuestion",
        langs: ["ja"],
        translations: [{ lang: "en", text: "Generated English text\n\n#全肯定質問コーナー #BottansQuestion" }],
      },
    },
  });
});

const news = {
  uri: "at://did:plc:bot/com.suibari.nagi.news/3newsrkey",
  cid: "bafynewscid",
  rkey: "3newsrkey",
  articleId: "internal-article-id",
  titleJa: "日本語の見出し",
  titleEn: "English headline",
  commentJa: "内部用の紹介文",
  commentEn: "internal comment",
  sourceName: "Example News",
  imageUrl: "https://image.example/news.jpg",
};

for (const isJapanesePost of [true, false]) {
  test(`気まぐれ：Bluesky ${isJapanesePost ? "日本語" : "英語"}はNagiニュースページのカード、Nagiはニュースを引用`, () => {
    assert.deepEqual(buildWhimsicalPostRequest({ generated, song, isJapanesePost, news }), {
      kind: "whimsical",
      contentByTarget: {
        bsky: {
          text: isJapanesePost ? "日本語の生成本文" : "Generated English text",
          footer: "MyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
          nagiLink: isJapanesePost
            ? { label: "🌐 English", seeMoreLabel: "もっと見る" }
            : { label: "🌐 日本語", seeMoreLabel: "See more" },
          external: {
            uri: "https://nagi.suibari.com/news/3newsrkey",
            title: isJapanesePost ? "日本語の見出し" : "English headline",
            description: isJapanesePost ? "Example News · Nagi のニュース" : "Example News · News on Nagi",
            thumbUrl: "https://image.example/news.jpg",
          },
        },
        nagi: {
          text: "日本語の生成本文\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
          langs: ["ja"],
          translations: [{ lang: "en", text: "Generated English text\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" }],
          quote: { uri: news.uri, cid: news.cid },
        },
      },
    });
  });
}

test("気まぐれ：画像の無い記事・英訳見出しの無い記事でもカードを作る", () => {
  const { imageUrl: _image, titleEn: _titleEn, sourceName: _source, ...plain } = news;
  const request = buildWhimsicalPostRequest({ generated, song: null, isJapanesePost: false, news: plain });
  assert.deepEqual(request.contentByTarget.bsky?.external, {
    uri: "https://nagi.suibari.com/news/3newsrkey",
    title: "日本語の見出し",
    description: "News on Nagi",
  });
});

test("気まぐれ：曲なし・ニュースなしで余分な要素や空の曲欄を付けない", () => {
  assert.deepEqual(buildWhimsicalPostRequest({ generated, song: null, isJapanesePost: true, news: null }), {
    kind: "whimsical",
    contentByTarget: {
      bsky: { text: "日本語の生成本文", nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" } },
      nagi: {
        text: "日本語の生成本文",
        langs: ["ja"],
        translations: [{ lang: "en", text: "Generated English text" }],
      },
    },
  });
});

test("気まぐれ：ニュースなし・曲ありでもニュース枠や画像を追加しない", () => {
  assert.deepEqual(buildWhimsicalPostRequest({
    generated, song, isJapanesePost: true,
  }), {
    kind: "whimsical",
    contentByTarget: {
      bsky: {
        text: "日本語の生成本文",
        footer: "MyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
        nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" },
      },
      nagi: {
        text: "日本語の生成本文\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub",
        langs: ["ja"],
        translations: [{ lang: "en", text: "Generated English text\n\nMyMoodSong:\nagain - YUI\nhttps://www.youtube.com/watch?v=stub" }],
      },
    },
  });
});

for (const withVideo of [true, false]) {
  for (const withImage of [true, false]) {
    test(`おやすみ：動画${withVideo ? "あり" : "なし"}・画像${withImage ? "あり" : "なし"}、出来事・動画（BlueskyはRP先、Nagiは埋め込み元）・任意の絵だけ`, () => {
      const nightVideo = { uri: "at://did:plc:bot/app.bsky.feed.post/video", cid: "video-cid" };
      const result = buildGoodNightPostRequest({
        generated,
        nightVideo: withVideo ? nightVideo : null,
        image: withImage ? image : null,
      });
      assert.deepEqual(result, {
        kind: "good-night",
        contentByTarget: {
          bsky: {
            text: "日本語の生成本文",
            nagiLink: { label: "🌐 English", seeMoreLabel: "もっと見る" },
            ...(withImage ? { image } : {}),
            ...(withVideo
              ? { nightVideo }
              : {}),
          },
          nagi: {
            text: "日本語の生成本文",
            langs: ["ja"],
            translations: [{ lang: "en", text: "Generated English text" }],
            ...(withImage ? { image } : {}),
            ...(withVideo ? { nightVideo } : {}),
          },
        },
      });
    });
  }
}

test("おやすみ：コメントの生成なしで動画をリポスト対象にする", () => {
  const result = buildGoodNightPostRequest({
    generated,
    nightVideo: { uri: "at://did:plc:bot/app.bsky.feed.post/video", cid: "video-cid" },
  });
  assert.deepEqual(result.contentByTarget.bsky?.nightVideo, {
    uri: "at://did:plc:bot/app.bsky.feed.post/video", cid: "video-cid",
  });
});
