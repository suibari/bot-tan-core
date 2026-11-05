import { db, nagiPosts, nagiReactions } from "@bsky-affirmative-bot/database";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import {
  REPORT_REASONS,
  sendReport,
  type ReportNotice,
  type ReportReason,
} from "../services/reports/notify.js";

/** 1人あたり1時間に送れる件数。誤操作の連打と、運営チャンネルを埋める嫌がらせの両方を止める。 */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60_000;
const COMMENT_MAX = 1000;

export type ReportInput = {
  uri: string;
  /** 付いていればリアクションの通報（この投稿にこの人が付けたリアクション）。 */
  reactorDid?: string;
  reason: ReportReason;
  comment: string;
};

/** 入力の検証。対象は Nagi の投稿か、投稿に付いたリアクションだけ。 */
export function parseReportInput(body: unknown): ReportInput {
  const value = (body ?? {}) as {
    subject?: { uri?: unknown; reactor?: unknown };
    reason?: unknown;
    comment?: unknown;
  };
  const uri = value.subject?.uri;
  if (typeof uri !== "string")
    throw new ApiError(400, "invalid_request", "subject.uri is required");
  const match = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (match?.[2] !== NAGI.post)
    throw new ApiError(400, "invalid_request", "subject must be a Nagi post");
  const reactor = value.subject?.reactor;
  if (reactor !== undefined && (typeof reactor !== "string" || !/^did:[a-z]+:\S+$/.test(reactor)))
    throw new ApiError(400, "invalid_request", "subject.reactor must be a DID");
  if (!REPORT_REASONS.includes(value.reason as ReportReason))
    throw new ApiError(400, "invalid_request", "reason is invalid");
  const comment = value.comment === undefined ? "" : value.comment;
  if (typeof comment !== "string")
    throw new ApiError(400, "invalid_request", "comment must be a string");
  if ([...comment].length > COMMENT_MAX)
    throw new ApiError(400, "invalid_request", `comment must be ${COMMENT_MAX} characters or fewer`);
  return {
    uri,
    ...(reactor ? { reactorDid: reactor as string } : {}),
    reason: value.reason as ReportReason,
    comment: comment.trim(),
  };
}

const recent = new Map<string, number[]>();

/** 送信枠を1つ使う。枠が無ければ false。 */
export function takeReportSlot(did: string, now = Date.now()): boolean {
  const sent = (recent.get(did) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (sent.length >= RATE_LIMIT) {
    recent.set(did, sent);
    return false;
  }
  sent.push(now);
  recent.set(did, sent);
  return true;
}

/** テスト用。 */
export function resetReportRateLimit() {
  recent.clear();
}

/**
 * 通報者から見える投稿だけを返す。こっそりスレッドは作者本人と botたんのものなので、
 * それ以外からの通報は存在ごと伏せる（thread.ts と同じ fail closed）。
 */
async function visiblePost(uri: string, viewerDid: string) {
  const [post] = await db
    .select({
      uri: nagiPosts.uri,
      did: nagiPosts.did,
      text: nagiPosts.text,
      replyRootUri: nagiPosts.replyRootUri,
      kossori: nagiPosts.kossori,
    })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, uri))
    .limit(1);
  if (!post) return undefined;
  const rootUri = post.replyRootUri ?? post.uri;
  const root =
    rootUri === post.uri
      ? post
      : (
          await db
            .select({ did: nagiPosts.did, kossori: nagiPosts.kossori })
            .from(nagiPosts)
            .where(eq(nagiPosts.uri, rootUri))
            .limit(1)
        )[0];
  if (!root) return undefined;
  if (root.kossori && root.did !== viewerDid) return undefined;
  return post;
}

export async function createReport(
  viewerDid: string,
  body: unknown,
): Promise<Record<string, never>> {
  const input = parseReportInput(body);
  const post = await visiblePost(input.uri, viewerDid);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  let notice: ReportNotice;
  if (!input.reactorDid) {
    notice = {
      reporterDid: viewerDid,
      reason: input.reason,
      comment: input.comment,
      subjectType: "post",
      subjectUri: post.uri,
      authorDid: post.did,
      authorIsBot: post.did === config.botDid,
      content: post.text,
    };
  } else {
    const reactions = await db
      .select({ uri: nagiReactions.uri, emoji: nagiReactions.emoji })
      .from(nagiReactions)
      .where(
        and(eq(nagiReactions.subjectUri, post.uri), eq(nagiReactions.did, input.reactorDid)),
      );
    if (!reactions.length) throw new ApiError(404, "not_found", "Reaction not found");
    notice = {
      reporterDid: viewerDid,
      reason: input.reason,
      comment: input.comment,
      subjectType: "reaction",
      subjectUri: reactions.map((reaction) => reaction.uri).join("\n"),
      authorDid: input.reactorDid,
      authorIsBot: input.reactorDid === config.botDid,
      content: reactions.map((reaction) => reaction.emoji).join(" "),
      contextText: post.text,
    };
  }
  if (!takeReportSlot(viewerDid))
    throw new ApiError(429, "rate_limited", "Too many reports. Please try again later.");
  try {
    await sendReport(notice);
  } catch (error) {
    console.error("[ERROR][report] failed to deliver report:", error);
    throw new ApiError(502, "upstream_unavailable", "Could not deliver the report");
  }
  return {};
}
