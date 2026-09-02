import { config } from "../../config.js";
import type { ModerationDecision } from "./rules.js";

/**
 * 運用者向けの Discord 通知。
 *
 * AppView と discord_bot は同じホストで動くので、outbox もポーラーも挟まず
 * Webhook を直接叩く。判定は取り込みと非同期なので、ここが失敗しても
 * 取り込み・投稿は一切影響を受けない（ログだけ残す）。
 */

const TIMEOUT_MS = 10_000;
/** OpenAI 障害の連投を防ぐ。復旧するまでアラートは1回だけ。 */
const FAILURE_ALERT_THRESHOLD = 5;

let consecutiveFailures = 0;
let outageAlerted = false;

async function post(content: string): Promise<void> {
  const webhook = config.moderation?.discordWebhookUrl;
  if (!webhook) return;
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 本文をそのまま貼らないので mention は起きないが、念のため全面的に無効化する。
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      console.error(
        `[ERROR][moderation] Discord webhook returned HTTP ${response.status}`,
      );
  } catch (error) {
    console.error("[ERROR][moderation] Discord webhook failed:", error);
  }
}

export type ModerationNotice = {
  decision: ModerationDecision;
  collection: string;
  uri: string;
  did: string;
  labels: string[];
  category: string;
  score: number;
  ruleVersion: string;
  /** 判定時点で AppView に既存行があったか。create / update の別。 */
  update: boolean;
};

const HEADLINE: Record<ModerationDecision, string> = {
  allow: "",
  label: "🏷️ ラベル付与",
  "reject-policy": "⛔ 保存拒否（規約違反）",
  "reject-invalid": "⚠️ 保存見送り（入力不正・規約違反ではありません）",
};

/** 判定結果の通知。allow は通知しない。 */
export async function notifyDecision(notice: ModerationNotice): Promise<void> {
  if (notice.decision === "allow") return;
  const rkey = notice.uri.slice(notice.uri.lastIndexOf("/") + 1);
  const link =
    notice.collection === "com.suibari.nagi.post"
      ? `https://nagi.suibari.com/thread/${notice.did}/${rkey}`
      : "";
  const lines = [
    HEADLINE[notice.decision],
    `collection: \`${notice.collection}\` (${notice.update ? "update" : "create"})`,
    `author: \`${notice.did}\``,
    `uri: \`${notice.uri}\``,
    notice.labels.length ? `labels: \`${notice.labels.join(", ")}\`` : "",
    notice.category
      ? `category: \`${notice.category}\` (${(notice.score * 100).toFixed(1)}%)`
      : "",
    `rule: \`${notice.ruleVersion}\``,
    link,
  ].filter(Boolean);
  await post(lines.join("\n"));
}

/**
 * OpenAI 障害の記録。連続失敗が閾値を超えたら一度だけアラートを出し、
 * 成功したら次の障害に備えて状態を戻す。
 */
export async function recordModerationFailure(error: unknown): Promise<void> {
  consecutiveFailures++;
  if (consecutiveFailures < FAILURE_ALERT_THRESHOLD || outageAlerted) return;
  outageAlerted = true;
  await post(
    [
      "🚨 モデレーション判定が連続失敗しています",
      `連続失敗: ${consecutiveFailures} 回`,
      `直近のエラー: \`${String(error).slice(0, 500)}\``,
      "取り込みと投稿は継続しています（判定待ちのまま溜まります）。",
    ].join("\n"),
  );
}

export async function recordModerationSuccess(): Promise<void> {
  if (outageAlerted) {
    outageAlerted = false;
    await post("✅ モデレーション判定が復旧しました");
  }
  consecutiveFailures = 0;
}

/** テスト用。モジュールスコープの障害カウンタを戻す。 */
export function resetModerationFailureState(): void {
  consecutiveFailures = 0;
  outageAlerted = false;
}
