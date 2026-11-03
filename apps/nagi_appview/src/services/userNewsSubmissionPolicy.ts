import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { parseRecordUri } from "../ingest/recordUri.js";
import { ApiError } from "../middleware/errors.js";

export const normalizeNewsUrl = (raw: string): string => {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ApiError(400, "invalid_request", "URL must use http or https");
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) =>
    url.searchParams.delete(key),
  );
  return url.toString();
};

export const jstDayStart = (now: Date): Date => {
  const offset = 9 * 60 * 60 * 1000;
  return new Date(Math.floor((now.getTime() + offset) / 86_400_000) * 86_400_000 - offset);
};

export function validateNewsReviewSubject(viewerDid: string, subject: { uri: string; cid: string }) {
  const parsed = parseRecordUri(subject.uri);
  if (!parsed || parsed.did !== viewerDid || parsed.collection !== NAGI.news)
    throw new ApiError(403, "forbidden", "News record owner does not match");
  if (!subject.cid.trim()) throw new ApiError(400, "invalid_request", "News record CID is required");
  return parsed;
}

export type NewsReviewState =
  | "pending"
  | "processing"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled";

/**
 * 利用者に見せる状態。ジョブはコメント生成の進み具合なので、掲載されているかは
 * 承認行で決める（コメント待ちでも、コメント生成に失敗しても「掲載中」）。
 */
export function submissionStatus(
  jobStatus: NewsReviewState,
  approvalStatus: string | null,
  hiddenAt: Date | null,
): NewsReviewState {
  if (jobStatus === "cancelled") return "cancelled";
  if (hiddenAt) return "rejected";
  if (approvalStatus === "approved") return "approved";
  return jobStatus;
}
