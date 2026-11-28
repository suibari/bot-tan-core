import { createHash } from "node:crypto";
import type { MuteSubjectType } from "@bsky-affirmative-bot/nagi-lexicon";

/**
 * 非公開 space のレコードキー。同じ対象は必ず同じレコードになるよう、対象から決める。
 *
 * TID にすると、同じ相手のミュートが端末ごとに別レコードで二重にでき、解除するにも
 * 一覧を引いて rkey を探す必要が出る。対象をそのまま rkey にしないのは、record-key に
 * 使えない文字（ハッシュタグの日本語、did:web の %3A など）があるため。
 *
 * 形は「種別 + U+0000 + 対象」の UTF-8 を SHA-256 にかけた小文字16進（64文字）。
 * クライアントも同じ計算をするので、変えるときは lexicon の説明とクライアントを同時に直すこと。
 */
const digest = (kind: string, subject: string) =>
  createHash("sha256").update(`${kind}\u0000${subject}`, "utf8").digest("hex");

/** subject は正規化済み（actor は DID、tag は # なし小文字）であること。 */
export const muteRkey = (subjectType: MuteSubjectType, subject: string) =>
  digest(subjectType, subject);
export const listMemberRkey = (memberDid: string) =>
  digest("listMember", memberDid);
export const bookmarkRkey = (subjectUri: string) =>
  digest("bookmark", subjectUri);

/** 1人1件の設定レコード。 */
export const SELF_RKEY = "self";
