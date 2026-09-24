/** Nagi の本人向けコメントで共通の ja/en 出力形式。 */
export interface BilingualComment {
  commentJa: string;
  commentEn: string;
}

export const BILINGUAL_COMMENT_INSTRUCTION =
  "同じ出来事・事実・気持ちを伝える日本語の commentJa と英語の commentEn を、1つのJSONで両方返してください。英語は自然な言い回しにし、翻訳時に新しい事実を足さないでください。各言語の指示は対応する欄だけに適用します。";

export const bilingualCommentFormat = {
  type: "object",
  properties: { commentJa: { type: "string" }, commentEn: { type: "string" } },
  required: ["commentJa", "commentEn"],
  additionalProperties: false,
};

export function normalizeBilingualComment(parsed: Partial<BilingualComment> | null): BilingualComment {
  const commentJa = typeof parsed?.commentJa === "string" ? parsed.commentJa.trim() : "";
  const commentEn = typeof parsed?.commentEn === "string" ? parsed.commentEn.trim() : "";
  return { commentJa, commentEn };
}

export function parseBilingualComment(response: string): BilingualComment {
  const result = normalizeBilingualComment(JSON.parse(response));
  if (!result.commentJa || !result.commentEn) throw new Error("Both commentJa and commentEn are required");
  return result;
}
