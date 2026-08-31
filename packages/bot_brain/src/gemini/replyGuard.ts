/**
 * 投稿直前の劣化チェック。
 *
 * 2026-08-31 に、返信本文が相手の表示名だけ（`Lisya Myata 🦊`）になった事故が起きた。
 * 直接の原因はコンテキスト予算（ollamaBudget.ts）で塞いだが、生成物そのものが劣化する
 * 経路は他にもありうるので、投稿の直前でもう一度見る。
 *
 * **誤検知すると返信が黙って消える**ので、硬い信号だけを見る。
 * 「短いだけ」では弾かない（`うんうん！` `そうだね` は正常な全肯定リプライ）。
 */

export class DegenerateReplyError extends Error {
  constructor(
    readonly reason: string,
    comment: string,
  ) {
    super(
      `Generated reply looks degenerate (${reason}): ${JSON.stringify(comment.slice(0, 80))}`,
    );
    this.name = "DegenerateReplyError";
  }
}

/**
 * 呼びかけ名との比較用の正規化。
 * **部分一致は絶対に使わない** —「〇〇さん、おはよう！」は正常な返信なので殺してはいけない。
 */
function normalizeForNameEcho(text: string): string {
  // 句読点 → 敬称 → 句読点 の順に落とす。敬称を先に見ると「〇〇さん、」が剥がれない。
  return text
    .trim()
    .replace(/[、。！？!?,.\s]+$/u, "")
    .replace(/(?:ちゃん|さん|くん|たん|様|氏)$/u, "")
    .replace(/[、。！？!?,.\s]+$/u, "")
    .trim();
}

function graphemeLength(text: string): number {
  return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].length;
}

/**
 * 投稿してよい本文か検査する。使えないと判断したら例外を投げる
 * （呼び出し側の再試行キューに乗せ、尽きたら定型文へ落とす）。
 */
export function assertUsableReply(
  comment: string,
  addressName: string | undefined,
  options: { truncated?: boolean } = {},
): void {
  if (!comment) throw new Error("Response text is empty");

  // 1. 相手の呼びかけ名をそのまま返しただけ。正常な出力としてまず有り得ない。
  const normalized = normalizeForNameEcho(comment);
  if (addressName && normalized && normalized === normalizeForNameEcho(addressName)) {
    throw new DegenerateReplyError("name echo", comment);
  }

  // 2. 出力枠に到達して切れた（truncated）うえに極端に短い。
  //    truncated との AND にしているのは、短い相づちを誤爆させないため。
  if (options.truncated && graphemeLength(comment) < 5) {
    throw new DegenerateReplyError("truncated and too short", comment);
  }
}
