import express from "express";
import dotenv from "dotenv";
import { initAgent } from "./bsky/agent.js";
import { startWebSocket } from "./bsky/jetstream.js";
import { scheduleAllUserDiaries } from "./features/DiaryFeature.js";
import { scheduleSubscriberLabelSync } from "./features/SubscriberLabelFeature.js";
import { scheduleRegularBadgeSync } from "./features/RoomVisitBadgeFeature.js";
import { updateFollowers, loadFollowersFromCache } from "./bsky/followerManagement.js";
import { onPost, onFollow, onLike, onLikeDelete, onPostUpdate, onPostDelete } from "./bsky/callbacks.js";
import { router } from "./routes.js";
import { logAiRouteTable } from "@bsky-affirmative-bot/shared-configs";
import axios from "axios";

dotenv.config({ path: '../../.env' });

// どの機能がどのモデル/tierで動いているかを起動時に1回だけ出す。
// dotenv.config() より後で呼ぶこと（env上書きを反映させるため）。
logAiRouteTable({ prefixes: ['COMMON_', 'BSKY_', 'OLLAMA_'] });

const app = express();
app.use("/", router);

const PORT = Number(process.env.BSKY_BOT_SERVER_PORT || 3001);

// Endpoints for features triggered by biorhythm_server
// Moved to routes.ts

// サービス間通信専用のエンドポイントのため、他ホストから到達できないよう
// loopback にバインドする。
app.listen(PORT, "127.0.0.1", async () => {
  console.log(`Besky Bot Server running on 127.0.0.1:${PORT}`);
  try {
    const { initializeDatabases } = await import("@bsky-affirmative-bot/clients");
    await initializeDatabases();

    await initAgent();

    // 起動時にまずファイルキャッシュからフォロワー情報を復元（一瞬で完了）
    await loadFollowersFromCache();
    
    // フォロワー取得は時間がかかるため非同期で実行し、ブロックしない
    updateFollowers().catch(e => {
      console.error("[ERROR] Failed to update followers on startup:", e);
    });

    // takedown復活などでキャッシュから漏れたフォロワーを定期的に回復する
    setInterval(() => {
      updateFollowers().catch(e => console.error("[ERROR] Periodic follower update failed:", e));
    }, 60 * 60 * 1000); // 1時間

    // Run diary scheduling in the background
    scheduleAllUserDiaries().catch(e => {
      console.error("[ERROR] Failed to schedule diaries:", e);
    });

    // Run subscriber label synchronization in the background
    scheduleSubscriberLabelSync().catch(e => {
      console.error("[ERROR] Failed to schedule subscriber labels:", e);
    });

    // Run regular badge synchronization in the background
    scheduleRegularBadgeSync().catch(e => {
      console.error("[ERROR] Failed to schedule regular badges:", e);
    });

    startWebSocket(onPost, onFollow, onLike, undefined, onPostUpdate, onPostDelete, onLikeDelete);

    // このプロセス自体の死活。bot-tan.com のダッシュボードが「botたんサーバー」
    // タイルの内訳として読む。
    const { reportHeartbeat } = await import("@bsky-affirmative-bot/clients");
    const heartbeat = setInterval(() => {
      reportHeartbeat("bsky-bot").catch(e =>
        console.error("[ERROR] Failed to report heartbeat:", e),
      );
    }, 30_000);
    heartbeat.unref();
    reportHeartbeat("bsky-bot").catch(() => {});
  } catch (e) {
    console.error("[CRITICAL] Bot startup failed:", e);
    process.exit(1);
  }
});
