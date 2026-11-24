import axios from "axios";

/**
 * `monologue`（ひとりごと）は **Nagi 専用**。contentByTarget に bsky を持たせず、
 * Bluesky サーバの /posts/scheduled も受け付けない（二重に塞いでいる）。
 */
export type ScheduledPostKind = "morning" | "whimsical" | "good-night" | "monologue";
export type ScheduledPostNetwork = "bsky" | "nagi";

/**
 * おやすみポストで紹介する夜の動画（bot-tan-youtuber が 18:00 に Bluesky へ投稿したもの）。
 * Bluesky サーバは動画ポストを RP し、Nagi サーバは同じ blob を参照して投稿に埋め込む。
 */
export interface ScheduledPostNightVideo {
  uri: string;
  cid: string;
}

/**
 * Nagi の投稿に引用として埋め込むレコード（気まぐれポストで紹介する Nagi のニュース）。
 * Bluesky では引用できない（Nagi のレコードなので）ため、Bluesky には external を使う。
 */
export interface ScheduledPostQuote {
  uri: string;
  cid: string;
}

/**
 * Bluesky のリンクカード。thumbUrl は Bluesky サーバが取得して blob にする。
 * 取れなければサムネイル無しのカードで出す（本文の方が本体）。
 */
export interface ScheduledPostExternal {
  uri: string;
  title: string;
  description: string;
  thumbUrl?: string;
}

/**
 * 生成済みの対訳。Gemini が textJa と textEn を同時に作っている定時投稿で、
 * 英語版を機械翻訳させず本人の文章のまま出すために翻訳キャッシュへ投入する。
 */
export interface ScheduledPostTranslation {
  lang: string;
  text: string;
}

/**
 * Bluesky の本文の後ろに置く、同じ内容の Nagi 投稿へのリンク（Bluesky だけが使う）。
 * label は別の言語で読みたい人への導線（「🌐 English」など）、seeMoreLabel は
 * 本文が 300 字に収まらず冒頭で切ったときに付ける「もっと見る」の文言。
 * Nagi への投稿が失敗した回はリンクを付けずに投稿する。
 */
export interface ScheduledPostNagiLink {
  label: string;
  seeMoreLabel: string;
}

export interface ScheduledPostRequest {
  kind: ScheduledPostKind;
  text: string;
  /** 本文を切っても残す末尾（ハッシュタグ・曲など）。Bluesky だけが使う。 */
  footer?: string;
  nagiLink?: ScheduledPostNagiLink;
  /** nagiLink のリンク先。ScheduledPostService が Nagi へ先に投稿して埋める。 */
  nagiPost?: { uri: string; cid: string };
  langs?: string[];
  translations?: ScheduledPostTranslation[];
  image?: ScheduledPostImage;
  nightVideo?: ScheduledPostNightVideo;
  quote?: ScheduledPostQuote;
  external?: ScheduledPostExternal;
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
  /** Bluesky は RP、Nagi は動画ポストの blob を埋め込む（絵があれば #gallery で併用）。 */
  nightVideo?: ScheduledPostNightVideo;
  /** Nagi だけが使う。 */
  quote?: ScheduledPostQuote;
  /** Bluesky だけが使う。 */
  external?: ScheduledPostExternal;
  /** Bluesky だけが使う。 */
  footer?: string;
  /** Bluesky だけが使う。あれば Nagi へ先に投稿し、その URL を Bluesky に載せる。 */
  nagiLink?: ScheduledPostNagiLink;
}

export interface ScheduledPostPublishRequest {
  kind: ScheduledPostKind;
  /** 載せない先はキーごと持たない。設定された配信先でも、ここに無ければ送らない。 */
  contentByTarget: Partial<Record<ScheduledPostNetwork, ScheduledPostContent>>;
}

export interface ScheduledPostResult {
  uri: string;
  cid: string;
  /** nightVideo を受け取ったときのリポスト。失敗したら無い。 */
  nightVideoRepost?: { uri: string; cid: string };
}

const BSKY_BOT_SERVER_URL = process.env.BSKY_BOT_SERVER_URL || "http://localhost:3001";
const NAGI_BOT_SERVER_URL = process.env.NAGI_BOT_SERVER_URL || "http://localhost:3003";
const MAX_TRANSPORT_ATTEMPTS = 3;

/**
 * 950 KB の画像を base64 化した予約投稿を受け取れる上限。
 *
 * Express の既定値は 100 KB なので、画像生成に成功したおやすみ投稿だけが
 * ハンドラー到達前に 413 になる。画像本体は最大約 1.27 MB になるため、本文・対訳・
 * alt の余裕を含めて 1.5 MB とする。サービス間エンドポイントは loopback 限定。
 */
export const SCHEDULED_POST_BODY_LIMIT_BYTES = 1_500_000;

export function scheduledPostErrorDetails(error: unknown) {
  if (!axios.isAxiosError(error)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  const responseData = error.response?.data;
  return {
    message: error.message,
    code: error.code,
    status: error.response?.status,
    statusText: error.response?.statusText,
    response:
      typeof responseData === "string"
        ? responseData.slice(0, 200)
        : responseData && typeof responseData === "object"
          ? responseData
          : undefined,
  };
}

function configuredTargets(): ScheduledPostNetwork[] {
  const targets = (process.env.SCHEDULED_POST_TARGETS || "bsky")
    .split(",")
    .map((target) => target.trim())
    .filter((target): target is ScheduledPostNetwork => target === "bsky" || target === "nagi");

  const uniqueTargets = [...new Set(targets)];
  return uniqueTargets.length > 0 ? uniqueTargets : ["bsky"];
}

async function deliver(
  target: ScheduledPostNetwork,
  wireRequest: ScheduledPostRequest,
): Promise<ScheduledPostResult> {
  const baseUrl = target === "bsky" ? BSKY_BOT_SERVER_URL : NAGI_BOT_SERVER_URL;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post<ScheduledPostResult>(`${baseUrl}/posts/scheduled`, wireRequest);
      return response.data;
    } catch (error) {
      const receivedResponse = axios.isAxiosError(error) && error.response !== undefined;
      if (receivedResponse || attempt === MAX_TRANSPORT_ATTEMPTS) throw error;
      console.warn(`[WARN][SCHEDULED_POST] ${target} transport retry ${attempt}`);
    }
  }
  throw new Error(`${target} delivery exhausted`);
}

export class ScheduledPostService {
  static async publish(request: ScheduledPostPublishRequest) {
    const targets = configuredTargets().filter((target) => request.contentByTarget[target]);
    const wire = (target: ScheduledPostNetwork): ScheduledPostRequest => ({
      kind: request.kind,
      ...request.contentByTarget[target]!,
    });
    // Bluesky に Nagi の URL を載せる回は、Nagi の投稿を待ってから Bluesky へ出す。
    // それ以外は従来どおり並列に出し、片方の失敗がもう片方を止めないようにする。
    const nagiFirst = targets.includes("nagi") && Boolean(request.contentByTarget.bsky?.nagiLink);
    const nagiTask = targets.includes("nagi") ? deliver("nagi", wire("nagi")) : undefined;
    const tasks = targets.map((target) => {
      if (target === "nagi") return nagiTask!;
      if (!nagiFirst) return deliver(target, wire(target));
      return nagiTask!.then(
        (nagi) => deliver(target, { ...wire(target), nagiPost: { uri: nagi.uri, cid: nagi.cid } }),
        () => deliver(target, wire(target)),
      );
    });

    const settled = await Promise.allSettled(tasks);
    const results: Partial<Record<ScheduledPostNetwork, ScheduledPostResult>> = {};

    settled.forEach((result, index) => {
      const target = targets[index];
      if (result.status === "fulfilled") {
        results[target] = {
          uri: result.value.uri,
          cid: result.value.cid,
          ...(result.value.nightVideoRepost ? { nightVideoRepost: result.value.nightVideoRepost } : {}),
        };
      } else {
        console.error(
          `[ERROR][SCHEDULED_POST] ${target} delivery failed:`,
          scheduledPostErrorDetails(result.reason),
        );
      }
    });

    return results;
  }
}
