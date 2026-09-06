import axios from "axios";

export type ScheduledPostKind = "morning" | "whimsical" | "good-night";
export type ScheduledPostNetwork = "bsky" | "nagi";

export interface ScheduledPostSource {
  network: ScheduledPostNetwork;
  uri: string;
  cid: string;
}

/**
 * 生成済みの対訳。Gemini が textJa と textEn を同時に作っている定時投稿で、
 * 英語版を機械翻訳させず本人の文章のまま出すために翻訳キャッシュへ投入する。
 */
export interface ScheduledPostTranslation {
  lang: string;
  text: string;
}

export interface ScheduledPostRequest {
  kind: ScheduledPostKind;
  text: string;
  langs?: string[];
  translations?: ScheduledPostTranslation[];
  image?: ScheduledPostImage;
  sourcePost?: ScheduledPostSource;
}

/**
 * 投稿に添える画像。**ターゲットごとに付けるかどうかを変えられる**のが要点で、
 * botたんの1日1枚の絵は Nagi と Leaflet には出すが Bluesky には出さない、という
 * 使い分けをここで表現している。
 *
 * データは base64。1日1回・1MB弱なので JSON に載せて構わない。
 */
export interface ScheduledPostImage {
  /** base64。mimeType のとおりに符号化済み。 */
  dataBase64: string;
  mimeType: string;
  width: number;
  height: number;
  alt: string;
}

export interface ScheduledPostContent {
  text: string;
  langs?: string[];
  translations?: ScheduledPostTranslation[];
  image?: ScheduledPostImage;
}

export interface ScheduledPostPublishRequest {
  kind: ScheduledPostKind;
  contentByTarget: Record<ScheduledPostNetwork, ScheduledPostContent>;
  sourcePost?: ScheduledPostSource;
}

export interface ScheduledPostResult {
  uri: string;
  cid: string;
}

const BSKY_BOT_SERVER_URL = process.env.BSKY_BOT_SERVER_URL || "http://localhost:3001";
const NAGI_BOT_SERVER_URL = process.env.NAGI_BOT_SERVER_URL || "http://localhost:3003";
const MAX_TRANSPORT_ATTEMPTS = 3;

function configuredTargets(): ScheduledPostNetwork[] {
  const targets = (process.env.SCHEDULED_POST_TARGETS || "bsky")
    .split(",")
    .map((target) => target.trim())
    .filter((target): target is ScheduledPostNetwork => target === "bsky" || target === "nagi");

  const uniqueTargets = [...new Set(targets)];
  return uniqueTargets.length > 0 ? uniqueTargets : ["bsky"];
}

export class ScheduledPostService {
  static async publish(request: ScheduledPostPublishRequest) {
    const targets = configuredTargets();
    const tasks = targets.map(async (target) => {
      const baseUrl = target === "bsky" ? BSKY_BOT_SERVER_URL : NAGI_BOT_SERVER_URL;
      const wireRequest: ScheduledPostRequest = {
        kind: request.kind,
        ...request.contentByTarget[target],
        sourcePost: request.sourcePost,
      };
      for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
        try {
          const response = await axios.post<ScheduledPostResult>(`${baseUrl}/posts/scheduled`, wireRequest);
          return { target, ...response.data };
        } catch (error) {
          const receivedResponse = axios.isAxiosError(error) && error.response !== undefined;
          if (receivedResponse || attempt === MAX_TRANSPORT_ATTEMPTS) throw error;
          console.warn(`[WARN][SCHEDULED_POST] ${target} transport retry ${attempt}`);
        }
      }
      throw new Error(`${target} delivery exhausted`);
    });

    const settled = await Promise.allSettled(tasks);
    const results: Partial<Record<ScheduledPostNetwork, ScheduledPostResult>> = {};

    settled.forEach((result, index) => {
      const target = targets[index];
      if (result.status === "fulfilled") {
        results[target] = { uri: result.value.uri, cid: result.value.cid };
      } else {
        console.error(`[ERROR][SCHEDULED_POST] ${target} delivery failed:`, result.reason);
      }
    });

    return results;
  }
}
