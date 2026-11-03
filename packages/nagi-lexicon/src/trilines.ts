import { NAGI, TRILINES } from "./constants.js";

/** 投稿形へ射影した日記の行。画像は embed.images の添字で指す。 */
export type TrilinesLineView = { text: string; imageIndex?: number };

/**
 * Nagi への公開に同意した日記か。TriLinesAt から書いた日記は投稿画面の「Nagi」を ON にしたときだけ、
 * Nagi から書いた日記は常に shareToNagi: true が付く。印の無い日記は Nagi に出さず、botたんも返信しない。
 */
export function isTrilinesDiarySharedToNagi(value: any): boolean {
  return value?.shareToNagi === true;
}

const isBlob = (value: any): boolean =>
  !!value && typeof value === "object" && value.$type === "blob";

/**
 * TriLinesAt の3行日記を、表示・モデレーション・検索で使う Nagi 投稿形へ射影する。
 * PDS 上の正本と URI は com.suibari.trilinesat.diary のまま維持する。
 *
 * - text は行を改行でつないだもの（検索・翻訳・モデレーションがそのまま読める）
 * - 行ごとの画像は embed.images にまとめ、行からは imageIndex で指す
 * - botSilent は付けない。botたんは通常の投稿と同じく日記にも全肯定で返信する
 * - shareToNagi: true の無い日記は undefined（Nagi に公開しない）
 */
export function nagiPostFromTrilinesDiary(value: any): any | undefined {
  if (
    !value ||
    value.$type !== TRILINES.diary ||
    !isTrilinesDiarySharedToNagi(value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 3
  )
    return undefined;

  const lines: TrilinesLineView[] = [];
  const images: { image: unknown; alt: string }[] = [];
  for (const line of value.lines) {
    if (!line || typeof line !== "object" || typeof line.text !== "string")
      return undefined;
    if (line.alt !== undefined && typeof line.alt !== "string") return undefined;
    const view: TrilinesLineView = { text: line.text };
    if (line.image !== undefined) {
      if (!isBlob(line.image)) return undefined;
      view.imageIndex = images.length;
      images.push({ image: line.image, alt: line.alt ?? "" });
    }
    lines.push(view);
  }
  if (!lines.some((line) => line.text.trim())) return undefined;

  const langs = Array.isArray(value.langs)
    ? value.langs.filter((lang: unknown) => typeof lang === "string")
    : undefined;

  return {
    $type: NAGI.post,
    text: lines.map((line) => line.text).join("\n"),
    createdAt: value.createdAt,
    langs: langs?.length ? langs : undefined,
    embed: images.length
      ? { $type: `${NAGI.post}#images`, images }
      : undefined,
    trilines: { lines },
  };
}
