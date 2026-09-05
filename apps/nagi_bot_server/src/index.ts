import { startBotJetstream } from "@bsky-affirmative-bot/bot-runtime";
import {
  initializeDatabases,
  reportHealthFailure,
  reportHeartbeat,
} from "@bsky-affirmative-bot/clients";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { initAgent } from "./agent.js";
import {
  assertNagiBotIdentity,
  syncNagiBotProfile,
} from "./NagiBotProfileFeature.js";
import { onNagiPost } from "./NagiReplyFeature.js";
import {
  onNagiChannel,
  startNagiChannelTopicScheduler,
} from "./NagiChannelFeature.js";
import { startNagiReplyWorker } from "./NagiReplyWorker.js";
import { startNagiAnalysisWorker } from "./NagiAnalysisWorker.js";
import { startNagiCardCommentWorker } from "./NagiCardCommentWorker.js";
import { startNagiCommunityAffirmationWorker } from "./NagiCommunityAffirmationWorker.js";
import { startNagiThemeWorker } from "./NagiThemeWorker.js";
import { enqueueAnalysis, runNagiAnalysis } from "./NagiAnalysisFeature.js";
import express from "express";
import type { ScheduledPostRequest } from "@bsky-affirmative-bot/clients";
import { publishScheduledPost } from "./ScheduledPostFeature.js";
import {
  processNagiDiary,
  purgeNagiDiaries,
  scheduleAllNagiDiaries,
} from "./NagiDiaryFeature.js";
import { publishNews } from "./NagiNewsFeature.js";
import { schedulePositiveNewsUpdates } from "./positiveNewsUpdater.js";
import { scheduleUserNewsReviews } from "./userNewsReviewWorker.js";
import { logAiRouteTable } from "@bsky-affirmative-bot/shared-configs";
import { startGuestAffirmationWorker } from "./GuestAffirmationWorker.js";

/**
 * 開発環境かどうか。DEV 系のフラグを増やさないための単一の判定。
 * 未設定・未知の値はすべて「開発ではない」に倒す（nagi_appview の config.dev と同じ規則）。
 */
const isDev = process.env.NODE_ENV === "development";

async function start() {
  // どの機能がどのモデル/tierで動いているかを起動時に1回だけ出す。
  logAiRouteTable({ prefixes: ["COMMON_", "NAGI_", "NEWS_", "OLLAMA_"] });
  await initializeDatabases();
  await initAgent();

  assertNagiBotIdentity();
  await syncNagiBotProfile().catch((error) => {
    console.error("[ERROR][NAGI] Failed to sync Bot profile:", error);
  });

  startBotJetstream({
    endpoint: process.env.URL_JETSTREAM,
    // Phase 2 の「創設時の盛り上げ投稿」に備え、CH 作成イベントも購読しておく（ハンドラは現状スタブ）。
    wantedCollections: [NAGI.post, NAGI.channel],
    onCreate: {
      [NAGI.post]: onNagiPost,
      [NAGI.channel]: onNagiChannel,
    },
    onHealth: (event) => {
      const report = event.ok
        ? reportHeartbeat("jetstream-nagi", event.detail)
        : reportHealthFailure("jetstream-nagi", event.error);
      report.catch((e) =>
        console.error("[ERROR][NAGI] Failed to report Jetstream health:", e),
      );
    },
  });
  // このプロセス自体の死活。bot-tan.com のダッシュボードが「botたんサーバー」
  // タイルの内訳として読む。
  const nagiBotHeartbeat = setInterval(() => {
    reportHeartbeat("nagi-bot").catch((e) =>
      console.error("[ERROR][NAGI] Failed to report heartbeat:", e),
    );
  }, 30_000);
  nagiBotHeartbeat.unref();
  reportHeartbeat("nagi-bot").catch(() => {});

  startNagiReplyWorker();
  // DIDを持たない初回利用者向け。公開投稿は作らず、期限付きジョブから返信文だけを返す。
  startGuestAffirmationWorker();
  // 自動分析（プロフィールの「botたんのひとこと」）ワーカー。エンキューは AppView ingest が担う。
  startNagiAnalysisWorker();
  // 全肯定カードを引いたときの吹き出しコメント。エンキューは AppView の drawCard が担う。
  startNagiCardCommentWorker();
  // 右サイドバー「みんなで全肯定」の匿名要約。候補選出と生成を作者単位で行う。
  startNagiCommunityAffirmationWorker();
  // 動的枠の「おすすめの理由」を先に計算しておく（リクエスト経路でLLMを呼ばないため）。
  startNagiThemeWorker();

  // ニュースフィードの取得・公開とユーザー追加ニュースの審査は、
  // Nagiへの投稿を所有するこのサーバーで完結させる。
  schedulePositiveNewsUpdates();
  scheduleUserNewsReviews();
  // 過疎チャンネルへの話題提供（Phase 2）。作成時の盛り上げ投稿は onNagiChannel が担う。
  startNagiChannelTopicScheduler();

  scheduleAllNagiDiaries().catch((error) => {
    console.error("[ERROR][NAGI] Failed to schedule diaries:", error);
  });

  const app = express();
  app.use(express.json());
  app.post("/posts/scheduled", async (req, res) => {
    try {
      const request = req.body as ScheduledPostRequest;
      if (!(["morning", "whimsical", "good-night"] as const).includes(request?.kind) || typeof request.text !== "string" || !request.text.trim()) {
        res.status(400).json({ error: "kind and text are required" });
        return;
      }
      // 対訳は付いていれば使う程度のものなので、壊れた要素は落として投稿自体は通す。
      const translations = Array.isArray(request.translations)
        ? request.translations.filter(
            (entry): entry is { lang: string; text: string } =>
              typeof entry?.lang === "string" &&
              typeof entry?.text === "string" &&
              entry.text.trim().length > 0,
          )
        : [];
      res.status(200).json(await publishScheduledPost({
        ...request,
        ...(translations.length ? { translations } : {}),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });
  app.post("/news", async (req, res) => {
    try {
      const value = req.body;
      if (typeof value?.articleId !== "string" || typeof value?.url !== "string" || typeof value?.titleJa !== "string") {
        res.status(400).json({ error: "articleId, url and titleJa are required" });
        return;
      }
      res.status(200).json(await publishNews({
        articleId: value.articleId, url: value.url, titleJa: value.titleJa,
        sourceName: typeof value.sourceName === "string" ? value.sourceName : undefined,
        sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : undefined,
        publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : undefined,
        langs: ["ja"], createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // 22時を待たずに日記を書かせる（動作確認・手動リカバリ用）。
  app.post("/diaries/run", async (req, res) => {
    try {
      const did = String(req.body?.did ?? "");
      if (!did.startsWith("did:")) {
        res.status(400).json({ error: "did is required" });
        return;
      }
      await processNagiDiary(did);
      res.status(200).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // 100投稿・初回登録を待たずに分析をキューする（動作確認・手動リカバリ用）。
  //
  // force / sync は名刺デザインを詰めるための開発用で、NODE_ENV=development の
  // ときだけ受け付ける（専用の環境変数は増やさない）。フラグ無しの素の呼び出しは
  // 従来どおり本番でも手動リカバリに使える。
  app.post("/analysis/run", async (req, res) => {
    try {
      const did = String(req.body?.did ?? "");
      const source = String(req.body?.source ?? "");
      if (!did.startsWith("did:")) {
        res.status(400).json({ error: "did is required" });
        return;
      }
      if (source !== "bluesky" && source !== "nagi") {
        res.status(400).json({ error: "source must be 'bluesky' or 'nagi'" });
        return;
      }
      const postCountAt =
        typeof req.body?.postCountAt === "number"
          ? req.body.postCountAt
          : undefined;
      const force = req.body?.force === true;
      const sync = req.body?.sync === true;
      if ((force || sync) && !isDev) {
        res.status(403).json({
          error: "force and sync require NODE_ENV=development",
        });
        return;
      }
      if (sync) {
        // キューを介さず直接実行し、生成物をそのまま返す。ワーカーの10秒待ちが無く、
        // 投稿0件のスキップも呼び出し側から見えるようになる。
        const result = await runNagiAnalysis({
          did,
          source,
          postCountAt: postCountAt ?? null,
        });
        res.status(200).json(result);
        return;
      }
      await enqueueAnalysis({ did, source, postCountAt, force });
      res.status(200).json({ ok: true });
    } catch (error) {
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // データ削除時に bot リポジトリから当該ユーザーの日記を消す。
  app.post("/diaries/purge", async (req, res) => {
    try {
      const did = String(req.body?.did ?? "");
      if (!did.startsWith("did:")) {
        res.status(400).json({ error: "did is required" });
        return;
      }
      res.status(200).json({ deleted: await purgeNagiDiaries(did) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  const port = Number(process.env.NAGI_BOT_SERVER_PORT || 3003);
  // サービス間通信専用のエンドポイントのため、他ホストから到達できないよう
  // loopback にバインドする。
  app.listen(port, "127.0.0.1", () =>
    console.log(`[INFO][NAGI] HTTP server listening on 127.0.0.1:${port}.`),
  );

  console.log("[INFO][NAGI] Nagi Bot Server started.");
}

start().catch((error) => {
  console.error("[CRITICAL][NAGI] Bot startup failed:", error);
  process.exit(1);
});
