import {
  TRILINES,
  isTrilinesDiarySharedToNagi,
  nagiPostFromTrilinesDiary,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "./validateRecord.js";

/**
 * 3行日記のコミットを、posts に載せる形へ置き換える。捨てるなら undefined。
 *
 * - Nagi への公開に同意していない日記（shareToNagi: true が無い）は delete として流す。
 *   取り込み済みの行があれば消え、無ければ何も起きない。あとから印を外した update もここで消える。
 * - 印はあるが壊れている日記は従来どおり捨てる（既存の行は残す）。
 */
export function trilinesCommit<T extends { operation: string; record?: any }>(
  commit: T,
): T | undefined {
  if (commit.operation === "delete") return commit;
  if (!isTrilinesDiarySharedToNagi(commit.record))
    return { ...commit, operation: "delete", record: undefined };
  if (!validateRecord(TRILINES.diary, commit.record)) return undefined;
  return { ...commit, record: nagiPostFromTrilinesDiary(commit.record) };
}
