import type {
  ScheduledPostImage,
  ScheduledPostPublishRequest,
  ScheduledPostSource,
} from "@bsky-affirmative-bot/clients";
import { buildGoodNightPostTexts, buildWhimsicalPostTexts } from "./scheduledPostContent.js";

type GeneratedTexts = { textJa: string; textEn: string };

/** 生成結果から、各投稿で許可する送信要素だけを明示的に組み立てる。 */
export function buildMorningPostRequest(generated: GeneratedTexts): ScheduledPostPublishRequest {
  const hashtags = "#全肯定質問コーナー #BottansQuestion";
  return {
    kind: "morning",
    contentByTarget: {
      bsky: { text: `${generated.textJa}\n\n${generated.textEn}\n\n${hashtags}` },
      nagi: {
        text: `${generated.textJa}\n\n${hashtags}`,
        langs: ["ja"],
        translations: [{ lang: "en", text: `${generated.textEn}\n\n${hashtags}` }],
      },
    },
  };
}

export function buildWhimsicalPostRequest(params: {
  generated: GeneratedTexts & { selectedNewsUrl?: string };
  song: { title: string; artist: string; url: string } | null;
  isJapanesePost: boolean;
}): ScheduledPostPublishRequest {
  const { generated, song, isJapanesePost } = params;
  const texts = buildWhimsicalPostTexts({
    textJa: generated.textJa,
    textEn: generated.textEn,
    selectedNewsUrl: generated.selectedNewsUrl,
    moodSong: song ? `MyMoodSong:\n${song.title} - ${song.artist}\n${song.url}` : "",
  });
  return {
    kind: "whimsical",
    contentByTarget: {
      bsky: { text: isJapanesePost ? texts.bskyJa : texts.bskyEn },
      nagi: {
        text: texts.nagiJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: texts.nagiEn }],
      },
    },
  };
}

export function buildGoodNightPostRequest(params: {
  generated: GeneratedTexts;
  sourcePost: ScheduledPostSource;
  image?: ScheduledPostImage | null;
}): ScheduledPostPublishRequest {
  const { generated, sourcePost, image } = params;
  const texts = buildGoodNightPostTexts({
    textJa: generated.textJa,
    textEn: generated.textEn,
    sourcePost,
  });
  return {
    kind: "good-night",
    contentByTarget: {
      // Blueskyサーバへ渡す画像はLeaflet日記用。Bluesky投稿自体には添付しない。
      bsky: { text: texts.bsky, ...(image ? { image } : {}) },
      nagi: {
        text: texts.nagiJa,
        langs: ["ja"],
        translations: [{ lang: "en", text: texts.nagiEn }],
        ...(image ? { image } : {}),
      },
    },
    sourcePost: { network: sourcePost.network, uri: sourcePost.uri, cid: sourcePost.cid },
  };
}
