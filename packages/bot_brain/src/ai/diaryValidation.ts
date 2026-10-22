/** 安定した集計キー。本文や抜粋の内容をログへ出さない。 */
export type DiaryFailureReason =
  | "invalid_json"
  | "invalid_shape"
  | "paragraph_reference"
  | "paragraphs"
  | "title"
  | "context_id"
  | "excerpt_type"
  | "excerpt_short"
  | "excerpt_mismatch"
  | "empty";

export class DiaryValidationError extends Error {
  constructor(
    readonly reason: DiaryFailureReason,
    message: string,
    readonly diagnostics: Record<string, number | boolean> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiaryValidationError";
  }
}

/** 診断専用。正規化して一致しても、生成結果の採否は変えない。 */
export function excerptDiagnostics(value: unknown, diary: string): Record<string, number | boolean> {
  const excerpt = typeof value === "string" ? value.trim() : "";
  const withoutWhitespace = (text: string) => text.replace(/\s/gu, "");
  const compactExcerpt = withoutWhitespace(excerpt);
  return {
    diary_chars: [...diary].length,
    excerpt_chars: [...excerpt].length,
    whitespace_match: compactExcerpt.length > 0 && withoutWhitespace(diary).includes(compactExcerpt),
    nfc_match: excerpt.length > 0 && diary.normalize("NFC").includes(excerpt.normalize("NFC")),
  };
}
