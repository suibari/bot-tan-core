import type {
  ScheduledPostExternal,
  ScheduledPostImage,
  ScheduledPostNagiLink,
  ScheduledPostPublishRequest,
} from "@bsky-affirmative-bot/clients";
import { nagiNewsPageUrl, type ScheduledPostNews } from "@bsky-affirmative-bot/database";
import { buildGoodNightPostTexts, buildWhimsicalPostTexts } from "./scheduledPostContent.js";

type GeneratedTexts = { textJa: string; textEn: string };

/**
 * Bluesky の定期ポストは1つの言語で書き、もう一方の言語は Nagi の同じ投稿へのリンクにする。
 * Nagi の投稿は日本語の原文に英訳を添えてあり、閲覧者の言語で表示される。
 */
export const NAGI_LINK_FROM_JA: ScheduledPostNagiLink = { label: "🌐 English", seeMoreLabel: "もっと見る" };
export const NAGI_LINK_FROM_EN: ScheduledPostNagiLink = { label: "🌐 日本語", seeMoreLabel: "See more" };

/** 生成結果から、各投稿で許可する送信要素だけを明示的に組み立てる。 */
export function buildMorningPostRequest(generated: GeneratedTexts): ScheduledPostPublishRequest {
  const hashtags = "#全肯定質問コーナー #BottansQuestion";
  return {
    kind: "morning",
    contentByTarget: {
      bsky: { text: generated.textJa, footer: hashtags, nagiLink: NAGI_LINK_FROM_JA },
      nagi: {
        text: `${generated.textJa}\n\n${hashtags}`,
        langs: ["ja"],
        translations: [{ lang: "en", text: `${generated.textEn}\n\n${hashtags}` }],
      },
    },
  };
}

/**
 * Bluesky のリンクカード。行き先は Nagi のニュースページ（みんなのコメントも読める）で、
 * サムネイルは記事の画像。英語の回は英訳見出しがあればそれを使う。
 */
export function buildNagiNewsExternal(
  news: ScheduledPostNews,
  isJapanesePost: boolean,
): ScheduledPostExternal {
  const title = isJapanesePost ? news.titleJa : news.titleEn ?? news.titleJa;
  return {
    uri: nagiNewsPageUrl(news.rkey),
    title,
    description: [news.sourceName, isJapanesePost ? "Nagi のニュース" : "News on Nagi"]
      .filter(Boolean)
      .join(" · "),
    ...(news.imageUrl ? { thumbUrl: news.imageUrl } : {}),
  };
}

export function buildWhimsicalPostRequest(params: {
  generated: GeneratedTexts;
  song: { title: string; artist: string; url: string } | null;
  isJapanesePost: boolean;
  news?: ScheduledPostNews | null;
}): ScheduledPostPublishRequest {
  const { generated, song, isJapanesePost, news } = params;
  const moodSong = song ? `MyMoodSong:\n${song.title} - ${song.artist}\n${song.url}` : "";
  const texts = buildWhimsicalPostTexts({
    textJa: generated.textJa,
    textEn: generated.textEn,
    moodSong,
  });
  return {
    kind: "whimsical",
    contentByTarget: {
      bsky: {
        text: isJapanesePost ? generated.textJa : generated.textEn,
        ...(moodSong ? { footer: moodSong } : {}),
        nagiLink: isJapanesePost ? NAGI_LINK_FROM_JA : NAGI_LINK_FROM_EN,
        ...(news ? { external: buildNagiNewsExternal(news, isJapanesePost) } : {}),
      },
      nagi: {
        text: texts.nagiJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: texts.nagiEn }],
        ...(news ? { quote: { uri: news.uri, cid: news.cid } } : {}),
      },
    },
  };
}

export function buildGoodNightPostRequest(params: {
  generated: GeneratedTexts;
  nightVideo?: { uri: string; cid: string } | null;
  image?: ScheduledPostImage | null;
}): ScheduledPostPublishRequest {
  const { generated, nightVideo, image } = params;
  const texts = buildGoodNightPostTexts({
    textJa: generated.textJa,
    textEn: generated.textEn,
  });
  return {
    kind: "good-night",
    contentByTarget: {
      // Blueskyサーバへ渡す画像はLeaflet日記用。Bluesky投稿自体には添付しない。
      bsky: {
        text: generated.textJa,
        nagiLink: NAGI_LINK_FROM_JA,
        ...(image ? { image } : {}),
        ...(nightVideo
          ? { nightVideo: { uri: nightVideo.uri, cid: nightVideo.cid } }
          : {}),
      },
      nagi: {
        text: texts.nagiJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: texts.nagiEn }],
        ...(image ? { image } : {}),
        // Nagi は動画ポストの blob をそのまま参照して載せる（上げ直さない）。
        ...(nightVideo
          ? { nightVideo: { uri: nightVideo.uri, cid: nightVideo.cid } }
          : {}),
      },
    },
  };
}

/**
 * ひとりごと。**Nagi 専用なので bsky キーを持たせない。** ハッシュタグも曲も付けない。
 */
export function buildMonologuePostRequest(params: {
  generated: GeneratedTexts;
  image?: ScheduledPostImage | null;
}): ScheduledPostPublishRequest {
  const { generated, image } = params;
  return {
    kind: "monologue",
    contentByTarget: {
      nagi: {
        text: generated.textJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: generated.textEn }],
        ...(image ? { image } : {}),
      },
    },
  };
}
