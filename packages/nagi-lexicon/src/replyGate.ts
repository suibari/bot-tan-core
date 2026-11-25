/** 投稿への直接の返信を受け付ける相手。省略（undefined）は誰でも。 */
export type ReplyGate = "bot" | "nobody";

export const isReplyGate = (value: unknown): value is ReplyGate =>
  value === "bot" || value === "nobody";

/**
 * 親投稿の replyGate のもとで、replierDid が直接返信できるか。投稿者本人は常に返信できる。
 * 未知の値は制限として解釈できないので、誰でも返信できる扱いにする。
 */
export function replyGateAllows(
  gate: unknown,
  parentDid: string,
  replierDid: string,
  botDid: string,
): boolean {
  if (replierDid === parentDid) return true;
  if (gate === "nobody") return false;
  if (gate === "bot") return replierDid === botDid;
  return true;
}
