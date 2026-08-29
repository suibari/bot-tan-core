import { BlobRef, AppBskyActorDefs, AppBskyFeedPost } from "@atproto/api";
import { Content, Type } from "@google/genai";

type ProfileView = AppBskyActorDefs.ProfileView;
type ProfileViewDetailed = AppBskyActorDefs.ProfileViewDetailed;
type PostRecord = AppBskyFeedPost.Record;

interface LanguageInfo {
  code: string;
  name: LanguageName;
}

export const languageData: LanguageInfo[] = [
  { code: "ar", name: "Arabic" },
  { code: "bn", name: "Bengali" },
  { code: "bg", name: "Bulgarian" },
  { code: "zh", name: "Chinese" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "et", name: "Estonian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "Korean" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sr", name: "Serbian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "es", name: "Spanish" },
  { code: "sw", name: "Swahili" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
];

export type LanguageName =
  | "Arabic"
  | "Bengali"
  | "Bulgarian"
  | "Chinese"
  | "Croatian"
  | "Czech"
  | "Danish"
  | "Dutch"
  | "English"
  | "Estonian"
  | "Finnish"
  | "French"
  | "German"
  | "Greek"
  | "Hebrew"
  | "Hindi"
  | "Hungarian"
  | "Indonesian"
  | "Italian"
  | "日本語"
  | "Korean"
  | "Latvian"
  | "Lithuanian"
  | "Norwegian"
  | "Polish"
  | "Portuguese"
  | "Romanian"
  | "Russian"
  | "Serbian"
  | "Slovak"
  | "Slovenian"
  | "Spanish"
  | "Swahili"
  | "Swedish"
  | "Thai"
  | "Turkish"
  | "Ukrainian"
  | "Vietnamese";

export const localeToTimezone: Record<string, string> = {
  "ar": "Asia/Riyadh",
  "bn": "Asia/Dhaka",
  "bg": "Europe/Sofia",
  "zh": "Asia/Shanghai",   // 中国語は単一扱い
  "hr": "Europe/Zagreb",
  "cs": "Europe/Prague",
  "da": "Europe/Copenhagen",
  "nl": "Europe/Amsterdam",
  "en": "America/New_York", // 英語は単一扱い
  "et": "Europe/Tallinn",
  "fi": "Europe/Helsinki",
  "fr": "Europe/Paris",
  "de": "Europe/Berlin",
  "el": "Europe/Athens",
  "he": "Asia/Jerusalem",
  "hi": "Asia/Kolkata",
  "hu": "Europe/Budapest",
  "id": "Asia/Jakarta",
  "it": "Europe/Rome",
  "ja": "Asia/Tokyo",
  "ko": "Asia/Seoul",
  "lv": "Europe/Riga",
  "lt": "Europe/Vilnius",
  "no": "Europe/Oslo",
  "pl": "Europe/Warsaw",
  "pt": "Europe/Lisbon",   // ポルトガル語は単一扱い
  "ro": "Europe/Bucharest",
  "ru": "Europe/Moscow",
  "sr": "Europe/Belgrade",
  "sk": "Europe/Bratislava",
  "sl": "Europe/Ljubljana",
  "es": "Europe/Madrid",
  "sw": "Africa/Nairobi",
  "sv": "Europe/Stockholm",
  "th": "Asia/Bangkok",
  "tr": "Europe/Istanbul",
  "uk": "Europe/Kyiv",
  "vi": "Asia/Ho_Chi_Minh",
};

export type LangMap = {
  [langCode: string]: {
    name: LanguageName;
  };
};

export type WhatDayMap = {
  [month: string]: {
    [date: string]: string[];
  };
};

/**
 * botたんがいまどのSNSにいるか。Nagi がホームで、Bluesky は出張先。
 *
 * 定期ポストは両ネットワークへ同一本文で配信されるので、そこでは設定しない（片方で嘘になる）。
 */
export type BotSurface = "nagi" | "bluesky";

export interface BotContext {
  datetime: string;
  weather: string;
  botActivity: string;
  botActivityEn: string;
  botEnergy: number;
  /** 未設定なら場所に触れない（＝サーフェス中立）。 */
  surface?: BotSurface;
  /** 会話の整合性確認に使う、古い順の直近行動。 */
  recentActivities?: {
    at: string;
    activity: string;
    activityEn: string;
  }[];
}

export type UserInfoGemini = {
  follower: ProfileView;
  langStr?: LanguageName;
  posts?: string[];
  lastYearPosts?: string[];
  likedByFollower?: string[];
  history?: Content[];
  image?: ImageRef[];
  anniversary?: Holiday[];
  followersFriend?: {
    profile: ProfileView;
    post?: string;
  }[];
  embed?: Embed;
  urlContextEnabled?: boolean;
  topWords?: string[];
  postOnMonth?: string[][];
  isSubscriber?: boolean;
  botContext?: BotContext;
  /**
   * 本人が「こう呼んで」と申告した名前（nagi.preferred_names）。
   * 未設定なら displayName を使う。プロンプト側の拘束は NAME_RULES_* が受け持つ。
   * 解決は呼び出し元（bsky_bot_server / nagi_bot_server）で行う。
   */
  preferredName?: string | null;
};

export interface Embed {
  profile_embed?: ProfileViewDetailed;
  text_embed?: string;
  uri_embed?: string;
  title_embed?: string;
  description_embed?: string;
  links_embed?: {
    uri: string;
    title?: string;
    description?: string;
  }[];
  image_embed?: ImageRef[];
}

export type ImageOrigin =
  | "direct"
  | "quote"
  | "link-preview"
  | "video-thumbnail";

export interface ImageRef {
  image_url: string;
  mimeType: string;
  /** Gemini に作者を誤認させないための実行時メタデータ。AT Protocol には保存しない。 */
  origin?: ImageOrigin;
}

export type GeminiResponseResult = string | {
  text: string;
  imageBlob?: BlobRef;
  embedTo?: {
    uri: string;
    cid: string;
  }
};

export type GeminiScore = {
  comment: string;
  score: number;
}

export interface ThreadInfo {
  parent?: PostRecord
  grandParent?: PostRecord
  root?: PostRecord
}

export type Holiday = {
  id: string;
  names: { ja: string; en: string };
  rule:
  | { type: "fixed"; month: number; day: number }
  | { type: "nth-weekday"; month: number; week: number; weekday: number } // weekday: 0=Sun..6=Sat
  | { type: "easter"; calendar: "western" | "orthodox" };
  regions?: string[];
}

export type NegaposiApiResponse = {
  wakati: string[][];
  average_sentiments: number[];
  nouns: string[][];
  nouns_counts: {
    noun: string;
    count: number;
    sentiment_sum: number;
  }[];
};
export interface DailyReport {
  followers: number;
  likes: number;
  reply: number;
  affirmationCount: number;
  uniqueAffirmationUserCount: number; // 当日のアファメーション人数（ユニーク）
  conversation: number;
  fortune: number;
  cheer: number;
  analysis: number;
  dj: number;
  anniversary: number;
  answer: number;
  recap: number;
  lang: Map<LanguageName, number>;
  topPost: string;
  botComment: string;
  /** おすすめ投稿がどちらのネットワークのものか。 */
  topPostNetwork: 'bsky' | 'nagi';
  bskyrate: number;
  /** クラウドLLM（Gemini）の呼び出し数。Geminiの日次上限判定に使うので混ぜないこと。 */
  rpd: number;
  rpdError: number;
  /** ローカルLLM（Ollama）の呼び出し数。課金枠を消費しないので上限判定には使わない。 */
  localRpd: number;
  localRpdError: number;
  lastInitializedDate: string;
}

export interface Stats {
  followers: number;
  likes: number;
  reply: number;
  affirmationCount: number;
  conversation: number;
  fortune: number;
  cheer: number;
  analysis: number;
  dj: number;
  anniversary: number;
  answer: number;
  recap: number;
  lang: Map<LanguageName, number>;
  bskyrate: number;
  /** クラウドLLM（Gemini）の呼び出し数。Geminiの日次上限判定に使うので混ぜないこと。 */
  rpd: number;
  rpdError: number;
  /** ローカルLLM（Ollama）の呼び出し数。課金枠を消費しないので上限判定には使わない。 */
  localRpd: number;
  localRpdError: number;
}
export type Status = 'WakeUp' | 'Study' | 'FreeTime' | 'Relax' | 'Sleep';
