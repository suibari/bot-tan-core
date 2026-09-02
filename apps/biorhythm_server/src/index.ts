import cors from "cors";
import express from "express";
import http from "http";
import { timingSafeEqual } from "crypto";
import dotenv from "dotenv";
import { BiorhythmManager } from "./manager.js";
import { startHealthMonitor } from "./healthMonitor.js";
import { publicApi } from "./publicApi.js";
import { logAiRouteTable } from "@bsky-affirmative-bot/shared-configs";
import {
  attachBiorhythmWebSocketServer,
  parseAllowedOrigins,
  readPositiveInteger,
} from "./websocketServer.js";
import { startBotMemoryEmbeddingWorker } from "./botMemoryEmbeddingWorker.js";
import { startBotMemoryImpressionWorker } from "./botMemoryImpressions.js";
import { startBotMemoryPronunciationWorker } from "./botMemoryPronunciations.js";
import { startBotMemoryResearchWorker } from "./botMemoryResearchWorker.js";
import {
  readBotMemoryInternalServerConfig,
  startBotMemoryInternalServer,
} from "./botMemoryInternalServer.js";

dotenv.config({ path: '../../.env' });

logAiRouteTable({ prefixes: ['BIORHYTHM_'] });

const app = express();
app.use(express.json());

const PORT = process.env.BIORHYTHM_SERVER_PORT || 3002;
const HOST = process.env.BIORHYTHM_SERVER_HOST;
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = parseAllowedOrigins(process.env.BIORHYTHM_WS_ALLOWED_ORIGINS);
if (isProduction && allowedOrigins.size === 0) {
  throw new Error("BIORHYTHM_WS_ALLOWED_ORIGINS must be configured in production");
}

// 公開 GET（/health, /history, /timeline）は bot-tan.com がブラウザから直接読む。
// 許可オリジンは WS と同じ設定を使い回し、二重に管理しない。開発時は未設定＝全許可。
app.use(
  cors({
    origin: isProduction ? [...allowedOrigins] : true,
    methods: ["GET", "OPTIONS"],
  }),
);
app.use(publicApi);

const manager = new BiorhythmManager();

// このサーバーは公開されている（/image.png と /.well-known/atproto-did を配信）ため、
// 以下の状態変更/状態取得エンドポイントは loopback バインドではなく共有シークレットで
// 保護する。呼び出し側は packages/clients/BiorhythmService でシークレットを付与する。
const INTERNAL_SECRET = process.env.BIORHYTHM_INTERNAL_SECRET;
const requireInternalAuth: express.RequestHandler = (req, res, next) => {
  if (!INTERNAL_SECRET) {
    console.error("[ERROR][BIO] BIORHYTHM_INTERNAL_SECRET が未設定のため内部リクエストを拒否します。");
    res.status(503).json({ error: "server not configured" });
    return;
  }
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${INTERNAL_SECRET}`;
  const provided = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};
// Endpoints
app.get("/status", requireInternalAuth, async (req, res) => {
  const state = await manager.getCurrentState();
  res.json(state);
});

app.post("/energy", requireInternalAuth, async (req, res) => {
  const { amount, type, did } = req.body;

  try {
    if (type === "affirmation" && did) {
      manager.addAffirmation(did);
    } else if (type === "dj") {
      await manager.addDJ();
    } else if (type === "fortune") {
      await manager.addFortune();
    } else if (type === "cheer") {
      await manager.addCheer();
    } else if (type === "answer") {
      await manager.addAnswer();
    } else if (type === "conversation") {
      await manager.addConversation();
    } else if (type === "analysis") {
      await manager.addAnalysis();
    } else if (type === "anniversary") {
      await manager.addAnniversary();
    } else if (type === "like") {
      await manager.addLike();
    } else if (amount) {
      // Generic energy change
      await (manager as any).changeEnergy(amount);
    }
  } catch (err: any) {
    console.error("[ERROR][ENERGY] Failed to process energy update:", err.message);
  }

  res.json({ success: true, energy: manager.getEnergy });
});

// User requested static endpoints
app.get("/.well-known/atproto-did", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(process.env.BSKY_DID);
});

app.get("/image.png", (req, res) => {
  const imageBuffer = manager.generatedImage;
  if (imageBuffer) {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(imageBuffer);
  } else {
    res.status(404).send("Image not found");
  }
});

const server = http.createServer(app);
// 記憶APIは公開HTTP/WSサーバーへ載せない。公開側をloopbackのままCloudflare
// Tunnelへ接続しつつ、この専用listenerだけをLAN IPへbindできるようにする。
startBotMemoryInternalServer({
  config: readBotMemoryInternalServerConfig(),
  secret: INTERNAL_SECRET,
});
const websocketServer = attachBiorhythmWebSocketServer(server, {
  allowedOrigins,
  enforceAllowedOrigins: isProduction,
  getSnapshot: () => manager.getCurrentState(),
  maxConnections: readPositiveInteger(
    process.env.BIORHYTHM_WS_MAX_CONNECTIONS,
    500,
    "BIORHYTHM_WS_MAX_CONNECTIONS",
  ),
  maxConnectionsPerIp: readPositiveInteger(
    process.env.BIORHYTHM_WS_MAX_CONNECTIONS_PER_IP,
    10,
    "BIORHYTHM_WS_MAX_CONNECTIONS_PER_IP",
  ),
  maxBufferedBytes: readPositiveInteger(
    process.env.BIORHYTHM_WS_MAX_BUFFERED_BYTES,
    1_048_576,
    "BIORHYTHM_WS_MAX_BUFFERED_BYTES",
  ),
  heartbeatIntervalMs: readPositiveInteger(
    process.env.BIORHYTHM_WS_HEARTBEAT_INTERVAL_MS,
    30_000,
    "BIORHYTHM_WS_HEARTBEAT_INTERVAL_MS",
  ),
  snapshotTtlMs: readPositiveInteger(
    process.env.BIORHYTHM_WS_SNAPSHOT_TTL_MS,
    5_000,
    "BIORHYTHM_WS_SNAPSHOT_TTL_MS",
  ),
  trustCfConnectingIp: process.env.BIORHYTHM_TRUST_CF_CONNECTING_IP === "true",
});

manager.on('statsChange', (state) => {
  websocketServer.broadcast(state);
});

server.listen(Number(PORT), HOST, async () => {
  console.log(`Biorhythm Server running on port ${PORT}`);
  console.log(`🟢 WS server listening on path /ws`);
  try {
    const { initializeDatabases } = await import("@bsky-affirmative-bot/clients");
    await initializeDatabases();
    startBotMemoryEmbeddingWorker();
    startBotMemoryImpressionWorker();
    startBotMemoryPronunciationWorker();
    // リプライの同期パスから外した検索を裏で回す。結果は共通の bot memory へ入る。
    startBotMemoryResearchWorker();

    await manager.init();
    // 各プロセスのハートビートを読み、ローカル LLM と Nagi ingest を自前で叩く。
    startHealthMonitor();
    const { scheduleRoomInteractionSync } = await import("./roomInteractionSync.js");
    scheduleRoomInteractionSync(manager);
    const { scheduleLiveCommentEnergySync } = await import("./liveCommentEnergySync.js");
    scheduleLiveCommentEnergySync(manager);
    await manager.start();
    console.log("[INFO] Biorhythm loop started.");
  } catch (e) {
    console.error("[CRITICAL] Biorhythm startup failed:", e);
  }
});
