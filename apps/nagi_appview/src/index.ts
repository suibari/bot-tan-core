import express from "express";
import cors from "cors";
import {
  initializeDatabases,
  reportHeartbeat,
} from "@bsky-affirmative-bot/database";
import { config } from "./config.js";
import { logAiRouteTable } from "@bsky-affirmative-bot/shared-configs";
import { xrpc } from "./routes/xrpc.js";
import { internal } from "./routes/internal.js";
import { wellKnownDid } from "./routes/wellKnownDid.js";
import { passportJwks } from "./routes/passportJwks.js";
import { getBlob } from "./routes/blob.js";
import { getStandardSitePublication } from "./routes/standardSitePublication.js";
import { getVideo } from "./routes/video.js";
import { getEmojiAsset } from "./routes/emojiAsset.js";
import { emojiAssetNoStoreHeaders } from "./util/emojiAssetHeaders.js";
import {
  createRateLimit,
  isEmojiReadRequest,
  viewerKey,
} from "./middleware/rateLimit.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { startJetstream } from "./ingest/jetstream.js";
import { startBlueskyPush } from "./services/blueskyPush.js";
import {
  startBotReplyIndexWorker,
  unindexedBotReplies,
} from "./ingest/botReplyIndexWorker.js";
import { startEmbeddingWorker } from "./ingest/embeddingWorker.js";
import { startModerationWorker } from "./ingest/moderationWorker.js";
import { startEmojiCaptionWorker } from "./ingest/emojiCaptionWorker.js";
import { syncUnicodeEmojis } from "./services/unicodeEmojiIndex.js";
import { startActorResolveWorker } from "./ingest/actorResolveWorker.js";
import { startWorkerLoop } from "@bsky-affirmative-bot/bot-runtime";
import { emojiGenerationTick } from "./services/emojiGeneration.js";
import {
  startReconcileWorker,
  stopReconcileWorker,
} from "./ingest/reconcileWorker.js";
const app = express();
app.set("trust proxy", 1);
// 開発環境では数えない（middleware/rateLimit.ts）。
const limit = (options: Parameters<typeof createRateLimit>[1]) =>
  createRateLimit(config.rateLimitEnabled, options);
app.use(
  cors({
    origin: config.clientOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    // x-viewer-did は開発直fetch用のカスタムヘッダー。許可名を足すだけで無害
    // （実際に信用するのは APPVIEW_DEV_TRUST_VIEWER=true のときだけ）。
    allowedHeaders: ["authorization", "content-type", "x-viewer-did"],
  }),
);
app.use(`/xrpc/com.suibari.nagi.putDraft`, express.json({ limit: "128kb" }));
app.use(express.json({ limit: "32kb" }));
app.get("/health", (_req, res) =>
  res.json({ ok: true, pushConfigured: Boolean(config.vapid) }),
);
app.get("/.well-known/did.json", wellKnownDid);
// SSO チケットの検証用公開鍵。消費アプリがサーバ側から取りに来る公開エンドポイント。
app.get("/.well-known/nagi-passport-jwks.json", passportJwks);
app.use(
  "/xrpc",
  // 絵文字の読み取りは API 全体の枠と分ける。共有すると絵文字の多い人ほど
  // 起動直後に枠を使い切り、絵文字もタイムラインも 429 で出なくなる。
  limit({
    windowMs: 60_000,
    limit: config.emojiReadRateLimit,
    keyGenerator: viewerKey,
    skip: (req) => !isEmojiReadRequest(req),
  }),
  limit({
    windowMs: 60_000,
    limit: 60,
    keyGenerator: viewerKey,
    skip: (req) => isEmojiReadRequest(req),
  }),
  xrpc,
);
app.get(
  "/api/standard-site/publication/:did",
  limit({ windowMs: 60_000, limit: 60 }),
  getStandardSitePublication,
);
app.get(
  "/api/blob/:did/:cid",
  limit({ windowMs: 60_000, limit: 120 }),
  getBlob,
);
// プレイリスト1回とセグメント数本で1再生。タイムラインのサムネイルもここを通る。
app.get(
  "/api/video/:did/:cid/:file",
  limit({ windowMs: 60_000, limit: 300 }),
  getVideo,
);
app.get(
  "/api/emoji-asset/:did/:rkey/:cid",
  (_req, res, next) => {
    // rate limiterやroute handlerが返す失敗をCDNへ残さない。成功時だけimmutableへ上書きする。
    res.set(emojiAssetNoStoreHeaders());
    next();
  },
  limit({ windowMs: 60_000, limit: config.emojiAssetRateLimit }),
  getEmojiAsset,
);
app.use(notFound);
app.use(errorHandler);
logAiRouteTable({ prefixes: ["OLLAMA_"] });
await initializeDatabases();
const stream = await startJetstream();
// Bluesky の通知の Push。VAPID が無い環境では始めない。失敗しても AppView は止めない。
const blueskyPush = await startBlueskyPush().catch((error) => {
  console.error("[ERROR][BLUESKY_PUSH] failed to start:", error);
  return undefined;
});
const appviewHeartbeat = setInterval(() => {
  // 投稿済みなのに AppView に無い botたんの返信数。監視ダッシュボードが読む。
  reportHeartbeat("nagi-appview", { ...unindexedBotReplies() }).catch((error) =>
    console.error("[ERROR][APPVIEW] Failed to report heartbeat:", error),
  );
}, 30_000);
appviewHeartbeat.unref();
reportHeartbeat("nagi-appview").catch(() => {});
// NL検索(意味検索)用の投稿本文埋め込みを非同期生成（既存投稿のバックフィルも兼ねる）。
// OLLAMA_BASE_URL 未設定なら実質 no-op。
startEmbeddingWorker();
startModerationWorker();
// 絵文字の意味検索。Unicode 絵文字の検索表を同期し、カスタム絵文字の画像を読み取る。
// 同期に失敗しても起動は止めない（Unicode 絵文字が検索に出ないだけ）。
syncUnicodeEmojis().catch((error) =>
  console.error("[ERROR][UNICODE_EMOJI] sync failed:", error),
);
const emojiCaptionWorker = startEmojiCaptionWorker();
// did→handle/pds を解決して nagiActors をインデックス（searchActors とハンドル表示に必要）。
startActorResolveWorker();
startReconcileWorker();
// botたんの返信が AppView に載り損ねていないかの監視と回収。
const botReplyIndexWorker = startBotReplyIndexWorker();
// 絵文字の生成。1 tick で1枚描く。IMAGEGEN_BASE_URL 未設定なら no-op。
const emojiGenerationWorker = startWorkerLoop({
  name: "EMOJI_GEN",
  intervalMs: 5_000,
  immediate: true,
  tick: () => emojiGenerationTick(),
});
// 本番機がうっかり NODE_ENV=development で起動していたら、ここで気づけるようにする。
// 開発補助は config.dev に集約してあるので、この1行が「何が開いているか」の一覧になる。
if (config.dev) {
  console.warn(
    `[dev] development mode is ON (trustViewerHeader=${config.devTrustViewer}, rateLimit=${config.rateLimitEnabled}). Never run production like this.`,
  );
}
const onListen = () =>
  console.log(
    `Nagi AppView listening on ${config.host ?? "(default)"}:${config.port}`,
  );
const server = config.host
  ? app.listen(config.port, config.host, onListen)
  : app.listen(config.port, onListen);

// サービス間通信(/internal)は公開アプリとは別のリスナーに載せ、127.0.0.1 だけに束縛する。
// 認可はこの束縛そのもの。公開 app 側に mount すると誰でも叩けるようになるので分ける。
const internalApp = express();
internalApp.use(express.json({ limit: "32kb" }));
internalApp.use("/internal", internal);
internalApp.use(notFound);
internalApp.use(errorHandler);
const internalServer = internalApp.listen(
  config.internalPort,
  "127.0.0.1",
  () =>
    console.log(
      `Nagi AppView internal API listening on 127.0.0.1:${config.internalPort}`,
    ),
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(appviewHeartbeat);
  clearInterval(botReplyIndexWorker);
  clearInterval(emojiGenerationWorker);
  clearInterval(emojiCaptionWorker);
  const serverClosed = new Promise<void>((resolve) =>
    server.close(() => resolve()),
  );
  const internalClosed = new Promise<void>((resolve) =>
    internalServer.close(() => resolve()),
  );
  await Promise.allSettled([
    serverClosed,
    internalClosed,
    stream.close(),
    blueskyPush?.close(),
    stopReconcileWorker(),
  ]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
