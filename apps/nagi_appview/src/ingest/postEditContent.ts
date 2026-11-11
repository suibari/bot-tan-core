/**
 * 投稿の更新を「編集」とみなすかの判定。cid の変化ではなく、利用者に見える内容の差分で決める。
 * 付帯情報（クロスポスト参照など）だけの更新では、編集済み表示・翻訳・判定をやり直さない。
 *
 * lexicon の全フィールドをどちらかに分類する（test/postEditContent.test.ts が漏れを検出する）。
 * 未知のフィールドは内容として扱い、分類漏れは「編集扱い」側に倒す。
 */
export const POST_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "$type",
  "crosspost",
]);

export const POST_CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "text",
  "facets",
  "langs",
  "labels",
  "createdAt",
  "cwRestricted",
  "kossori",
  "botSilent",
  "silentReply",
  "channel",
  "reply",
  "linkCards",
  "embed",
]);

/** jsonb はキー順を保たないので、キーを整列した文字列で比べる。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function contentOf(record: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record))
    if (!POST_METADATA_FIELDS.has(key)) content[key] = value;
  return canonical(content);
}

/**
 * 直前に取り込んだレコードと比べて、見える内容が変わったか。
 * 直前のレコードが読めない旧行では比べられないので、変わったものとして扱う。
 */
export function hasPostContentChange(previous: unknown, next: unknown): boolean {
  if (!previous || typeof previous !== "object") return true;
  if (!next || typeof next !== "object") return true;
  return (
    contentOf(previous as Record<string, unknown>) !==
    contentOf(next as Record<string, unknown>)
  );
}
