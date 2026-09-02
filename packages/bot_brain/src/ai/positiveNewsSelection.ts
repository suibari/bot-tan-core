import type { PositiveNewsCandidate } from "../api/newsdata/index.js";

export interface SanitizedNewsSelection {
  structure: Record<string, unknown>;
  selectedNewsArticleId?: string;
  selectedNewsUrl?: string;
}

function isNoneValue(value: string) {
  return /^(none|なし|該当なし)$/i.test(value.trim());
}

function validArticleUrl(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return;
  }
}

/**
 * Geminiが返した記事IDを候補一覧と照合し、内部IDが最終文章へ漏れない形に整える。
 */
export function sanitizePositiveNewsSelection(
  rawStructure: unknown,
  candidates: PositiveNewsCandidate[],
): SanitizedNewsSelection {
  const source = rawStructure && typeof rawStructure === "object"
    ? rawStructure as Record<string, unknown>
    : {};
  const structure = { ...source };
  const requestedId = typeof structure.positiveNewsArticleId === "string"
    ? structure.positiveNewsArticleId.trim()
    : "";
  const positiveNews = typeof structure.positiveNews === "string"
    ? structure.positiveNews.trim()
    : "";
  delete structure.positiveNewsArticleId;

  const selected = candidates.find((candidate) => candidate.articleId === requestedId);
  if (!selected || !positiveNews || isNoneValue(positiveNews)) {
    structure.positiveNews = "None";
    return { structure };
  }

  structure.positiveNews = positiveNews;
  const selectedNewsUrl = validArticleUrl(selected.link);
  return {
    structure,
    selectedNewsArticleId: selected.articleId,
    ...(selectedNewsUrl ? { selectedNewsUrl } : {}),
  };
}
