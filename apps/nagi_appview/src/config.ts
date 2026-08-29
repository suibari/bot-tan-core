import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import { parseClientOrigins } from "./clientOrigins.js";
import { parseJetstreamUrls } from "./jetstreamUrls.js";
const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const url = (name: string, fallback?: string) => {
  const value = required(name, fallback);
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
};

const did = (name: string, fallback?: string) => {
  const value = required(name, fallback);
  if (!/^did:(plc|web):/.test(value)) {
    throw new Error(`${name} must be an AT Protocol DID`);
  }
  return value;
};

/**
 * 開発環境かどうか。DEV 系のフラグを増やさないための単一の判定。
 *
 * 未設定・未知の値はすべて「開発ではない」に倒す。旧 Bluesky bot スタックには
 * `=== "production"` と `!== "development"` が混在していて、未設定時にどちらへ倒れるかが
 * 場所によって違う。ここは必ず「明示的に development のときだけ true」で統一する。
 */
const isDev = process.env.NODE_ENV === "development";

// SSO チケット発行の設定。鍵の不備で AppView 全体が起動しなくなるのは割に合わないので、
// ここでは失敗を握って undefined に落とし、呼び出し側（createSsoTicket）が 501 を返す。
function passportConfig() {
  const raw = process.env.PASSPORT_PRIVATE_JWK;
  if (!raw) return undefined;
  let privateJwk: Record<string, unknown>;
  try {
    privateJwk = JSON.parse(raw);
  } catch {
    console.error("[passport] PASSPORT_PRIVATE_JWK is not valid JSON; SSO ticket issuing disabled");
    return undefined;
  }
  if (typeof privateJwk?.kid !== "string") {
    console.error("[passport] PASSPORT_PRIVATE_JWK has no kid; SSO ticket issuing disabled");
    return undefined;
  }
  // 遷移先の許可リスト。ここに無い origin へは発行しない。
  const audiences = (process.env.PASSPORT_AUDIENCES ?? "https://room.bot-tan.com")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!audiences.length) {
    console.error("[passport] PASSPORT_AUDIENCES is empty; SSO ticket issuing disabled");
    return undefined;
  }
  return {
    privateJwk,
    issuer: process.env.PASSPORT_ISSUER ?? "https://nagi-api.suibari.com",
    audiences,
    // URL に載る以上、長くしない。
    ttlSeconds: integer("PASSPORT_TTL_SECONDS", 60, 10, 300),
  };
}

export const config = {
  port: integer("NAGI_PORT", 3002, 1, 65_535),
  // 待ち受けホスト。未設定なら Node 既定（unspecified）。WSL2 等で localhost が ::1(IPv6) に
  // 解決され 127.0.0.1(IPv4) が拒否されるときは NAGI_HOST=127.0.0.1 等で明示する（dev 用）。
  host: process.env.NAGI_HOST,
  databaseUrl: required("DATABASE_URL", "postgres://postgres@localhost:5432/postgres"),
  // 接続先はカンマ区切りで複数指定でき、失敗が続いたら次の候補へローテートする。
  //
  // bot とは別の変数で持つ。全プロセスが同じ .env を読むため URL_JETSTREAM を共有すると
  // AppView も自作 proxy を向いてしまうが、proxy はクライアントの cursor を上流へ渡さない
  // （自身の最終転送位置からしか巻き戻せない）ので、AppView が長く落ちたときの取りこぼしを
  // カーソルで埋め戻せなくなる。カーソル再開が生命線の AppView は公式 Jetstream を直接見る。
  // 購読は Nagi の数コレクションだけなので、直接繋いでも帯域は小さい。
  jetstreamUrls: parseJetstreamUrls(
    required(
      "URL_JETSTREAM_APPVIEW",
      [
        "wss://jetstream1.us-east.bsky.network/subscribe",
        "wss://jetstream2.us-east.bsky.network/subscribe",
        "wss://jetstream1.us-west.bsky.network/subscribe",
        "wss://jetstream2.us-west.bsky.network/subscribe",
      ].join(","),
    ),
    "URL_JETSTREAM_APPVIEW",
  ),
  jetstreamReplaySeconds: integer(
    "NAGI_JETSTREAM_REPLAY_SECONDS",
    60,
    0,
    3_600,
  ),
  reconcileIntervalMinutes: integer(
    "NAGI_RECONCILE_INTERVAL_MINUTES",
    360,
    15,
    10_080,
  ),
  // Jetstream が繋がらない間だけ使う短い巡回間隔。firehose の代わりに PDS を直接舐めて
  // 追従するため、復旧までの取りこぼしが reconcile 一周分で収まるようにする。
  reconcileDegradedIntervalMinutes: integer(
    "NAGI_RECONCILE_DEGRADED_INTERVAL_MINUTES",
    10,
    1,
    360,
  ),
  reconcileConcurrency: integer("NAGI_RECONCILE_CONCURRENCY", 2, 1, 8),
  appviewDid: did("NAGI_APPVIEW_DID", "did:web:nagi-api.suibari.com"),
  appviewServiceId: "nagi_appview",
  botDid: did("NAGI_BOT_DID"),
  // 開発補助をまとめて有効にする唯一のスイッチ。フラグを増やさないため、
  // 個別の DEV 系環境変数はできるだけこれに寄せる。
  dev: isDev,
  // 開発専用: local appview へ直接当てる際、service-auth JWT の代わりに
  // x-viewer-did ヘッダーを viewerDid として信用する。
  //
  // これは JWT 検証を丸ごと迂回する「読み取り側の認証バイパス」で、他の開発フラグとは
  // 危険度が違う。NODE_ENV=development との AND にしてあるので、本番の .env に
  // APPVIEW_DEV_TRUST_VIEWER=true が紛れ込んでも単独では有効にならない。
  devTrustViewer: isDev && process.env.APPVIEW_DEV_TRUST_VIEWER === "true",
  // 内部エンドポイント(/internal)専用のループバックポート。nagi_bot_server と同じく
  // 127.0.0.1 に束縛して OS にアクセス制御させるので、共有シークレットは持たない。
  internalPort: integer("NAGI_APPVIEW_INTERNAL_PORT", 3004, 1, 65_535),
  clientOrigins: parseClientOrigins(
    required("NAGI_CLIENT_ORIGIN", "http://localhost:5173"),
  ),
  // カスタム絵文字一覧は60件単位で画像を取得し、スクロールで続けて読み込む。
  // API全体の小さいIPバケットを流用せず、公開画像配信として独立して調整可能にする。
  emojiAssetRateLimit: integer("NAGI_EMOJI_ASSET_RATE_LIMIT", 1_200, 1, 100_000),
  affirmationThreshold: integer(
    "NAGI_AFFIRMATION_THRESHOLD",
    Number(process.env.NAGI_TREND_THRESHOLD ?? 86),
    0,
    100,
  ),
  ollamaUrl: url("OLLAMA_BASE_URL", "http://localhost:11434"),
  // モデル名はレジストリ（shared-configs の aiRoutes.ts）が唯一の出どころ。
  // 差し替えは AI_ROUTE_OLLAMA_TRANSLATION / OLLAMA_TRANSLATION_MODEL などで行う。
  translationModel: aiModel("OLLAMA_TRANSLATION"),
  // botたん本人の投稿だけに使うペルソナ翻訳ルート。一般翻訳と同じ
  // 共通Gemma 4 runnerを共有し、生成モデル間のVRAM入れ替えを発生させない。
  botTranslationModel: aiModel("OLLAMA_BOT_TRANSLATION"),
  translationConcurrency: integer("TRANSLATION_CONCURRENCY", 2, 1, 8),
  translationMissLimitPerMinute: integer(
    "TRANSLATION_MISS_LIMIT_PER_MINUTE",
    60,
    1,
    1_000,
  ),
  userNewsDailyLimit: integer("NAGI_USER_NEWS_DAILY_LIMIT", 3, 1, 100),
  // SSO チケット（@suibari/nagi-passport）の発行設定。
  //
  // 鍵が未設定なら発行機能ごと無効にする（VAPID と同じ扱い）。無効時は
  // createSsoTicket が 501 を返し、クライアントは ?did= ヒント経路にフォールバックする。
  // 鍵の JSON が壊れている場合も、AppView 全体を落とさず発行だけ止める。
  passport: passportConfig(),

  // Web Push（VAPID）。未設定ならプッシュ配信は無効化し、通知の挿入だけ従来どおり続ける。
  vapid:
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? {
          publicKey: process.env.VAPID_PUBLIC_KEY,
          privateKey: process.env.VAPID_PRIVATE_KEY,
          subject: process.env.VAPID_SUBJECT ?? "mailto:admin@nagi.suibari.com",
        }
      : undefined,
};

export const appviewAudience = `${config.appviewDid}#${config.appviewServiceId}`;
