import { config } from "../../config.js";
import type { ModerationDecision } from "./rules.js";

/**
 * 運用者向けの Discord 通知。
 *
 * AppView と discord_bot は同じホストで動くので、outbox もポーラーも挟まず
 * discord_bot の内部 HTTP（解除ボタン付き）を直接叩き、繋がらなければ Webhook へ送る。判定は取り込みと非同期なので、ここが失敗しても
 * 取り込み・投稿は一切影響を受けない（ログだけ残す）。
 */

const TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 2_100_000;
/** OpenAI 障害の連投を防ぐ。復旧するまでアラートは1回だけ。 */
const FAILURE_ALERT_THRESHOLD = 5;

let consecutiveFailures = 0;
let outageAlerted = false;

type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const extension = (contentType: string): string => {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
};

async function downloadImages(imageUrls: string[]): Promise<{
  files: Array<{ blob: Blob; filename: string }>;
  embeds: DiscordEmbed[];
  failures: string[];
}> {
  const results = await Promise.all(
    imageUrls.slice(0, 8).map(async (url, index) => {
      const filenameBase = `moderation-${index + 1}`;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/"))
          throw new Error(
            `unexpected content-type ${contentType || "(empty)"}`,
          );
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_IMAGE_BYTES)
          throw new Error(`image is too large (${declared} bytes)`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_IMAGE_BYTES)
          throw new Error(`image is too large (${bytes.byteLength} bytes)`);
        const filename = `${filenameBase}.${extension(contentType)}`;
        return {
          file: { blob: new Blob([bytes], { type: contentType }), filename },
          embed: { image: { url: `attachment://${filename}` } },
        };
      } catch (error) {
        return {
          embed: { image: { url } },
          failure: `image ${index + 1}: ${String(error)}`,
        };
      }
    }),
  );
  const files: Array<{ blob: Blob; filename: string }> = [];
  const embeds: DiscordEmbed[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.file) files.push(result.file);
    embeds.push(result.embed);
    if (result.failure) failures.push(result.failure);
  }
  return { files, embeds, failures };
}

/**
 * 解除ボタンを付ける対象。discord_bot にだけ渡り、Webhook では使えない。
 * cid は判定した内容のもの。bot はこれを通知に書き込み、押されたら AppView へ返す。
 */
type NoticeAction = { uri: string; cid: string; decision: ModerationDecision };

/**
 * discord_bot 経由で投稿する。ボタン付きメッセージは bot でしか送れない（通常の
 * Webhook は components を受け付けない）。bot が落ちている・未設定なら false。
 */
async function postViaBot(
  url: string,
  payload: object,
  files: Array<{ blob: Blob; filename: string }>,
  action: NoticeAction | undefined,
): Promise<boolean> {
  if (!url) return false;
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    files.forEach((file, index) =>
      form.append(`files[${index}]`, file.blob, file.filename),
    );
    if (action) {
      form.append("moderation_uri", action.uri);
      form.append("moderation_cid", action.cid);
      form.append("moderation_decision", action.decision);
    }
    const response = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return true;
    console.warn(
      `[moderation] discord_bot returned HTTP ${response.status}; falling back to webhook`,
    );
  } catch (error) {
    console.warn(
      `[moderation] discord_bot unreachable; falling back to webhook: ${String(error)}`,
    );
  }
  return false;
}

async function post(
  content: string,
  embeds: DiscordEmbed[] = [],
  imageUrls: string[] = [],
  action?: NoticeAction,
): Promise<void> {
  const webhook = config.moderation?.discordWebhookUrl;
  const botUrl = config.moderation?.discordBotInternalUrl ?? "";
  if (!webhook && !botUrl) return;
  try {
    const downloaded = imageUrls.length
      ? await downloadImages(imageUrls)
      : { files: [], embeds: [], failures: [] };
    const deliveryNotes = downloaded.failures.length
      ? `\n${downloaded.failures.map((failure) => `⚠️ ${failure}`).join("\n")}`
      : "";
    const payload = {
      content: truncate(`${content}${deliveryNotes}`, 2_000),
      embeds: [...embeds, ...downloaded.embeds].slice(0, 10),
      allowed_mentions: { parse: [] },
    };
    if (await postViaBot(botUrl, payload, downloaded.files, action)) return;
    if (!webhook) {
      console.error(
        "[ERROR][moderation] discord_bot failed and no webhook fallback is configured",
      );
      return;
    }
    const form = downloaded.files.length ? new FormData() : undefined;
    if (form) {
      form.append("payload_json", JSON.stringify(payload));
      downloaded.files.forEach((file, index) =>
        form.append(`files[${index}]`, file.blob, file.filename),
      );
    }
    const response = await fetch(webhook, {
      method: "POST",
      ...(form ? {} : { headers: { "content-type": "application/json" } }),
      body: form ?? JSON.stringify(payload),
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
  /** 判定した内容の cid（プロフィールは内容のハッシュ）。解除ボタンをこの内容に結び付ける。 */
  cid: string;
  did: string;
  labels: string[];
  category: string;
  score: number;
  ruleVersion: string;
  /** 判定時点で AppView に既存行があったか。create / update の別。 */
  update: boolean;
  texts: string[];
  imageUrls: string[];
  reasons: string[];
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
  const detail = [
    notice.texts.length ? notice.texts.join("\n\n") : "（本文なし）",
    notice.reasons.length ? `\n\n判定詳細:\n${notice.reasons.join("\n")}` : "",
  ].join("");
  await post(
    lines.join("\n"),
    [
      {
        title: "判定対象の本文・メタデータ",
        description: truncate(detail, 4_096),
        color: notice.decision === "reject-policy" ? 0xc0392b : 0xf39c12,
      },
    ],
    notice.imageUrls,
    { uri: notice.uri, cid: notice.cid, decision: notice.decision },
  );
}

/**
 * OpenAI 障害の記録。連続失敗が閾値を超えたら一度だけアラートを出し、
 * 成功したら次の障害に備えて状態を戻す。
 *
 * 戻り値は現在の連続失敗回数。ワーカーがバックオフの長さを決めるのに使う。
 */
export async function recordModerationFailure(error: unknown): Promise<number> {
  consecutiveFailures++;
  if (consecutiveFailures < FAILURE_ALERT_THRESHOLD || outageAlerted)
    return consecutiveFailures;
  outageAlerted = true;
  await post(
    [
      "🚨 モデレーション判定が連続失敗しています",
      `連続失敗: ${consecutiveFailures} 回`,
      `直近のエラー: \`${String(error).slice(0, 500)}\``,
      "取り込みと投稿は継続しています（判定待ちのまま溜まります）。",
    ].join("\n"),
  );
  return consecutiveFailures;
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
