import { config } from "../../config.js";

/**
 * ユーザーからの通報・フィードバックを運営の Discord へ送る。
 * 送れなかったら呼び出し側へ失敗を返す（通報はユーザーが「送れた」と信じる操作なので、
 * モデレーション通知のように握りつぶさない）。
 */

const TIMEOUT_MS = 10_000;

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "sensitive",
  "botResponse",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const REASON_LABEL: Record<ReportReason, string> = {
  spam: "スパム・宣伝",
  harassment: "攻撃的・いやがらせ",
  sensitive: "不適切・センシティブ",
  botResponse: "botたんの返答へのFB",
  other: "その他",
};

export type ReportNotice = {
  reporterDid: string;
  reason: ReportReason;
  comment: string;
  subjectType: "post" | "reaction";
  subjectUri: string;
  /** 対象の作者（リアクションならリアクションした人）。 */
  authorDid: string;
  authorIsBot: boolean;
  /** 投稿の本文。リアクションなら絵文字。 */
  content: string;
  /** リアクションのときだけ、リアクションが付いた投稿の本文。 */
  contextText?: string;
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/** 本文中の @everyone などで運営チャンネルを鳴らさないよう、コードブロックに入れる。 */
const quote = (value: string, max: number) =>
  `\`\`\`\n${truncate(value.replaceAll("```", "ˋˋˋ") || "(本文なし)", max)}\n\`\`\``;

export function buildReportPayload(notice: ReportNotice) {
  const target =
    notice.subjectType === "post"
      ? notice.authorIsBot
        ? "botたんの投稿"
        : "投稿"
      : "リアクション";
  const fields = [
    { name: "理由", value: REASON_LABEL[notice.reason], inline: true },
    { name: "対象", value: target, inline: true },
    { name: "作者", value: notice.authorDid, inline: false },
    { name: "通報者", value: notice.reporterDid, inline: false },
    { name: "URI", value: notice.subjectUri, inline: false },
    {
      name: notice.subjectType === "post" ? "本文" : "絵文字",
      value: quote(notice.content, 900),
      inline: false,
    },
    ...(notice.contextText !== undefined
      ? [{ name: "リアクション先の投稿", value: quote(notice.contextText, 600), inline: false }]
      : []),
    ...(notice.comment
      ? [{ name: "コメント", value: quote(notice.comment, 1000), inline: false }]
      : []),
  ];
  return {
    content: notice.reason === "botResponse"
      ? "💬 ユーザーからのフィードバック"
      : "🚩 ユーザーからの通報",
    embeds: [{ title: `${target}への${REASON_LABEL[notice.reason]}`, fields }],
    allowed_mentions: { parse: [] },
  };
}

export async function sendReport(notice: ReportNotice): Promise<void> {
  const webhook = config.reports.discordWebhookUrl;
  if (!webhook) {
    // 開発用 AppView では送らない。届いた体でユーザー側の流れを確かめられるようにする。
    console.info("[report] Discord webhook is not configured; report was not delivered", {
      reason: notice.reason,
      subjectUri: notice.subjectUri,
    });
    return;
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildReportPayload(notice)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
}
