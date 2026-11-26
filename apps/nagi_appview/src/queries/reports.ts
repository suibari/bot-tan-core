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

export type PostReportInput = {
  uri: string;
  /** 付いていればリアクションの通報（この投稿にこの人が付けたリアクション）。 */
  reactorDid?: string;
  reason: ReportReason;
  comment: string;
};

/** Nagi Space の Space（member があればその参加者）の通報。存在は確かめられないので受け取ったまま運ぶ。 */
export type SpaceReportInput = {
  space: { id: string; title: string; url: string; hostDid: string; member?: string };
  reason: ReportReason;
  comment: string;
};

export type ReportInput = PostReportInput | SpaceReportInput;

const DID_PATTERN = /^did:[a-z]+:\S+$/;
const SPACE_TITLE_MAX = 100;

function parseReasonAndComment(value: { reason?: unknown; comment?: unknown }) {
  if (!REPORT_REASONS.includes(value.reason as ReportReason))
    throw new ApiError(400, "invalid_request", "reason is invalid");
  const comment = value.comment === undefined ? "" : value.comment;
  if (typeof comment !== "string")
    throw new ApiError(400, "invalid_request", "comment must be a string");
  if ([...comment].length > COMMENT_MAX)
    throw new ApiError(400, "invalid_request", `comment must be ${COMMENT_MAX} characters or fewer`);
  return { reason: value.reason as ReportReason, comment: comment.trim() };
}

function parseSpaceSubject(space: unknown): SpaceReportInput["space"] {
  const value = (space ?? {}) as Record<string, unknown>;
  const { id, title, url, hostDid, member } = value;
  if (typeof id !== "string" || !id || id.length > 64)
    throw new ApiError(400, "invalid_request", "subject.space.id is invalid");
  if (typeof title !== "string" || [...title].length > SPACE_TITLE_MAX)
    throw new ApiError(400, "invalid_request", "subject.space.title is invalid");
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048)
    throw new ApiError(400, "invalid_request", "subject.space.url is invalid");
  if (typeof hostDid !== "string" || !DID_PATTERN.test(hostDid))
    throw new ApiError(400, "invalid_request", "subject.space.hostDid must be a DID");
  if (member !== undefined && (typeof member !== "string" || !DID_PATTERN.test(member)))
    throw new ApiError(400, "invalid_request", "subject.space.member must be a DID");
  return { id, title, url, hostDid, ...(member ? { member: member as string } : {}) };
}

/** 入力の検証。対象は Nagi の投稿、投稿に付いたリアクション、Nagi Space の Space とその参加者。 */
export function parseReportInput(body: unknown): ReportInput {
  const value = (body ?? {}) as {
    subject?: { uri?: unknown; reactor?: unknown; space?: unknown };
    reason?: unknown;
    comment?: unknown;
  };
  if (value.subject?.space !== undefined) {
    if (value.subject.uri !== undefined)
      throw new ApiError(400, "invalid_request", "subject must be either uri or space");
    return { space: parseSpaceSubject(value.subject.space), ...parseReasonAndComment(value) };
  }
  const uri = value.subject?.uri;
  if (typeof uri !== "string")
    throw new ApiError(400, "invalid_request", "subject.uri is required");
  const match = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (match?.[2] !== NAGI.post)
    throw new ApiError(400, "invalid_request", "subject must be a Nagi post");
  const reactor = value.subject?.reactor;
  if (reactor !== undefined && (typeof reactor !== "string" || !DID_PATTERN.test(reactor)))
    throw new ApiError(400, "invalid_request", "subject.reactor must be a DID");
  return {
    uri,
    ...(reactor ? { reactorDid: reactor as string } : {}),
    ...parseReasonAndComment(value),
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
  if ("space" in input) {
    const { space } = input;
    return deliver(viewerDid, {
      reporterDid: viewerDid,
      reason: input.reason,
      comment: input.comment,
      subjectType: space.member ? "spaceMember" : "space",
      subjectUri: space.url,
      authorDid: space.member ?? space.hostDid,
      authorIsBot: (space.member ?? space.hostDid) === config.botDid,
      content: space.title,
      ...(space.member ? { contextText: `Space ${space.id}（ホスト ${space.hostDid}）` } : {}),
    });
  }
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
  return deliver(viewerDid, notice);
}

async function deliver(viewerDid: string, notice: ReportNotice): Promise<Record<string, never>> {
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
