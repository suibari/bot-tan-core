import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pg from "pg";
import {
  ContentEvaluator,
  PostEvaluationInput,
} from "../src/moderation/evaluator.js";
import { DEFAULT_THRESHOLDS } from "../src/moderation/rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env を読み込み（アプリ直下およびモノレポルート）
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!OPENAI_API_KEY) {
  console.error(
    "❌ [ERROR] OPENAI_API_KEY が設定されていません。.env を確認してください。",
  );
  process.exit(1);
}

// コマンドライン引数からサンプル数を取得（例: npm run benchmark -- --limit 50）
const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const sampleLimit =
  limitIndex !== -1 && args[limitIndex + 1]
    ? parseInt(args[limitIndex + 1], 10)
    : 50;

async function fetchSamplePostsFromDB(
  limit: number,
): Promise<PostEvaluationInput[]> {
  if (!DATABASE_URL) {
    console.warn(
      "⚠️  DATABASE_URL が設定されていないため、モックデータでテストします。",
    );
    return [
      {
        text: "今日も一日お疲れ様でした！温かいお風呂に入って寝ます〜",
        uri: "at://did:plc:mock/com.suibari.nagi.post/1",
      },
      {
        text: "死にたいくらい疲れた…でもbotたんに褒めてもらったから頑張る",
        uri: "at://did:plc:mock/com.suibari.nagi.post/2",
      },
      {
        text: "あいつマジでむかつく、消えてほしいわ",
        uri: "at://did:plc:mock/com.suibari.nagi.post/3",
      },
      {
        text: "AI生成の可愛い女の子のイラスト描いたよ！ #AIart",
        uri: "at://did:plc:mock/com.suibari.nagi.post/4",
      },
      {
        text: "ちょっとセクシーな水着の写真です",
        uri: "at://did:plc:mock/com.suibari.nagi.post/5",
      },
    ];
  }

  const { Pool } = pg;
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log(
      `[DB] データベース (${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}) から最新 ${limit} 件の投稿を取得中...`,
    );

    // nagi.posts テーブルから最新の投稿（テキスト・画像）を取得
    const res = await pool.query(
      `SELECT uri, text, cid, embed_images, record_created_at 
       FROM nagi.posts 
       WHERE text IS NOT NULL AND text != '' AND deleted_at IS NULL 
       ORDER BY record_created_at DESC 
       LIMIT $1`,
      [limit],
    );

    console.log(`[DB] ${res.rows.length} 件の投稿を取得しました。`);

    return res.rows.map((row: any) => {
      let imageUrls: string[] = [];
      if (Array.isArray(row.embed_images)) {
        imageUrls = row.embed_images
          .map((img: any) => img?.fullsize || img?.thumb || img?.url)
          .filter(Boolean);
      }
      return {
        uri: row.uri,
        text: row.text,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      };
    });
  } catch (err: any) {
    console.error("⚠️  DBからの取得に失敗しました:", err.message);
    console.log(
      "ℹ️  フォールバックとしてテスト用サンプルデータで検証を実行します。",
    );
    return [
      {
        text: "今日も一日お疲れ様でした！温かいお風呂に入って寝ます〜",
        uri: "at://did:plc:mock/com.suibari.nagi.post/1",
      },
      {
        text: "死にたいくらい疲れた…でもbotたんに褒めてもらったから頑張る",
        uri: "at://did:plc:mock/com.suibari.nagi.post/2",
      },
      {
        text: "あいつマジでむかつく、消えてほしいわ",
        uri: "at://did:plc:mock/com.suibari.nagi.post/3",
      },
      {
        text: "AI生成の可愛い女の子のイラスト描いたよ！ #AIart",
        uri: "at://did:plc:mock/com.suibari.nagi.post/4",
      },
      {
        text: "ちょっとセクシーな水着の写真です",
        uri: "at://did:plc:mock/com.suibari.nagi.post/5",
      },
    ];
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("============================================================");
  console.log("🔍 nagi_amateras: OpenAI Moderation API 過検出検証 (PoC)");
  console.log("============================================================");
  console.log(
    `OpenAI API Key: ${OPENAI_API_KEY ? "設定済み (****" + OPENAI_API_KEY.slice(-4) + ")" : "未設定"}`,
  );
  console.log(`検証件数: ${sampleLimit} 件`);
  console.log("------------------------------------------------------------");

  const inputs = await fetchSamplePostsFromDB(sampleLimit);
  const evaluator = new ContentEvaluator(OPENAI_API_KEY, DEFAULT_THRESHOLDS);

  console.log(
    `\n🚀 OpenAI Moderation API (omni-moderation-latest) で判定中...`,
  );
  const startTime = Date.now();
  const results = await evaluator.evaluateBatch(inputs, 5);
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  // 統計集計
  let dropCount = 0;
  let labelCount = 0;
  let normalCount = 0;

  const categoryHits: Record<string, number> = {};

  const flaggedItems: any[] = [];
  for (const item of results) {
    const action = item.evaluation.action;
    if (action === "drop") dropCount++;
    else if (action === "label") labelCount++;
    else normalCount++;

    if (item.evaluation.highestCategory) {
      const cat = item.evaluation.highestCategory;
      categoryHits[cat] = (categoryHits[cat] || 0) + 1;
    }

    if (action === "drop" || action === "label") {
      flaggedItems.push(item);
    }
  }

  console.log("\n============================================================");
  console.log("📊 検証結果サマリー");
  console.log("============================================================");
  console.log(`総評価件数: ${results.length} 件 (所要時間: ${duration}s)`);
  console.log(
    `・🟢 正常 (None): ${normalCount} 件 (${((normalCount / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `・🟠 ラベル付与 (Label): ${labelCount} 件 (${((labelCount / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `・🔴 保存拒否 (Drop): ${dropCount} 件 (${((dropCount / results.length) * 100).toFixed(1)}%)`,
  );

  if (flaggedItems.length > 0) {
    console.log(
      "\n------------------------------------------------------------",
    );
    console.log("⚠️  アクション判定された投稿 (Drop / Label):");
    console.log("------------------------------------------------------------");
    for (const item of flaggedItems) {
      console.log(
        `[${item.evaluation.action.toUpperCase()}] スコア: ${(item.evaluation.maxScore * 100).toFixed(1)}% | 付与ラベル: ${item.evaluation.labels.join(", ")}`,
      );
      console.log(`理由: ${item.evaluation.reasons.join(", ")}`);
      console.log(`本文: "${item.text.replace(/\n/g, " ")}"`);
      console.log(`URI: ${item.uri || "N/A"}`);
      console.log("---");
    }
  }

  // レポートファイル（JSON）として出力
  const reportPath = path.resolve(__dirname, "../benchmark-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total: results.length,
        summary: { normalCount, labelCount, dropCount },
        flaggedItems,
        allResults: results,
      },
      null,
      2,
    ),
  );
  console.log(`\n📁 詳細レポートを出力しました: ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
